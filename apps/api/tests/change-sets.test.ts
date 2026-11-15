import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { ZodError } from 'zod';

import { db } from '../src/db.js';
import { apply, applyNow, getChangeSet, listChangeSets, plan } from '../src/categorization.js';
import { DomainError } from '../src/http/errors.js';
import { appendDecision } from '../src/rules.js';
import { resetDb } from './setup/resetDb.js';

// Change sets: every categorization change is planned, applied with the plan's
// token and undoable as a whole (docs/CATEGORIES.md, "Operations").

beforeEach(() => resetDb());

const categoryId = (name: string) =>
  (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string }).id;
const roleId = (role: string) => (db.prepare('SELECT id FROM categories WHERE role = ?').get(role) as { id: string }).id;
const FOOD = () => categoryId('Ruoka ja päivittäistavarat');
const FUN = () => categoryId('Viihde ja harrastukset');
const INSURANCE = () => categoryId('Vakuutukset');

type Decision = { id: string; category_id: string; source: string; actor: string | null; reason: string | null; change_set_id: string | null; rule_id: string | null };
const latest = (txId: string) =>
  ({
    ...(db
      .prepare(
        `SELECT id, category_id, source, actor, reason, change_set_id, rule_id FROM categorization_decisions
         WHERE transaction_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get(txId) as object),
  }) as Decision;
const decisionCount = () => Number((db.prepare('SELECT COUNT(*) AS n FROM categorization_decisions').get() as { n: number }).n);
const changeSetCount = () => Number((db.prepare('SELECT COUNT(*) AS n FROM change_sets').get() as { n: number }).n);
const category = (id: string) =>
  ({ ...(db.prepare('SELECT name, role, archived_at, merged_into_id FROM categories WHERE id = ?').get(id) as object) }) as {
    name: string;
    role: string | null;
    archived_at: string | null;
    merged_into_id: string | null;
  };
const rule = (id: string) =>
  ({
    ...(db
      .prepare('SELECT category_id, pattern, match_field, priority, actor, disabled_at, change_set_id FROM category_rules WHERE id = ?')
      .get(id) as object),
  }) as { category_id: string; pattern: string; match_field: string; priority: number; actor: string | null; disabled_at: string | null; change_set_id: string | null };

let accountId = '';
function mkTx(counterparty: string, options: { description?: string; categoryId?: string; source?: string } = {}) {
  const now = new Date().toISOString();
  if (!accountId) {
    accountId = crypto.randomUUID();
  }
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(accountId)) {
    db.prepare('INSERT INTO accounts (id, created_at, name, type) VALUES (?, ?, ?, ?)').run(accountId, now, 'Testitili', 'bank');
  }
  const session = crypto.randomUUID();
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format) VALUES (?, ?, ?, ?)').run(session, now, 'Test', 'CSV');
  db.prepare(
    `INSERT INTO normalized_transactions (id, created_at, import_session_id, account_id, booking_date, amount, currency, counterparty_name, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, now, session, accountId, '2026-11-01', -10, 'EUR', counterparty, options.description ?? null);
  appendDecision({ transactionId: id, categoryId: options.categoryId ?? roleId('fallback'), source: options.source ?? 'rule' });
  return id;
}

function rejects(fn: () => unknown, code: string, status: number) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof DomainError, `expected DomainError ${code}, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.statusCode, status);
    return true;
  });
}

test('recategorize: plan writes nothing, apply writes manual decisions recorded in one change set', () => {
  const a = mkTx('Elokuvateatteri Tähti');
  const b = mkTx('Keilahalli Kaato');
  const already = mkTx('Pelikauppa Nappi', { categoryId: FUN(), source: 'user' });
  const before = decisionCount();
  const op = { kind: 'recategorize', transactionIds: [a, b, already], categoryId: FUN(), reason: 'vapaa-aika' };

  const p = plan(op, 'hermes');
  assert.equal(p.kind, 'recategorize');
  assert.match(p.planToken, /^[0-9a-f]{64}$/);
  assert.equal(p.rowsTotal, 2);
  assert.deepEqual(
    p.rows.map((r) => r.transactionId).sort(),
    [a, b].sort()
  );
  assert.ok(p.rows.every((r) => r.fromCategoryId === roleId('fallback') && r.toCategoryId === FUN()));
  assert.deepEqual(p.summary, { rowsChanged: 2, categoriesChanged: 0, rulesChanged: 0, exceptions: 0 });
  assert.equal(decisionCount(), before);
  assert.equal(changeSetCount(), 0);

  const rulesBefore = Number((db.prepare('SELECT COUNT(*) AS n FROM category_rules').get() as { n: number }).n);
  const set = apply(op, p.planToken, 'hermes');
  assert.equal(set.kind, 'recategorize');
  assert.equal(set.actor, 'hermes');
  assert.equal(set.reason, 'vapaa-aika');
  assert.equal(set.status, 'applied');
  assert.equal(set.rowsTotal, 2);
  for (const tx of [a, b]) {
    const d = latest(tx);
    assert.deepEqual(
      { category_id: d.category_id, source: d.source, actor: d.actor, reason: d.reason, change_set_id: d.change_set_id },
      { category_id: FUN(), source: 'user', actor: 'hermes', reason: 'vapaa-aika', change_set_id: set.id }
    );
  }
  assert.equal(latest(already).change_set_id, null);
  // recategorize never creates rules
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM category_rules').get() as { n: number }).n), rulesBefore);
});

test('apply is idempotent per token and refuses a stale plan with 409 plan_stale', () => {
  const a = mkTx('Kirjakauppa Sivu');
  const op = { kind: 'recategorize', transactionIds: [a], categoryId: FUN() };
  const p = plan(op, 'user');
  const first = apply(op, p.planToken, 'user');
  const decisions = decisionCount();
  const again = apply(op, p.planToken, 'user');
  assert.equal(again.id, first.id);
  assert.equal(decisionCount(), decisions);
  assert.equal(changeSetCount(), 1);

  const b = mkTx('Kirjakauppa Sivu 2');
  const stale = plan({ kind: 'recategorize', transactionIds: [b], categoryId: FOOD() }, 'user');
  appendDecision({ transactionId: b, categoryId: INSURANCE(), source: 'user' });
  rejects(() => apply({ kind: 'recategorize', transactionIds: [b], categoryId: FOOD() }, stale.planToken, 'user'), 'plan_stale', 409);
  // A token for a different operation is stale too.
  rejects(() => apply({ kind: 'recategorize', transactionIds: [b], categoryId: FUN() }, stale.planToken, 'user'), 'plan_stale', 409);
});

test('the plan token does not depend on id order but does on the category state', () => {
  const a = mkTx('Kahvila Papu');
  const b = mkTx('Kahvila Kuppi');
  const t1 = plan({ kind: 'recategorize', transactionIds: [a, b], categoryId: FOOD() }, 'user').planToken;
  const t2 = plan({ kind: 'recategorize', transactionIds: [b, a], categoryId: FOOD() }, 'user').planToken;
  assert.equal(t1, t2);
  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run('Ruokaostokset', FOOD());
  assert.notEqual(plan({ kind: 'recategorize', transactionIds: [a, b], categoryId: categoryId('Ruokaostokset') }, 'user').planToken, t1);
});

test('recategorize validates its ids and target', () => {
  const a = mkTx('Kioski Kulma');
  rejects(() => plan({ kind: 'recategorize', transactionIds: [a, 'no-such-tx'], categoryId: FOOD() }, 'user'), 'unknown_transactions', 400);
  assert.throws(() => plan({ kind: 'recategorize', transactionIds: [a, a], categoryId: FOOD() }, 'user'), ZodError);
  assert.throws(() => plan({ kind: 'recategorize', transactionIds: [], categoryId: FOOD() }, 'user'), ZodError);
  const tooMany = Array.from({ length: 501 }, (_, i) => `tx-${i}`);
  assert.throws(() => plan({ kind: 'recategorize', transactionIds: tooMany, categoryId: FOOD() }, 'user'), ZodError);
  rejects(() => plan({ kind: 'recategorize', transactionIds: [a], categoryId: 'nope' }, 'user'), 'category_not_found', 404);
  const old = applyNow({ kind: 'create_category', name: 'Vanha luokka' }, 'user').categories[0].id!;
  applyNow({ kind: 'archive_category', categoryId: old }, 'user');
  rejects(() => plan({ kind: 'recategorize', transactionIds: [a], categoryId: old }, 'user'), 'category_archived', 400);
});

test('plan lists at most 200 rows but counts them all', () => {
  const ids = Array.from({ length: 230 }, (_, i) => mkTx(`Puoti ${i}`));
  const p = plan({ kind: 'recategorize', transactionIds: ids, categoryId: FOOD() }, 'user');
  assert.equal(p.rows.length, 200);
  assert.equal(p.rowsTotal, 230);
  assert.equal(p.summary.rowsChanged, 230);
});

test('create_rule: manual beats rule, other matches move, the rule is traceable to the set', () => {
  const byRule = mkTx('Uimahalli Laine');
  const byDescription = mkTx('Kaupunki', { description: 'UIMAHALLI kertamaksu' });
  const manual = mkTx('Uimahalli Laine', { categoryId: INSURANCE(), source: 'user' });
  const inTarget = mkTx('Uimahalli Laine', { categoryId: FUN(), source: 'rule' });
  const other = mkTx('Kenkäkauppa Askel');
  const op = { kind: 'create_rule', pattern: '  UimaHalli ', matchField: 'counterparty', categoryId: FUN() };

  const p = plan(op, 'hermes');
  assert.deepEqual(p.rows.map((r) => r.transactionId), [byRule]);
  assert.deepEqual(p.exceptions, [{ transactionId: manual, reason: 'manual_decision' }]);
  assert.equal(p.rules.length, 1);
  assert.deepEqual(p.rules[0], { id: null, change: 'created', categoryId: FUN(), pattern: 'uimahalli', matchField: 'counterparty' });

  const set = apply(op, p.planToken, 'hermes');
  const ruleId = set.rules[0].id!;
  assert.deepEqual(
    { ...rule(ruleId), disabled_at: null },
    { category_id: FUN(), pattern: 'uimahalli', match_field: 'counterparty', priority: 10, actor: 'hermes', disabled_at: null, change_set_id: set.id }
  );
  const moved = latest(byRule);
  assert.deepEqual(
    { category_id: moved.category_id, source: moved.source, rule_id: moved.rule_id, change_set_id: moved.change_set_id, actor: moved.actor },
    { category_id: FUN(), source: 'rule', rule_id: ruleId, change_set_id: set.id, actor: 'hermes' }
  );
  assert.equal(latest(manual).category_id, INSURANCE());
  assert.equal(latest(byDescription).category_id, roleId('fallback'));
  assert.equal(latest(inTarget).change_set_id, null);
  assert.equal(latest(other).category_id, roleId('fallback'));
  assert.equal(set.exceptions.length, 1);

  // The same enabled rule cannot be created twice.
  rejects(() => plan(op, 'hermes'), 'rule_exists', 409);
  assert.throws(() => plan({ ...op, pattern: 'ui' }, 'hermes'), ZodError);
});

test('a manual decision restored by undo still beats a new rule', () => {
  const tx = mkTx('Pyöräkorjaamo Ketju', { categoryId: INSURANCE(), source: 'user' });
  const set = applyNow({ kind: 'recategorize', transactionIds: [tx], categoryId: FUN() }, 'hermes');
  applyNow({ kind: 'undo', changeSetId: set.id }, 'user');
  assert.equal(latest(tx).source, 'undo');
  const p = plan({ kind: 'create_rule', pattern: 'pyöräkorjaamo', matchField: 'counterparty', categoryId: FOOD() }, 'user');
  assert.deepEqual(p.exceptions, [{ transactionId: tx, reason: 'manual_decision' }]);
  assert.equal(p.rowsTotal, 0);

  // A rule decision restored by undo is not manual.
  const ruled = mkTx('Pyöräkorjaamo Ketju');
  const second = applyNow({ kind: 'recategorize', transactionIds: [ruled], categoryId: FUN() }, 'hermes');
  applyNow({ kind: 'undo', changeSetId: second.id }, 'user');
  const p2 = plan({ kind: 'create_rule', pattern: 'pyöräkorjaamo', matchField: 'counterparty', categoryId: FOOD() }, 'user');
  assert.deepEqual(p2.rows.map((r) => r.transactionId), [ruled]);
});

test('create_rule on the description field matches case-insensitively', () => {
  const tx = mkTx('Kaupunki', { description: 'UIMAHALLI kertamaksu' });
  const set = applyNow({ kind: 'create_rule', pattern: 'uimahalli', matchField: 'description', categoryId: FUN() }, 'user');
  assert.equal(set.rowsTotal, 1);
  assert.equal(latest(tx).category_id, FUN());
});

test('undo reverts a recategorize, leaving rows changed since and reporting them', () => {
  const a = mkTx('Teatteri Valo');
  const b = mkTx('Teatteri Varjo');
  const set = applyNow({ kind: 'recategorize', transactionIds: [a, b], categoryId: FUN() }, 'hermes');
  appendDecision({ transactionId: b, categoryId: INSURANCE(), source: 'user' });

  const p = plan({ kind: 'undo', changeSetId: set.id }, 'user');
  assert.deepEqual(p.rows, [{ transactionId: a, fromCategoryId: FUN(), toCategoryId: roleId('fallback') }]);
  assert.deepEqual(p.exceptions, [{ transactionId: b, reason: 'changed_since' }]);

  const undo = apply({ kind: 'undo', changeSetId: set.id }, p.planToken, 'user');
  assert.equal(undo.kind, 'undo');
  assert.equal(undo.undoOfId, set.id);
  const d = latest(a);
  assert.deepEqual({ category_id: d.category_id, source: d.source, change_set_id: d.change_set_id }, {
    category_id: roleId('fallback'),
    source: 'undo',
    change_set_id: undo.id,
  });
  assert.equal(latest(b).category_id, INSURANCE());
  const original = getChangeSet(set.id);
  assert.equal(original.status, 'undone');
  assert.equal(original.undoneById, undo.id);

  rejects(() => plan({ kind: 'undo', changeSetId: set.id }, 'user'), 'already_undone', 409);
  rejects(() => plan({ kind: 'undo', changeSetId: undo.id }, 'user'), 'cannot_undo_undo', 409);
  rejects(() => plan({ kind: 'undo', changeSetId: 'nope' }, 'user'), 'change_set_not_found', 404);
});

test('create_category and its undo: the category is archived and its rows move to fallback', () => {
  const set = applyNow({ kind: 'create_category', name: 'Lemmikit' }, 'hermes');
  assert.equal(set.categories[0].change, 'created');
  const pets = set.categories[0].id!;
  assert.equal(category(pets).name, 'Lemmikit');
  rejects(() => plan({ kind: 'create_category', name: ' Lemmikit ' }, 'user'), 'name_exists', 400);

  const tx = mkTx('Eläinkauppa Tassu');
  applyNow({ kind: 'recategorize', transactionIds: [tx], categoryId: pets }, 'user');
  const undo = applyNow({ kind: 'undo', changeSetId: set.id }, 'user');
  assert.ok(category(pets).archived_at);
  assert.equal(latest(tx).category_id, roleId('fallback'));
  assert.equal(latest(tx).change_set_id, undo.id);
});

test('rename_category keeps id and role; undo restores the old name only when it is free', () => {
  const fallback = roleId('fallback');
  const set = applyNow({ kind: 'rename_category', categoryId: fallback, name: 'Sekalaiset' }, 'user');
  assert.deepEqual(set.categories, [{ id: fallback, change: 'renamed', name: 'Sekalaiset', fromName: 'Muut ja epäselvät' }]);
  assert.equal(category(fallback).role, 'fallback');
  applyNow({ kind: 'undo', changeSetId: set.id }, 'user');
  assert.equal(category(fallback).name, 'Muut ja epäselvät');

  const food = FOOD();
  const second = applyNow({ kind: 'rename_category', categoryId: food, name: 'Ruokaostokset' }, 'user');
  applyNow({ kind: 'create_category', name: 'Ruoka ja päivittäistavarat' }, 'user');
  const undo = applyNow({ kind: 'undo', changeSetId: second.id }, 'user');
  assert.deepEqual(undo.exceptions, [{ categoryId: food, reason: 'name_taken' }]);
  assert.equal(category(food).name, 'Ruokaostokset');

  rejects(() => plan({ kind: 'rename_category', categoryId: 'nope', name: 'X' }, 'user'), 'category_not_found', 404);
  rejects(() => plan({ kind: 'rename_category', categoryId: food, name: 'Vakuutukset' }, 'user'), 'name_exists', 400);
});

test('re-planning a rename after its undo gives a new token, so it can be applied again', () => {
  const food = FOOD();
  const op = { kind: 'rename_category', categoryId: food, name: 'Ruokaostokset' } as const;
  const p1 = plan(op, 'user');
  const first = apply(op, p1.planToken, 'user');
  applyNow({ kind: 'undo', changeSetId: first.id }, 'user');
  const p2 = plan(op, 'user');
  assert.notEqual(p2.planToken, p1.planToken);
  const second = apply(op, p2.planToken, 'user');
  assert.notEqual(second.id, first.id);
  assert.equal(category(food).name, 'Ruokaostokset');
});

test('archive_category moves rows, disables rules; role categories are refused; undo brings it all back', () => {
  const hobby = applyNow({ kind: 'create_category', name: 'Harrastukset' }, 'user').categories[0].id!;
  const ruleSet = applyNow({ kind: 'create_rule', pattern: 'golfkenttä', matchField: 'counterparty', categoryId: hobby }, 'user');
  const ruleId = ruleSet.rules[0].id!;
  const tx = mkTx('Golfkenttä Viheriö', { categoryId: hobby, source: 'user' });
  const elsewhere = mkTx('Golfkenttä Viheriö', { categoryId: FOOD(), source: 'user' });

  rejects(() => plan({ kind: 'archive_category', categoryId: roleId('fallback') }, 'user'), 'category_has_role', 400);
  rejects(() => plan({ kind: 'archive_category', categoryId: hobby, moveTo: hobby }, 'user'), 'invalid_move_target', 400);
  rejects(() => plan({ kind: 'archive_category', categoryId: 'nope' }, 'user'), 'category_not_found', 404);

  const set = applyNow({ kind: 'archive_category', categoryId: hobby, moveTo: FUN() }, 'hermes');
  assert.deepEqual(set.categories, [{ id: hobby, change: 'archived', name: 'Harrastukset', movedTo: FUN() }]);
  assert.deepEqual(set.rules.map((r) => [r.id, r.change]), [[ruleId, 'disabled']]);
  assert.ok(category(hobby).archived_at);
  assert.ok(rule(ruleId).disabled_at);
  const moved = latest(tx);
  assert.deepEqual([moved.category_id, moved.source, moved.actor, moved.change_set_id], [FUN(), 'category_archived', 'hermes', set.id]);
  assert.equal(latest(elsewhere).category_id, FOOD());
  rejects(() => plan({ kind: 'archive_category', categoryId: hobby }, 'user'), 'category_archived', 400);

  applyNow({ kind: 'undo', changeSetId: set.id }, 'user');
  assert.equal(category(hobby).archived_at, null);
  assert.equal(rule(ruleId).disabled_at, null);
  assert.equal(latest(tx).category_id, hobby);
});

test('merge_categories archives from into into, re-creates its rules there; undo reverts it', () => {
  const from = applyNow({ kind: 'create_category', name: 'Kahvilat' }, 'user').categories[0].id!;
  const into = applyNow({ kind: 'create_category', name: 'Ravintolat' }, 'user').categories[0].id!;
  const fromRule = applyNow({ kind: 'create_rule', pattern: 'kahvila', matchField: 'counterparty', categoryId: from }, 'user').rules[0].id!;
  const tx = mkTx('Kahvila Papu', { categoryId: from, source: 'user' });

  rejects(() => plan({ kind: 'merge_categories', fromId: from, intoId: from }, 'user'), 'invalid_merge_target', 400);
  rejects(() => plan({ kind: 'merge_categories', fromId: roleId('income'), intoId: into }, 'user'), 'category_has_role', 400);

  const set = applyNow({ kind: 'merge_categories', fromId: from, intoId: into }, 'hermes');
  assert.deepEqual(set.categories, [{ id: from, change: 'merged', name: 'Kahvilat', intoId: into }]);
  assert.deepEqual(category(from).merged_into_id, into);
  assert.ok(category(from).archived_at);
  assert.equal(latest(tx).category_id, into);
  const created = set.rules.find((r) => r.change === 'created')!;
  assert.deepEqual(
    { category_id: rule(created.id!).category_id, pattern: rule(created.id!).pattern, change_set_id: rule(created.id!).change_set_id },
    { category_id: into, pattern: 'kahvila', change_set_id: set.id }
  );
  assert.ok(rule(fromRule).disabled_at);

  applyNow({ kind: 'undo', changeSetId: set.id }, 'user');
  assert.deepEqual([category(from).archived_at, category(from).merged_into_id], [null, null]);
  assert.equal(rule(fromRule).disabled_at, null);
  assert.ok(rule(created.id!).disabled_at);
  assert.equal(latest(tx).category_id, from);
});

test('disable_rule stops a rule without touching history; undo re-enables it', () => {
  const ruleId = applyNow({ kind: 'create_rule', pattern: 'lehtitilaus', matchField: 'counterparty', categoryId: FUN() }, 'user').rules[0].id!;
  const before = decisionCount();
  const set = applyNow({ kind: 'disable_rule', ruleId }, 'hermes');
  assert.equal(decisionCount(), before);
  assert.ok(rule(ruleId).disabled_at);
  rejects(() => plan({ kind: 'disable_rule', ruleId }, 'user'), 'rule_disabled', 409);
  rejects(() => plan({ kind: 'disable_rule', ruleId: 'nope' }, 'user'), 'rule_not_found', 404);
  applyNow({ kind: 'undo', changeSetId: set.id }, 'user');
  assert.equal(rule(ruleId).disabled_at, null);
});

test('undo of create_rule disables the rule and reverts the rows it moved', () => {
  const tx = mkTx('Kuntosali Voima');
  const set = applyNow({ kind: 'create_rule', pattern: 'kuntosali', matchField: 'counterparty', categoryId: FUN() }, 'user');
  assert.equal(latest(tx).category_id, FUN());
  applyNow({ kind: 'undo', changeSetId: set.id }, 'user');
  assert.ok(rule(set.rules[0].id!).disabled_at);
  assert.equal(latest(tx).category_id, roleId('fallback'));
});

test('change sets are listed newest first with actor, kind, reason, status and counts', () => {
  const tx = mkTx('Museo Aika');
  const first = applyNow({ kind: 'recategorize', transactionIds: [tx], categoryId: FUN(), reason: 'museokäynti' }, 'hermes');
  const second = applyNow({ kind: 'create_category', name: 'Kulttuuri' }, 'user');
  const list = listChangeSets({ limit: 10, offset: 0 });
  assert.equal(list.total, 2);
  assert.deepEqual(list.items.map((s) => s.id), [second.id, first.id]);
  const item = list.items[1];
  assert.deepEqual(
    { actor: item.actor, kind: item.kind, reason: item.reason, status: item.status, summary: item.summary },
    { actor: 'hermes', kind: 'recategorize', reason: 'museokäynti', status: 'applied', summary: { rowsChanged: 1, categoriesChanged: 0, rulesChanged: 0, exceptions: 0 } }
  );
  assert.equal(listChangeSets({ limit: 1, offset: 1 }).items[0].id, first.id);
  assert.deepEqual(getChangeSet(first.id).rows, [{ transactionId: tx, fromCategoryId: roleId('fallback'), toCategoryId: FUN() }]);
  rejects(() => getChangeSet('nope'), 'change_set_not_found', 404);
});

const MONEY_TABLES = [
  'normalized_transactions',
  'raw_transactions',
  'balance_snapshots',
  'balance_adjustments',
  'transfer_links',
  'accounts',
  'import_sessions',
];

function checksum(table: string) {
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

test('no operation, undo included, touches money: transactions, raw rows, balances, transfers, accounts', () => {
  const a = mkTx('Huoltoasema Tankki');
  const b = mkTx('Huoltoasema Tankki', { categoryId: FUN(), source: 'user' });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency)
    SELECT ?, ?, import_session_id, '{}', booking_date, amount, currency FROM normalized_transactions WHERE id = ?`).run(crypto.randomUUID(), now, a);
  db.prepare('INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), now, accountId, '2026-11-01', 100, 'EUR');
  db.prepare('INSERT INTO balance_adjustments (id, created_at, account_id, date, amount, reason) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), now, accountId, '2026-11-01', 5, 'korjaus');
  db.prepare('INSERT INTO transfer_links (id, created_at, from_transaction_id, to_transaction_id, confidence) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), now, a, b, 90);
  const before = Object.fromEntries(MONEY_TABLES.map((t) => [t, checksum(t)]));

  const sets = [
    applyNow({ kind: 'recategorize', transactionIds: [a, b], categoryId: FOOD() }, 'hermes'),
    applyNow({ kind: 'create_category', name: 'Polttoaine' }, 'hermes'),
  ];
  const fuel = sets[1].categories[0].id!;
  sets.push(applyNow({ kind: 'rename_category', categoryId: fuel, name: 'Polttoaineet' }, 'hermes'));
  sets.push(applyNow({ kind: 'create_rule', pattern: 'huoltoasema', matchField: 'counterparty', categoryId: fuel }, 'hermes'));
  sets.push(applyNow({ kind: 'disable_rule', ruleId: sets[3].rules[0].id! }, 'hermes'));
  const other = applyNow({ kind: 'create_category', name: 'Autoilu' }, 'hermes').categories[0].id!;
  sets.push(applyNow({ kind: 'merge_categories', fromId: fuel, intoId: other }, 'hermes'));
  sets.push(applyNow({ kind: 'archive_category', categoryId: other }, 'hermes'));
  for (const set of sets.reverse()) applyNow({ kind: 'undo', changeSetId: set.id }, 'hermes');

  assert.deepEqual(Object.fromEntries(MONEY_TABLES.map((t) => [t, checksum(t)])), before);
});
