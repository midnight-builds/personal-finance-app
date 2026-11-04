import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

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

function getCategoryId(name: string): string {
  const row = db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string } | undefined;
  if (!row) throw new Error(`Category not found: ${name}`);
  return row.id;
}

function mkTxFull(counterparty: string): string {
  const id = crypto.randomUUID();
  const acctId = crypto.randomUUID();
  const sessId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)')
    .run(acctId, now, 'Test', null, 'bank');
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format) VALUES (?, ?, ?, ?)')
    .run(sessId, now, 'Test', 'CSV');
  db.prepare('INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, amount, currency, counterparty_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, null, sessId, acctId, now, -30, 'EUR', counterparty);
  return id;
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

test('upsertDecision does not create duplicate rule for same counterparty+category', () => {
  const txId1 = mkTxFull('K-Market');
  const txId2 = mkTxFull('K-Market');
  const catId = getCategoryId('Ruoka ja päivittäistavarat');

  upsertDecision({ transactionId: txId1, categoryId: catId, source: 'user', counterparty: 'K-Market' });
  upsertDecision({ transactionId: txId2, categoryId: catId, source: 'user', counterparty: 'K-Market' });

  const rules = db.prepare("SELECT * FROM category_rules WHERE pattern = 'k-market'").all() as any[];
  assert.equal(rules.length, 1, 'should have exactly one rule for K-Market');
});

test('upsertDecision creates separate rules for same counterparty with different categories', () => {
  const txId1 = mkTxFull('S-Market');
  const txId2 = mkTxFull('S-Market');
  const catFood = getCategoryId('Ruoka ja päivittäistavarat');
  const catMisc = getCategoryId('Muut ja epäselvät');

  upsertDecision({ transactionId: txId1, categoryId: catFood, source: 'user', counterparty: 'S-Market' });
  upsertDecision({ transactionId: txId2, categoryId: catMisc, source: 'user', counterparty: 'S-Market' });

  const rules = db.prepare("SELECT * FROM category_rules WHERE pattern = 's-market'").all() as any[];
  assert.equal(rules.length, 2, 'different categories should produce separate rules');
});
