import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { db, initDb, seedDefaultCategories } from '../src/db.js';
import { archiveCategory as deleteCategory, createCategory, renameCategory } from '../src/categorization.js';
import { appendDecision, listCategories, upsertDecision } from '../src/rules.js';
import { resetDb } from './setup/resetDb.js';

// Category roles, seeding, and archiving instead of deleting.

const categoryId = (name: string) =>
  (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string }).id;
const roleHolder = (role: string) =>
  db.prepare('SELECT id, name FROM categories WHERE role = ?').get(role) as { id: string; name: string } | undefined;
const categoryCount = () => Number((db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n);
const builtinRuleCount = () =>
  Number((db.prepare('SELECT COUNT(*) AS n FROM category_rules WHERE builtin = 1').get() as { n: number }).n);
const decisions = (txId: string) =>
  db
    .prepare(
      'SELECT category_id, source, actor FROM categorization_decisions WHERE transaction_id = ? ORDER BY created_at, rowid'
    )
    .all(txId)
    .map((r) => ({ ...r })) as Array<{ category_id: string; source: string; actor: string | null }>;

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

beforeEach(() => resetDb());

test('the default categories carry the fallback, income and refund roles', () => {
  assert.equal(roleHolder('fallback')?.name, 'Muut ja epäselvät');
  assert.equal(roleHolder('income')?.name, 'Tulopuoli ja palkka');
  assert.equal(roleHolder('refund')?.name, 'Palautukset ja hyvitykset');
  assert.throws(() =>
    db.prepare('UPDATE categories SET role = ? WHERE id = ?').run('fallback', categoryId('Vakuutukset'))
  );
});

test('a renamed default is not re-created on restart', () => {
  const before = categoryCount();
  renameCategory(categoryId('Ruoka ja päivittäistavarat'), 'Ruokaostokset');
  renameCategory(categoryId('Muut ja epäselvät'), 'Sekalaiset');
  initDb();
  seedDefaultCategories();
  assert.equal(categoryCount(), before);
  assert.equal(db.prepare('SELECT 1 FROM categories WHERE name = ?').get('Ruoka ja päivittäistavarat'), undefined);
  assert.equal(roleHolder('fallback')?.name, 'Sekalaiset');
});

test('seeding ensures a category for each role', () => {
  // A role category that was lost is re-created under its default name.
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('DELETE FROM categories WHERE role = ?').run('refund');
  db.exec('PRAGMA foreign_keys = ON');
  seedDefaultCategories();
  assert.equal(roleHolder('refund')?.name, 'Palautukset ja hyvitykset');

  // A category with the default name but no role gets the role.
  const income = categoryId('Tulopuoli ja palkka');
  db.prepare('UPDATE categories SET role = NULL WHERE id = ?').run(income);
  const before = categoryCount();
  seedDefaultCategories();
  assert.equal(roleHolder('income')?.id, income);
  assert.equal(categoryCount(), before);
});

test('seeding never takes a role from another role category', () => {
  const misc = roleHolder('fallback')!.id;
  const income = roleHolder('income')!.id;
  db.prepare('UPDATE categories SET role = NULL, name = ? WHERE id = ?').run('Vanha sekalainen', misc);
  renameCategory(income, 'Muut ja epäselvät');
  seedDefaultCategories();
  assert.equal(roleHolder('income')?.id, income);
  assert.equal(roleHolder('fallback'), undefined, 'the default name is taken, so the role stays unfilled');
});

test('built-in rules are seeded once and point at categories by id', () => {
  const seeded = builtinRuleCount();
  assert.ok(seeded > 0);
  initDb();
  seedDefaultCategories();
  assert.equal(builtinRuleCount(), seeded);
  const dangling = db
    .prepare('SELECT COUNT(*) AS n FROM category_rules r LEFT JOIN categories c ON c.id = r.category_id WHERE c.id IS NULL')
    .get() as { n: number };
  assert.equal(Number(dangling.n), 0);
});

test('a built-in rule whose target category is missing is skipped', () => {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('DELETE FROM category_rules; DELETE FROM categories');
  db.exec('PRAGMA foreign_keys = ON');
  const now = new Date().toISOString();
  db.prepare('INSERT INTO categories (id, created_at, name, built_in) VALUES (?, ?, ?, 0)').run(crypto.randomUUID(), now, 'Oma');
  seedDefaultCategories();
  const targets = db
    .prepare('SELECT DISTINCT c.role FROM category_rules r JOIN categories c ON c.id = r.category_id WHERE r.builtin = 1')
    .all()
    .map((r: any) => r.role)
    .sort();
  assert.deepEqual(targets, ['income', 'refund']);
});

test('initDb migrates a database from before roles, actors and rule types', () => {
  db.exec(`
    DROP INDEX IF EXISTS idx_categories_role;
    ALTER TABLE categories DROP COLUMN role;
    ALTER TABLE categories DROP COLUMN archived_at;
    ALTER TABLE categories DROP COLUMN merged_into_id;
    ALTER TABLE category_rules DROP COLUMN match_type;
    ALTER TABLE category_rules DROP COLUMN amount_sign;
    ALTER TABLE category_rules DROP COLUMN builtin;
    ALTER TABLE category_rules DROP COLUMN disabled_at;
    ALTER TABLE category_rules DROP COLUMN actor;
    ALTER TABLE categorization_decisions DROP COLUMN actor;
    ALTER TABLE categorization_decisions DROP COLUMN reason;
    DELETE FROM category_rules;
  `);
  const tx = mkTx();
  db.prepare(
    'INSERT INTO categorization_decisions (id, created_at, transaction_id, category_id, source) VALUES (?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), '2026-01-01T00:00:00.000Z', tx, categoryId('Vakuutukset'), 'rule');
  const before = categoryCount();

  initDb();
  initDb();
  seedDefaultCategories();

  assert.equal(categoryCount(), before);
  assert.equal(roleHolder('fallback')?.name, 'Muut ja epäselvät');
  assert.equal(roleHolder('income')?.name, 'Tulopuoli ja palkka');
  assert.equal(roleHolder('refund')?.name, 'Palautukset ja hyvitykset');
  assert.deepEqual(decisions(tx), [{ category_id: categoryId('Vakuutukset'), source: 'rule', actor: null }]);
  assert.ok(builtinRuleCount() > 0);
});

test('archiving moves current members to fallback and leaves history intact', () => {
  const fallback = roleHolder('fallback')!.id;
  const food = categoryId('Ruoka ja päivittäistavarat');
  const doomed = createCategory('Arkistoitava').id;
  const member = mkTx('Kauppa A');
  const former = mkTx('Kauppa B');
  upsertDecision({ transactionId: member, categoryId: food, source: 'rule' });
  upsertDecision({ transactionId: member, categoryId: doomed, source: 'user', counterparty: 'Kauppa A', actor: 'user' });
  upsertDecision({ transactionId: former, categoryId: doomed, source: 'user' });
  upsertDecision({ transactionId: former, categoryId: food, source: 'user' });
  const memberBefore = decisions(member);
  const formerBefore = decisions(former);

  const res = deleteCategory(doomed, { actor: 'hermes' });

  assert.equal(res.reassignedTo, fallback);
  const row = db.prepare('SELECT name, archived_at FROM categories WHERE id = ?').get(doomed) as any;
  assert.equal(row.name, 'Arkistoitava');
  assert.ok(row.archived_at);
  assert.deepEqual(decisions(member).slice(0, memberBefore.length), memberBefore, 'old decisions are not modified');
  assert.deepEqual(decisions(member).at(-1), { category_id: fallback, source: 'category_archived', actor: 'hermes' });
  assert.deepEqual(decisions(former), formerBefore, 'a former member keeps its current category');

  const rules = db.prepare('SELECT disabled_at FROM category_rules WHERE category_id = ?').all(doomed) as any[];
  assert.equal(rules.length, 1);
  assert.ok(rules[0].disabled_at, 'rules of an archived category are disabled, not deleted');

  assert.ok(!listCategories().some((c) => c.id === doomed));
  assert.ok(listCategories({ includeArchived: true }).some((c) => c.id === doomed));
});

test('archiving can move members into a chosen category', () => {
  const doomed = createCategory('Arkistoitava').id;
  const target = categoryId('Viihde ja harrastukset');
  const tx = mkTx();
  appendDecision({ transactionId: tx, categoryId: doomed, source: 'user' });
  assert.equal(deleteCategory(doomed, { moveTo: target }).reassignedTo, target);
  assert.equal(decisions(tx).at(-1)?.category_id, target);
  assert.throws(() => deleteCategory(createCategory('Toinen').id, { moveTo: doomed }), /invalid_move_target/);
});

test('archiving rejects pending rule suggestions without repointing them', () => {
  const doomed = createCategory('Ehdotuksin').id;
  const insert = db.prepare(
    `INSERT INTO rule_suggestions (id, created_at, category_id, category_name, pattern, match_field, status)
     VALUES (?, ?, ?, 'Ehdotuksin', ?, 'counterparty', ?)`
  );
  const pending = crypto.randomUUID();
  const accepted = crypto.randomUUID();
  insert.run(pending, new Date().toISOString(), doomed, 'kauppa-a', 'pending');
  insert.run(accepted, new Date().toISOString(), doomed, 'kauppa-b', 'accepted');

  deleteCategory(doomed);

  const row = (id: string) => db.prepare('SELECT category_id, status, resolved_at FROM rule_suggestions WHERE id = ?').get(id) as any;
  assert.equal(row(pending).status, 'rejected');
  assert.ok(row(pending).resolved_at);
  assert.equal(row(pending).category_id, doomed);
  assert.equal(row(accepted).status, 'accepted');
  assert.equal(row(accepted).category_id, doomed);
});

test('role categories cannot be archived but can be renamed', () => {
  for (const role of ['fallback', 'income', 'refund']) {
    const id = roleHolder(role)!.id;
    assert.throws(() => deleteCategory(id), /category_has_role/);
    renameCategory(id, `Uusi ${role}`);
    assert.equal(roleHolder(role)?.name, `Uusi ${role}`);
  }
});

test('names of archived categories stay taken; archived categories cannot be renamed or archived again', () => {
  const doomed = createCategory('Vanha').id;
  deleteCategory(doomed);
  assert.throws(() => createCategory('Vanha'), /name_exists/);
  assert.throws(() => renameCategory(categoryId('Vakuutukset'), 'Vanha'), /name_exists/);
  assert.throws(() => renameCategory(doomed, 'Uudempi'), /category_archived/);
  // The service says why; DELETE /categories/:id still answers 404 not_found.
  assert.throws(() => deleteCategory(doomed), /category_archived/);
});

test('listCategories includes each category role', () => {
  const listed = listCategories();
  assert.equal(listed.find((c) => c.name === 'Muut ja epäselvät')?.role, 'fallback');
  assert.equal(listed.find((c) => c.name === 'Vakuutukset')?.role, null);
});

test('decisions record actor and reason', () => {
  const tx = mkTx();
  appendDecision({ transactionId: tx, categoryId: categoryId('Vakuutukset'), source: 'user', actor: 'hermes', reason: 'vakuutusmaksu' });
  const row = db.prepare('SELECT actor, reason FROM categorization_decisions WHERE transaction_id = ?').get(tx) as any;
  assert.deepEqual({ ...row }, { actor: 'hermes', reason: 'vakuutusmaksu' });

  upsertDecision({ transactionId: tx, categoryId: categoryId('Viihde ja harrastukset'), source: 'user', counterparty: 'Testipuoti', actor: 'hermes' });
  const rule = db.prepare('SELECT actor FROM category_rules WHERE pattern = ?').get('testipuoti') as any;
  assert.equal(rule.actor, 'hermes');
});
