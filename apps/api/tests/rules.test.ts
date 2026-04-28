import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DB_PATH = ':memory:';

import { initDb, seedDefaultCategories, db } from '../src/db.js';
import { chooseCategoryFor, upsertDecision } from '../src/rules.js';

initDb();
seedDefaultCategories();

function createTx(id: string) {
  const now = new Date().toISOString();
  const acct = crypto.randomUUID();
  const imp = crypto.randomUUID();
  db.prepare(
    'INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)'
  ).run(acct, now, 'Test', null, 'bank');
  db.prepare(
    'INSERT INTO import_sessions (id, created_at, source_bank, format) VALUES (?, ?, ?, ?)'
  ).run(imp, now, 'Test', 'CSV');
  db.prepare(
    'INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, now, null, imp, acct, now, -10, 'EUR');
}

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM insight_findings;
    DELETE FROM briefing_sessions;
    DELETE FROM recurring_patterns;
    DELETE FROM categorization_decisions;
    DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
    DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions;
    DELETE FROM import_sessions;
    DELETE FROM accounts;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
});

test('chooseCategoryFor falls back to defaults and detects salary keywords', () => {
  const catId = chooseCategoryFor({
    counterparty: 'Acme Oy',
    description: 'Palkka tammi',
    amount: 2500,
  });
  const row = db.prepare('SELECT name FROM categories WHERE id = ?').get(catId as string) as any;
  assert.equal(row.name, 'Tulopuoli ja palkka');
});

test('upsertDecision replaces previous decision', () => {
  const txId = 'tx-1';
  createTx(txId);
  const catA = db
    .prepare('SELECT id FROM categories WHERE name = ?')
    .get('Muut ja epäselvät') as any;
  const catB = db
    .prepare('SELECT id FROM categories WHERE name = ?')
    .get('Ruoka ja päivittäistavarat') as any;

  upsertDecision({ transactionId: txId, categoryId: catA.id, source: 'rule' });
  upsertDecision({ transactionId: txId, categoryId: catB.id, source: 'user' });

  const rows = db
    .prepare('SELECT category_id, source FROM categorization_decisions WHERE transaction_id = ?')
    .all(txId) as Array<any>;

  assert.equal(rows.length, 1);
  assert.equal(rows[0].category_id, catB.id);
  assert.equal(rows[0].source, 'user');
});
