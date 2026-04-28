import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DB_PATH = ':memory:';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import { detectPatterns } from '../src/patterns.js';

initDb();

function mkAccount(subtype = 'checking') {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, now, 'Test', null, 'bank', subtype);
  return id;
}

function mkSession() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'test', 'csv', 'x', 1, crypto.randomUUID());
  return id;
}

function mkTx(accountId: string, sessionId: string, counterparty: string, amount: number, daysAgo: number) {
  const id = crypto.randomUUID();
  const raw = crypto.randomUUID();
  const date = new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
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
    DELETE FROM insight_findings; DELETE FROM briefing_sessions;
    DELETE FROM recurring_patterns; DELETE FROM transfer_links;
    DELETE FROM normalized_transactions; DELETE FROM raw_transactions;
    DELETE FROM import_sessions; DELETE FROM accounts;
    DELETE FROM categorization_decisions; DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
});

test('detects monthly recurring pattern from 3 occurrences', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'Fortum', -87.50, 90);
  mkTx(acct, sess, 'Fortum', -89.00, 60);
  mkTx(acct, sess, 'Fortum', -88.00, 30);

  detectPatterns(acct);

  const row = db.prepare("SELECT * FROM recurring_patterns WHERE account_id = ? AND counterparty_name = 'Fortum'").get(acct) as any;
  assert.ok(row, 'should create a recurring_pattern for Fortum');
  assert.equal(row.pattern_type, 'recurring');
  assert.equal(row.occurrence_count, 3);
});

test('classifies small-amount monthly as subscription', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'Spotify', -9.99, 90);
  mkTx(acct, sess, 'Spotify', -9.99, 60);
  mkTx(acct, sess, 'Spotify', -9.99, 30);

  detectPatterns(acct);

  const row = db.prepare("SELECT * FROM recurring_patterns WHERE account_id = ? AND counterparty_name = 'Spotify'").get(acct) as any;
  assert.ok(row);
  assert.equal(row.pattern_type, 'subscription');
});

test('does not create pattern for single occurrence', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'Verkkokauppa', -299.00, 45);

  detectPatterns(acct);

  const rows = db.prepare('SELECT * FROM recurring_patterns WHERE account_id = ?').all(acct);
  assert.equal(rows.length, 0);
});

test('upsert — running detectPatterns twice does not create duplicates', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'Netflix', -15.99, 90);
  mkTx(acct, sess, 'Netflix', -15.99, 60);
  mkTx(acct, sess, 'Netflix', -15.99, 30);

  detectPatterns(acct);
  detectPatterns(acct);

  const rows = db.prepare("SELECT * FROM recurring_patterns WHERE counterparty_name = 'Netflix'").all();
  assert.equal(rows.length, 1);
});

test('excludes transfer-linked transactions', () => {
  const acct = mkAccount();
  const acct2 = mkAccount();
  const sess = mkSession();
  const tx1 = mkTx(acct, sess, 'Siirto', -500, 90);
  const tx2 = mkTx(acct2, sess, 'Siirto', 500, 90);
  mkTx(acct, sess, 'Siirto', -500, 60);
  mkTx(acct, sess, 'Siirto', -500, 30);
  db.prepare('INSERT INTO transfer_links (id, created_at, from_transaction_id, to_transaction_id, confidence) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), new Date().toISOString(), tx1, tx2, 90);

  detectPatterns(acct);

  const rows = db.prepare('SELECT * FROM recurring_patterns WHERE account_id = ?').all(acct);
  assert.equal(rows.length, 0, 'counterparty with any transfer-linked tx is excluded entirely, not just the individual linked occurrences');
});

test('detects weekly recurring pattern from 4 transactions ~7 days apart', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'Ruokakauppa', -45.00, 28);
  mkTx(acct, sess, 'Ruokakauppa', -44.00, 21);
  mkTx(acct, sess, 'Ruokakauppa', -46.00, 14);
  mkTx(acct, sess, 'Ruokakauppa', -45.00, 7);

  detectPatterns(acct);

  const row = db.prepare(
    "SELECT * FROM recurring_patterns WHERE account_id = ? AND counterparty_name = 'Ruokakauppa'"
  ).get(acct) as any;
  assert.ok(row, 'should create a pattern for weekly recurring');
  assert.equal(row.pattern_type, 'recurring');
  assert.ok(row.interval_days >= 6 && row.interval_days <= 8, `interval_days should be 6-8, got ${row.interval_days}`);
});

test('classifies weekly small-amount charge as subscription', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'MealKit', -9.50, 28);
  mkTx(acct, sess, 'MealKit', -9.50, 21);
  mkTx(acct, sess, 'MealKit', -9.50, 14);
  mkTx(acct, sess, 'MealKit', -9.50, 7);

  detectPatterns(acct);

  const row = db.prepare(
    "SELECT * FROM recurring_patterns WHERE account_id = ? AND counterparty_name = 'MealKit'"
  ).get(acct) as any;
  assert.ok(row);
  assert.equal(row.pattern_type, 'subscription');
});

test('does not detect pattern for 4-day interval (too frequent for weekly window)', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'DailyFee', -5.00, 16);
  mkTx(acct, sess, 'DailyFee', -5.00, 12);
  mkTx(acct, sess, 'DailyFee', -5.00, 8);
  mkTx(acct, sess, 'DailyFee', -5.00, 4);

  detectPatterns(acct);

  const rows = db.prepare(
    "SELECT * FROM recurring_patterns WHERE account_id = ? AND counterparty_name = 'DailyFee'"
  ).all(acct);
  assert.equal(rows.length, 0);
});
