import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Fastify from 'fastify';

import { db } from '../src/db.js';
import { actorOf } from '../src/http/actor.js';
import { routes } from '../src/routes/index.js';
import { resetDb } from './setup/resetDb.js';

const app = Fastify();
await app.register(routes);
after(() => app.close());

beforeEach(() => resetDb());

const categoryId = (name: string) =>
  (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string }).id;
const roleId = (role: string) => (db.prepare('SELECT id FROM categories WHERE role = ?').get(role) as { id: string }).id;
const latestDecision = (txId: string) =>
  ({
    ...(db
      .prepare(
        'SELECT category_id, source, actor FROM categorization_decisions WHERE transaction_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
      )
      .get(txId) as object),
  }) as { category_id: string; source: string; actor: string | null };

function mkTx(counterparty = 'Testipuoti') {
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
  return id;
}

test('actorOf reads X-Finance-Actor, defaulting to user', () => {
  const req = (value?: string | string[]) => ({ headers: value === undefined ? {} : { 'x-finance-actor': value } }) as any;
  assert.equal(actorOf(req()), 'user');
  assert.equal(actorOf(req('hermes')), 'hermes');
  assert.equal(actorOf(req('agent_2-b')), 'agent_2-b');
  assert.equal(actorOf(req('Hermes')), 'user');
  assert.equal(actorOf(req('')), 'user');
  assert.equal(actorOf(req('a'.repeat(41))), 'user');
  assert.equal(actorOf(req('bad actor')), 'user');
  assert.equal(actorOf(req(['hermes', 'user'])), 'user');
});

test('GET /categories lists categories in use with their role', async () => {
  const res = await app.inject({ method: 'GET', url: '/categories' });
  assert.equal(res.statusCode, 200);
  const list = res.json() as Array<{ id: string; name: string; built_in: number; role: string | null }>;
  assert.equal(list.find((c) => c.role === 'fallback')?.name, 'Muut ja epäselvät');
  assert.deepEqual(Object.keys(list[0]).sort(), ['built_in', 'id', 'name', 'role']);
});

test('POST /transactions/:id/category records the actor from the header', async () => {
  const tx = mkTx();
  const food = categoryId('Ruoka ja päivittäistavarat');
  const post = (categoryId: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/transactions/${tx}/category`, payload: { categoryId }, headers });

  const res = await post(food, { 'x-finance-actor': 'hermes' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.deepEqual(latestDecision(tx), { category_id: food, source: 'user', actor: 'hermes' });

  await post(categoryId('Vakuutukset'));
  assert.equal(latestDecision(tx).actor, 'user');
  await post(food, { 'x-finance-actor': 'not valid!' });
  assert.equal(latestDecision(tx).actor, 'user');

  assert.equal((await app.inject({ method: 'POST', url: `/transactions/${tx}/category`, payload: {} })).statusCode, 400);
});

test('POST /transactions/:id/category refuses an archived category', async () => {
  const tx = mkTx();
  const created = (await app.inject({ method: 'POST', url: '/categories', payload: { name: 'Vanha' } })).json();
  await app.inject({ method: 'DELETE', url: `/categories/${created.id}` });
  const res = await app.inject({ method: 'POST', url: `/transactions/${tx}/category`, payload: { categoryId: created.id } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'category_archived');
});

test('DELETE /categories/:id archives with the actor; role categories give 400', async () => {
  const created = (await app.inject({ method: 'POST', url: '/categories', payload: { name: 'Arkistoitava' } })).json();
  const tx = mkTx();
  await app.inject({ method: 'POST', url: `/transactions/${tx}/category`, payload: { categoryId: created.id } });

  const res = await app.inject({ method: 'DELETE', url: `/categories/${created.id}`, headers: { 'x-finance-actor': 'hermes' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, reassignedTo: roleId('fallback') });
  assert.deepEqual(latestDecision(tx), { category_id: roleId('fallback'), source: 'category_archived', actor: 'hermes' });
  const listed = (await app.inject({ method: 'GET', url: '/categories' })).json() as Array<{ id: string }>;
  assert.ok(!listed.some((c) => c.id === created.id));

  const again = await app.inject({ method: 'DELETE', url: `/categories/${created.id}` });
  assert.equal(again.statusCode, 404);

  const role = await app.inject({ method: 'DELETE', url: `/categories/${roleId('fallback')}` });
  assert.equal(role.statusCode, 400);
  assert.equal(role.json().error, 'category_has_role');
});

test('POST and PATCH /categories: names stay unique, role categories can be renamed', async () => {
  const dup = await app.inject({ method: 'POST', url: '/categories', payload: { name: 'Vakuutukset' } });
  assert.equal(dup.statusCode, 400);
  assert.equal(dup.json().error, 'name_exists');

  const rename = await app.inject({ method: 'PATCH', url: `/categories/${roleId('fallback')}`, payload: { name: 'Sekalaiset' } });
  assert.equal(rename.statusCode, 200);
  assert.deepEqual(rename.json(), { ok: true });

  const taken = await app.inject({ method: 'PATCH', url: `/categories/${roleId('income')}`, payload: { name: 'Sekalaiset' } });
  assert.equal(taken.statusCode, 400);
  assert.equal(taken.json().error, 'name_exists');

  const missing = await app.inject({ method: 'PATCH', url: `/categories/nope`, payload: { name: 'X' } });
  assert.equal(missing.statusCode, 404);
});

test('POST /rule-suggestions/:id/accept records the actor', async () => {
  const id = crypto.randomUUID();
  const food = categoryId('Ruoka ja päivittäistavarat');
  db.prepare(
    `INSERT INTO rule_suggestions (id, created_at, category_id, category_name, pattern, match_field)
     VALUES (?, ?, ?, 'Ruoka ja päivittäistavarat', 'kulmakioski', 'counterparty')`
  ).run(id, new Date().toISOString(), food);
  const res = await app.inject({ method: 'POST', url: `/rule-suggestions/${id}/accept`, headers: { 'x-finance-actor': 'hermes' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal((db.prepare("SELECT actor FROM category_rules WHERE pattern = 'kulmakioski'").get() as any).actor, 'hermes');
  assert.equal((await app.inject({ method: 'POST', url: `/rule-suggestions/${id}/accept` })).statusCode, 409);
});

const COLUMNS = ['Kirjauspäivä', 'Määrä', 'Maksaja', 'Maksunsaaja', 'Nimi', 'Otsikko', 'Viesti', 'Viitenumero', 'Saldo', 'Valuutta'];

function importForm(rows: string[][], fields: Record<string, string>) {
  const b = 'actor-boundary-41c2';
  const csv = [COLUMNS.join(';'), ...rows.map((r) => r.join(';'))].join('\n');
  const parts = Object.entries(fields).map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  parts.push(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="tili.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n`);
  return { payload: Buffer.from(parts.join('') + `--${b}--\r\n`), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

test('rule decisions made during an import carry the import request actor', async () => {
  const row = (date: string, amount: string, payee: string) => [date, amount, '', payee, '', '', '', '', '', 'EUR'];
  const fields = { newAccountName: 'Testitili', newAccountSubtype: 'checking' };
  const withActor = importForm([row('2026/11/02', '-12,50', 'Ruokapuoti Kulma')], fields);
  const res = await app.inject({
    method: 'POST',
    url: '/imports/nordea/csv',
    ...withActor,
    headers: { ...withActor.headers, 'x-finance-actor': 'hermes' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const decided = db.prepare('SELECT source, actor FROM categorization_decisions').all().map((r) => ({ ...r }));
  assert.deepEqual(decided, [{ source: 'rule', actor: 'hermes' }]);

  const plain = importForm([row('2026/11/03', '-8,00', 'Toinen Puoti')], { newAccountName: 'Toinen tili', newAccountSubtype: 'checking' });
  assert.equal((await app.inject({ method: 'POST', url: '/imports/nordea/csv', ...plain })).statusCode, 200);
  const actors = db.prepare('SELECT actor FROM categorization_decisions ORDER BY rowid').all().map((r: any) => r.actor);
  assert.deepEqual(actors, ['hermes', 'user']);
});
