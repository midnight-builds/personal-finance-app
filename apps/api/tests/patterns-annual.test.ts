import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DB_PATH = ':memory:';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import { detectPatterns } from '../src/patterns.js';

initDb();

function mkAccount() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'Test', null, 'bank', 'checking');
  return id;
}

function mkSession() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'test', 'csv', 'x', 1, crypto.randomUUID());
  return id;
}

function mkTxOnDate(accountId: string, sessionId: string, counterparty: string, amount: number, date: string) {
  const id = crypto.randomUUID();
  const raw = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(raw, now, sessionId, '{}', date, amount, 'EUR');
  db.prepare('INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name, description, counterparty_iban, transaction_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, raw, sessionId, accountId, date, date, amount, 'EUR', counterparty, null, null, null);
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

test('detects annual pattern from 2 occurrences ~365 days apart', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTxOnDate(acct, sess, 'IF Vakuutus', -312.50, '2023-01-15');
  mkTxOnDate(acct, sess, 'IF Vakuutus', -318.00, '2024-01-17');

  detectPatterns(acct);

  const pattern = db.prepare(
    "SELECT * FROM recurring_patterns WHERE counterparty_name = 'IF Vakuutus'"
  ).get() as any;
  assert.ok(pattern, 'should create annual pattern');
  assert.equal(pattern.pattern_type, 'annual');
  assert.equal(pattern.typical_month, 1);
  assert.ok(pattern.interval_days >= 330 && pattern.interval_days <= 400, `interval_days ${pattern.interval_days} should be 330-400`);
});

test('creates confirmation candidate for large single-occurrence payment', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTxOnDate(acct, sess, 'IF Vakuutus', -312.50, '2024-01-15');

  detectPatterns(acct);

  const conf = db.prepare(
    "SELECT * FROM pattern_confirmations WHERE counterparty_name = 'IF Vakuutus'"
  ).get() as any;
  assert.ok(conf, 'should create confirmation candidate');
  assert.equal(conf.typical_month, 1);
  assert.equal(conf.status, 'pending');
});

test('does not create duplicate confirmation when detectPatterns runs twice', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTxOnDate(acct, sess, 'IF Vakuutus', -312.50, '2024-01-15');

  detectPatterns(acct);
  detectPatterns(acct);

  const confs = db.prepare(
    "SELECT * FROM pattern_confirmations WHERE counterparty_name = 'IF Vakuutus'"
  ).all() as any[];
  assert.equal(confs.length, 1, 'should have exactly one confirmation');
});

test('does not create confirmation if annual pattern already exists', () => {
  const acct = mkAccount();
  const sess = mkSession();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO recurring_patterns
    (id, created_at, updated_at, account_id, counterparty_name, pattern_type, interval_days,
     typical_amount, currency, first_seen, last_seen, occurrence_count, is_active, typical_month)
    VALUES (?, ?, ?, ?, ?, 'annual', 365, 312.50, 'EUR', '2023-01-15', '2024-01-17', 2, 1, 1)`)
    .run(crypto.randomUUID(), now, now, acct, 'IF Vakuutus');

  mkTxOnDate(acct, sess, 'IF Vakuutus', -312.50, '2024-01-15');
  detectPatterns(acct);

  const conf = db.prepare(
    "SELECT * FROM pattern_confirmations WHERE counterparty_name = 'IF Vakuutus'"
  ).get() as any;
  assert.equal(conf, undefined, 'should not create confirmation when annual pattern already exists');
});

test('does not create confirmation for amounts below 80 EUR', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTxOnDate(acct, sess, 'SmallShop', -25.00, '2024-03-15');

  detectPatterns(acct);

  const conf = db.prepare(
    "SELECT * FROM pattern_confirmations WHERE counterparty_name = 'SmallShop'"
  ).get() as any;
  assert.equal(conf, undefined, 'should not create confirmation for amounts below threshold');
});
