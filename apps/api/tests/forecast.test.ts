import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import { computeMonthlyForecast } from '../src/forecast.js';

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

function mkPattern(accountId: string, counterparty: string, type: string, amount: number, typicalMonth: number | null = null) {
  const now = new Date().toISOString();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO recurring_patterns
    (id, created_at, updated_at, account_id, counterparty_name, pattern_type, interval_days,
     typical_amount, currency, first_seen, last_seen, occurrence_count, is_active, typical_month)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, 2, 1, ?)`)
    .run(
      crypto.randomUUID(), now, now, accountId, counterparty, type,
      type === 'annual' ? 365 : 30, amount, today, today, typicalMonth
    );
}

function mkTxOnDate(accountId: string, sessionId: string, amount: number, date: string) {
  const id = crypto.randomUUID();
  const raw = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(raw, now, sessionId, '{}', date, amount, 'EUR');
  db.prepare('INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name, description, counterparty_iban, transaction_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, raw, sessionId, accountId, date, date, amount, 'EUR', 'Shop', null, null, null);
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

test('forecast includes active monthly subscriptions in knownFixed', () => {
  const acct = mkAccount();
  mkPattern(acct, 'Netflix', 'subscription', 15.99);
  mkPattern(acct, 'Spotify', 'subscription', 9.99);

  const forecast = computeMonthlyForecast(1);
  assert.ok(forecast.knownFixed.length >= 2, 'should have at least 2 fixed items');
  const total = forecast.knownFixed.reduce((s: number, i: any) => s + i.amount, 0);
  assert.ok(total >= 25, `knownFixed total ${total} should be >= 25`);
});

test('forecast includes annual items for matching target month only', () => {
  const acct = mkAccount();
  const targetDate = new Date();
  targetDate.setDate(1);
  targetDate.setMonth(targetDate.getMonth() + 1);
  const targetMonth = targetDate.getMonth() + 1;
  const otherMonth = (targetMonth % 12) + 1;

  mkPattern(acct, 'IF Vakuutus', 'annual', 312.50, targetMonth);
  mkPattern(acct, 'Car Insurance', 'annual', 250.00, otherMonth);

  const forecast = computeMonthlyForecast(1);
  assert.equal(forecast.annualItems.length, 1, 'should include only the annual item matching target month');
  assert.equal(forecast.annualItems[0].counterparty, 'IF Vakuutus');
  assert.ok(forecast.projectedTotal >= 312.50);
});

test('forecast projectedTotal includes annual items added on top of variable base', () => {
  const acct = mkAccount();
  const targetDate = new Date();
  targetDate.setDate(1);
  targetDate.setMonth(targetDate.getMonth() + 1);
  const targetMonth = targetDate.getMonth() + 1;

  mkPattern(acct, 'Netflix', 'subscription', 15.99);
  mkPattern(acct, 'IF Vakuutus', 'annual', 300.00, targetMonth);

  const forecast = computeMonthlyForecast(1);
  assert.ok(forecast.projectedTotal >= 315.99, `projectedTotal ${forecast.projectedTotal} should be >= 315.99`);
});

test('forecast returns required shape with zero data', () => {
  const forecast = computeMonthlyForecast(1);
  assert.ok('targetMonth' in forecast, 'should have targetMonth');
  assert.ok('knownFixed' in forecast, 'should have knownFixed');
  assert.ok('historicalAvg' in forecast, 'should have historicalAvg');
  assert.ok('annualItems' in forecast, 'should have annualItems');
  assert.ok('projectedTotal' in forecast, 'should have projectedTotal');
  assert.equal(typeof forecast.projectedTotal, 'number');
});
