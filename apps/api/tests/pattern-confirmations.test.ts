import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DB_PATH = ':memory:';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import {
  listPendingConfirmations,
  confirmPatternConfirmation,
  rejectPatternConfirmation,
} from '../src/patternConfirmations.js';

initDb();

function mkAccount() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'Test', null, 'bank', 'checking');
  return id;
}

function mkConfirmation(accountId: string, counterparty: string, month: number, amount: number, status = 'pending') {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO pattern_confirmations
    (id, created_at, account_id, counterparty_name, typical_month, typical_amount, currency, status)
    VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?)`)
    .run(id, new Date().toISOString(), accountId, counterparty, month, amount, status);
  return id;
}

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM pattern_confirmations; DELETE FROM recurring_patterns;
    DELETE FROM transfer_links; DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions; DELETE FROM import_sessions; DELETE FROM accounts;
    DELETE FROM categorization_decisions; DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
});

test('confirmPatternConfirmation creates annual recurring_pattern', () => {
  const acct = mkAccount();
  const confId = mkConfirmation(acct, 'IF Vakuutus', 1, 312.50);

  confirmPatternConfirmation(confId);

  const pattern = db.prepare(
    "SELECT * FROM recurring_patterns WHERE counterparty_name = 'IF Vakuutus'"
  ).get() as any;
  assert.ok(pattern, 'should create annual pattern');
  assert.equal(pattern.pattern_type, 'annual');
  assert.equal(pattern.typical_month, 1);
  assert.equal(pattern.user_confirmed, 1);

  const conf = db.prepare('SELECT status FROM pattern_confirmations WHERE id = ?').get(confId) as any;
  assert.equal(conf.status, 'confirmed');
});

test('rejectPatternConfirmation marks rejected, no pattern created', () => {
  const acct = mkAccount();
  const confId = mkConfirmation(acct, 'SomeShop', 3, 200.00);

  rejectPatternConfirmation(confId);

  const pattern = db.prepare(
    "SELECT * FROM recurring_patterns WHERE counterparty_name = 'SomeShop'"
  ).get() as any;
  assert.equal(pattern, undefined, 'should not create pattern on rejection');

  const conf = db.prepare('SELECT status FROM pattern_confirmations WHERE id = ?').get(confId) as any;
  assert.equal(conf.status, 'rejected');
});

test('listPendingConfirmations returns only pending', () => {
  const acct = mkAccount();
  mkConfirmation(acct, 'A', 1, 300.00, 'pending');
  mkConfirmation(acct, 'B', 2, 150.00, 'confirmed');
  mkConfirmation(acct, 'C', 3, 200.00, 'rejected');

  const pending = listPendingConfirmations();
  assert.equal(pending.length, 1);
  assert.equal((pending[0] as any).counterparty_name, 'A');
});
