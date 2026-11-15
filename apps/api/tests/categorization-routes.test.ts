import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Fastify from 'fastify';

import { db } from '../src/db.js';
import { routes } from '../src/routes/index.js';
import { appendDecision } from '../src/rules.js';
import { resetDb } from './setup/resetDb.js';

const app = Fastify();
await app.register(routes);
after(() => app.close());

beforeEach(() => resetDb());

const categoryId = (name: string) =>
  (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string }).id;
const roleId = (role: string) => (db.prepare('SELECT id FROM categories WHERE role = ?').get(role) as { id: string }).id;
const latestCategory = (txId: string) =>
  (
    db
      .prepare('SELECT category_id FROM categorization_decisions WHERE transaction_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(txId) as { category_id: string }
  ).category_id;

function mkTx(counterparty: string) {
  const now = new Date().toISOString();
  const account = crypto.randomUUID();
  const session = crypto.randomUUID();
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, type) VALUES (?, ?, ?, ?)').run(account, now, 'Testitili', 'bank');
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format) VALUES (?, ?, ?, ?)').run(session, now, 'Test', 'CSV');
  db.prepare(
    `INSERT INTO normalized_transactions (id, created_at, import_session_id, account_id, booking_date, amount, currency, counterparty_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, now, session, account, '2026-11-01', -10, 'EUR', counterparty);
  appendDecision({ transactionId: id, categoryId: roleId('fallback'), source: 'rule' });
  return id;
}

const HERMES = { 'x-finance-actor': 'hermes' };
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers });

test('POST /categorization/plan and /apply: plan, apply with the token, the actor from the header', async () => {
  const tx = mkTx('Lautapelikahvila Noppa');
  const op = { kind: 'recategorize', transactionIds: [tx], categoryId: categoryId('Viihde ja harrastukset'), reason: 'peli-ilta' };
  const planned = await post('/categorization/plan', { op }, HERMES);
  assert.equal(planned.statusCode, 200, planned.body);
  const plan = planned.json();
  assert.equal(plan.rowsTotal, 1);
  assert.equal(latestCategory(tx), roleId('fallback'));

  const applied = await post('/categorization/apply', { op, planToken: plan.planToken }, HERMES);
  assert.equal(applied.statusCode, 200, applied.body);
  const set = applied.json();
  assert.deepEqual([set.kind, set.actor, set.reason, set.status], ['recategorize', 'hermes', 'peli-ilta', 'applied']);
  assert.equal(latestCategory(tx), categoryId('Viihde ja harrastukset'));

  const again = await post('/categorization/apply', { op, planToken: plan.planToken }, HERMES);
  assert.equal(again.json().id, set.id);

  const stale = await post('/categorization/apply', { op: { ...op, categoryId: categoryId('Vakuutukset') }, planToken: plan.planToken });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, 'plan_stale');
});

test('POST /categorization/plan validates the operation', async () => {
  const bad = await post('/categorization/plan', { op: { kind: 'recategorize', transactionIds: [], categoryId: 'x' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid_request');
  const unknownKind = await post('/categorization/plan', { op: { kind: 'delete_everything' } });
  assert.equal(unknownKind.statusCode, 400);
  const unknownTx = await post('/categorization/plan', {
    op: { kind: 'recategorize', transactionIds: ['nope'], categoryId: categoryId('Vakuutukset') },
  });
  assert.equal(unknownTx.statusCode, 400);
  assert.deepEqual(unknownTx.json(), { error: 'unknown_transactions', details: { transactionIds: ['nope'] } });
  const role = await post('/categorization/plan', { op: { kind: 'archive_category', categoryId: roleId('fallback') } });
  assert.equal(role.statusCode, 400);
  assert.equal(role.json().error, 'category_has_role');
  const badToken = await post('/categorization/apply', { op: { kind: 'create_category', name: 'Uusi' }, planToken: 'abc' });
  assert.equal(badToken.statusCode, 400);
});

test('GET /categorization/change-sets lists newest first; GET /:id shows one; undo via apply', async () => {
  const created = await post('/categories', { name: 'Lemmikit' }, HERMES);
  assert.equal(created.statusCode, 200);
  const renamed = await app.inject({ method: 'PATCH', url: `/categories/${created.json().id}`, payload: { name: 'Lemmikit ja eläimet' } });
  assert.equal(renamed.statusCode, 200);

  const list = await app.inject({ method: 'GET', url: '/categorization/change-sets?limit=10' });
  assert.equal(list.statusCode, 200);
  const body = list.json();
  assert.equal(body.total, 2);
  assert.deepEqual(body.items.map((s: { kind: string; actor: string }) => [s.kind, s.actor]), [
    ['rename_category', 'user'],
    ['create_category', 'hermes'],
  ]);
  assert.equal((await app.inject({ method: 'GET', url: '/categorization/change-sets?limit=0' })).statusCode, 400);

  const renameId = body.items[0].id;
  const one = await app.inject({ method: 'GET', url: `/categorization/change-sets/${renameId}` });
  assert.equal(one.statusCode, 200);
  assert.deepEqual(one.json().categories, [{ id: created.json().id, change: 'renamed', name: 'Lemmikit ja eläimet', fromName: 'Lemmikit' }]);
  const missing = await app.inject({ method: 'GET', url: '/categorization/change-sets/nope' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, 'change_set_not_found');

  const undoOp = { kind: 'undo', changeSetId: renameId };
  const undoPlan = (await post('/categorization/plan', { op: undoOp })).json();
  const undo = await post('/categorization/apply', { op: undoOp, planToken: undoPlan.planToken });
  assert.equal(undo.statusCode, 200);
  assert.equal(undo.json().undoOfId, renameId);
  const twice = await post('/categorization/plan', { op: undoOp });
  assert.equal(twice.statusCode, 409);
  assert.equal(twice.json().error, 'already_undone');
  const ofUndo = await post('/categorization/plan', { op: { kind: 'undo', changeSetId: undo.json().id } });
  assert.equal(ofUndo.statusCode, 409);
  assert.equal(ofUndo.json().error, 'cannot_undo_undo');
});

test('GET /categorization/rules lists enabled rules in match order; disabled ones on request', async () => {
  const applyOp = async (op: object) => {
    const planned = (await post('/categorization/plan', { op }, HERMES)).json();
    const applied = await post('/categorization/apply', { op, planToken: planned.planToken }, HERMES);
    assert.equal(applied.statusCode, 200, applied.body);
    return applied.json();
  };
  const fun = categoryId('Viihde ja harrastukset');
  const created = await applyOp({ kind: 'create_rule', pattern: 'Lautapeli', matchField: 'counterparty', categoryId: fun });
  const ruleId = created.rules[0].id as string;
  await applyOp({ kind: 'create_rule', pattern: 'elokuvateatteri', matchField: 'description', categoryId: fun });

  const res = await app.inject({ method: 'GET', url: '/categorization/rules' });
  assert.equal(res.statusCode, 200, res.body);
  const rules = res.json() as Array<Record<string, unknown>>;
  const mine = rules.find((r) => r.id === ruleId);
  assert.deepEqual(mine, {
    id: ruleId,
    categoryId: fun,
    categoryName: 'Viihde ja harrastukset',
    pattern: 'lautapeli',
    matchField: 'counterparty',
    matchType: 'contains',
    amountSign: null,
    builtin: false,
    disabledAt: null,
    priority: 10,
    createdAt: mine?.createdAt,
    actor: 'hermes',
  });
  assert.ok(rules.some((r) => r.builtin === true), 'built-in rules are listed too');
  const priorities = rules.map((r) => r.priority as number);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a), 'match order: highest priority first');
  assert.equal(rules[0].pattern, 'elokuvateatteri', 'newest first within a priority');

  await applyOp({ kind: 'disable_rule', ruleId });
  const enabled = (await app.inject({ method: 'GET', url: '/categorization/rules' })).json() as Array<{ id: string }>;
  assert.equal(enabled.some((r) => r.id === ruleId), false);
  const all = (await app.inject({ method: 'GET', url: '/categorization/rules?includeDisabled=true' })).json() as Array<{
    id: string;
    disabledAt: string | null;
  }>;
  assert.ok(all.find((r) => r.id === ruleId)?.disabledAt);
  assert.equal((await app.inject({ method: 'GET', url: '/categorization/rules?includeDisabled=yes' })).statusCode, 400);
});

test('the existing category endpoints record change sets', async () => {
  const created = (await post('/categories', { name: 'Arkistoon' }, HERMES)).json();
  const tx = mkTx('Rautakauppa Ruuvi');
  const pick = await post(`/transactions/${tx}/category`, { categoryId: created.id }, HERMES);
  assert.equal(pick.statusCode, 200);
  assert.deepEqual(pick.json(), { ok: true });
  const archived = await app.inject({ method: 'DELETE', url: `/categories/${created.id}`, headers: HERMES });
  assert.deepEqual(archived.json(), { ok: true, reassignedTo: roleId('fallback') });

  const sets = db.prepare('SELECT kind, actor FROM change_sets ORDER BY rowid').all().map((r) => ({ ...r }));
  assert.deepEqual(sets, [
    { kind: 'create_category', actor: 'hermes' },
    { kind: 'recategorize', actor: 'hermes' },
    { kind: 'archive_category', actor: 'hermes' },
  ]);
  const decisions = db
    .prepare('SELECT d.source, s.kind FROM categorization_decisions d JOIN change_sets s ON s.id = d.change_set_id WHERE d.transaction_id = ? ORDER BY d.rowid')
    .all(tx)
    .map((r) => ({ ...r }));
  assert.deepEqual(decisions, [
    { source: 'user', kind: 'recategorize' },
    { source: 'category_archived', kind: 'archive_category' },
  ]);
});

test('POST /transactions/:id/category: the learned rule belongs to the set, and undo disables it', async () => {
  const tx = mkTx('Kukkakauppa Ruusu');
  const fun = categoryId('Viihde ja harrastukset');
  await post(`/transactions/${tx}/category`, { categoryId: fun });
  const rule = db.prepare("SELECT id, change_set_id FROM category_rules WHERE pattern = 'kukkakauppa ruusu'").get() as {
    id: string;
    change_set_id: string;
  };
  assert.ok(rule.change_set_id);
  const set = (await app.inject({ method: 'GET', url: `/categorization/change-sets/${rule.change_set_id}` })).json();
  assert.deepEqual(set.rules.map((r: { id: string; change: string }) => [r.id, r.change]), [[rule.id, 'created']]);

  const undoOp = { kind: 'undo', changeSetId: set.id };
  const plan = (await post('/categorization/plan', { op: undoOp })).json();
  assert.equal((await post('/categorization/apply', { op: undoOp, planToken: plan.planToken })).statusCode, 200);
  assert.equal(latestCategory(tx), roleId('fallback'));
  assert.ok((db.prepare('SELECT disabled_at FROM category_rules WHERE id = ?').get(rule.id) as { disabled_at: string }).disabled_at);
});

test('POST /transactions/:id/category confirming a rule-made category makes it manual', async () => {
  const tx = mkTx('Kauppahalli');
  await post(`/transactions/${tx}/category`, { categoryId: roleId('fallback') });
  const latest = db
    .prepare('SELECT source FROM categorization_decisions WHERE transaction_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(tx) as { source: string };
  assert.equal(latest.source, 'user');
});

test('POST /transactions/:id/category answers 404 for an unknown transaction or category', async () => {
  const tx = mkTx('Kauppa');
  const noTx = await post('/transactions/nope/category', { categoryId: categoryId('Vakuutukset') });
  assert.equal(noTx.statusCode, 404);
  assert.deepEqual(noTx.json(), { error: 'not_found' });
  const noCategory = await post(`/transactions/${tx}/category`, { categoryId: 'nope' });
  assert.equal(noCategory.statusCode, 404);
});
