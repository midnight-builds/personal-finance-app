import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

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

function mkTx(accountId: string, sessionId: string, counterparty: string, amount: number, daysAgo: number, counterpartyIban: string | null = null) {
  const id = crypto.randomUUID();
  const raw = crypto.randomUUID();
  const date = new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(raw, now, sessionId, '{}', date, amount, 'EUR');
  db.prepare('INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name, description, counterparty_iban, transaction_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, raw, sessionId, accountId, date, date, amount, 'EUR', counterparty, null, counterpartyIban, null);
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

test('a small weekly charge from an unknown merchant is recurring, not a subscription', () => {
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
  assert.equal(row.pattern_type, 'recurring');
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

function patternOf(acct: string, counterparty: string) {
  return db.prepare('SELECT * FROM recurring_patterns WHERE account_id = ? AND counterparty_name = ?')
    .get(acct, counterparty) as any;
}

test('two same-sized restaurant purchases a month apart are not a pattern', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'Tom Yam Thai Food', -14.50, 65);
  mkTx(acct, sess, 'Tom Yam Thai Food', -14.50, 30);

  detectPatterns(acct);

  assert.equal(patternOf(acct, 'Tom Yam Thai Food'), undefined);
});

test('two same-sized grocery purchases a week apart are not a pattern', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'K-Citymarket', -51.80, 15);
  mkTx(acct, sess, 'K-Citymarket', -51.80, 8);

  detectPatterns(acct);

  assert.equal(patternOf(acct, 'K-Citymarket'), undefined);
});

test('a monthly small restaurant purchase is recurring, not a subscription', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'PizzaBuffa', -14.00, 90);
  mkTx(acct, sess, 'PizzaBuffa', -14.00, 60);
  mkTx(acct, sess, 'PizzaBuffa', -14.00, 30);

  detectPatterns(acct);

  assert.equal(patternOf(acct, 'PizzaBuffa')?.pattern_type, 'recurring');
});

test('a monthly payment to a person is recurring, not a subscription', () => {
  const acct = mkAccount();
  const sess = mkSession();
  for (const days of [90, 60, 30]) mkTx(acct, sess, 'VIRTANEN MATTI', -10, days, 'FI2112345600000785');

  detectPatterns(acct);

  assert.equal(patternOf(acct, 'VIRTANEN MATTI')?.pattern_type, 'recurring');
});

test('a person whose name contains a merchant keyword is not a subscription', () => {
  const acct = mkAccount();
  const sess = mkSession();
  for (const days of [90, 60, 30]) mkTx(acct, sess, 'KORHONEN ELISA', -10, days, 'FI2112345600000785');

  detectPatterns(acct);

  assert.equal(patternOf(acct, 'KORHONEN ELISA')?.pattern_type, 'recurring');
});

test('a keyword inside another word does not make a subscription', () => {
  const acct = mkAccount();
  const sess = mkSession();
  for (const days of [90, 60, 30]) mkTx(acct, sess, 'Sedna Oy', -9.90, days);

  detectPatterns(acct);

  assert.equal(patternOf(acct, 'Sedna Oy')?.pattern_type, 'recurring');
});

test('a monthly streaming charge by card is a subscription', () => {
  const acct = mkAccount();
  const sess = mkSession();
  for (const days of [120, 90, 60, 30]) mkTx(acct, sess, 'PAYPAL *HBOMAX HELP.HB', -5.99, days);

  detectPatterns(acct);

  const row = patternOf(acct, 'PAYPAL *HBOMAX HELP.HB');
  assert.equal(row?.pattern_type, 'subscription');
  assert.equal(row?.occurrence_count, 4);
});

test('a monthly bill from an unknown biller is recurring', () => {
  const acct = mkAccount();
  const sess = mkSession();
  for (const days of [90, 60, 30]) mkTx(acct, sess, 'Valoo Oy', -19.90, days, 'FI4950009420028730');

  detectPatterns(acct);

  assert.equal(patternOf(acct, 'Valoo Oy')?.pattern_type, 'recurring');
});

function mkPattern(acct: string, counterparty: string, type: string, count: number, userConfirmed: number | null = null) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO recurring_patterns
      (id, created_at, updated_at, account_id, counterparty_name, pattern_type, interval_days,
       typical_amount, currency, first_seen, last_seen, occurrence_count, is_active, user_confirmed)
    VALUES (?, ?, ?, ?, ?, ?, 30, 14, 'EUR', ?, ?, ?, 1, ?)
  `).run(crypto.randomUUID(), now, now, acct, counterparty, type, now, now, count, userConfirmed);
}

test('a pattern detected earlier on too little evidence is deactivated', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'Tom Yam Thai Food', -14.50, 65);
  mkTx(acct, sess, 'Tom Yam Thai Food', -14.50, 30);
  mkPattern(acct, 'Tom Yam Thai Food', 'subscription', 2);

  detectPatterns(acct);

  assert.equal(patternOf(acct, 'Tom Yam Thai Food').is_active, 0);
});

test('a subscription detected earlier for a person is reclassified as recurring', () => {
  const acct = mkAccount();
  const sess = mkSession();
  for (const days of [90, 60, 30]) mkTx(acct, sess, 'VIRTANEN MATTI', -10, days, 'FI2112345600000785');
  mkPattern(acct, 'VIRTANEN MATTI', 'subscription', 3);

  detectPatterns(acct);

  const row = patternOf(acct, 'VIRTANEN MATTI');
  assert.equal(row.pattern_type, 'recurring');
  assert.equal(row.is_active, 1);
});

test('a known bill whose price varies stays active', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'Helen Oy', -120, 120);
  mkTx(acct, sess, 'Helen Oy', -110, 90);
  mkTx(acct, sess, 'Helen Oy', -70, 60);
  mkTx(acct, sess, 'Helen Oy', -60, 30);
  mkPattern(acct, 'Helen Oy', 'subscription', 4);

  detectPatterns(acct);

  const row = patternOf(acct, 'Helen Oy');
  assert.equal(row.is_active, 1);
  assert.equal(row.pattern_type, 'subscription');
});

test('a pattern detected earlier from two charges is deactivated even if frequent charges follow', () => {
  const acct = mkAccount();
  const sess = mkSession();
  for (const [days, amount] of [[40, -12], [33, -48], [20, -7], [12, -31], [3, -66]]) mkTx(acct, sess, 'K-Market', amount, days);
  mkPattern(acct, 'K-Market', 'subscription', 2);

  detectPatterns(acct);

  assert.equal(patternOf(acct, 'K-Market').is_active, 0);
});

test('an irregular person payment detected earlier as a subscription stays, as recurring', () => {
  const acct = mkAccount();
  const sess = mkSession();
  for (const days of [150, 60, 30]) mkTx(acct, sess, 'VIRTANEN MATTI', -10, days, 'FI2112345600000785');
  mkPattern(acct, 'VIRTANEN MATTI', 'subscription', 3);

  detectPatterns(acct);

  const row = patternOf(acct, 'VIRTANEN MATTI');
  assert.equal(row.is_active, 1);
  assert.equal(row.pattern_type, 'recurring');
});

test('a subscription merchant paid mostly by card stays a subscription', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'Helen Oy', -60, 90);
  mkTx(acct, sess, 'Helen Oy', -60, 60, 'FI4950009420028730');
  mkTx(acct, sess, 'Helen Oy', -60, 30);

  detectPatterns(acct);

  assert.equal(patternOf(acct, 'Helen Oy')?.pattern_type, 'subscription');
});

test("deactivation leaves user-confirmed, annual and other accounts' patterns alone", () => {
  const acct = mkAccount();
  const other = mkAccount();
  mkPattern(acct, 'Confirmed Gym', 'recurring', 2, 1);
  mkPattern(acct, 'Vakuutus', 'annual', 2);
  mkPattern(other, 'Tom Yam Thai Food', 'subscription', 2);

  detectPatterns(acct);

  assert.equal(patternOf(acct, 'Confirmed Gym').is_active, 1);
  assert.equal(patternOf(acct, 'Vakuutus').is_active, 1);
  assert.equal(patternOf(other, 'Tom Yam Thai Food').is_active, 1);
});
