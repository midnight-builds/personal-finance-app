import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { initDb, db } from '../src/db.js';
import { getSummary } from '../src/summary.js';
import { createBalanceAdjustment } from '../src/balanceAdjustments.js';
import { seedDefaultCategories } from '../src/db.js';

initDb();

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM insight_findings;
    DELETE FROM briefing_sessions;
    DELETE FROM recurring_patterns;
    DELETE FROM balance_snapshots;
    DELETE FROM balance_adjustments;
    DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions;
    DELETE FROM import_sessions;
    DELETE FROM accounts;
    DELETE FROM categorization_decisions;
    DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
});

test('summary works when tables exist', () => {
  const now = new Date().toISOString();
  const acct = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)')
    .run(acct, now, 'Test Account', 'FI00TEST', 'bank');

  db.prepare('INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), now, acct, now, 500.25, 'EUR');

  const summary = getSummary();
  assert.equal(summary.accounts.length, 1);
  assert.equal(summary.totalBalance.toFixed(2), '500.25');
});


test('summary includes balance adjustments up to snapshot date', () => {
  const now = new Date().toISOString();
  const acct = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)')
    .run(acct, now, 'Test Account', 'FI00TEST', 'bank');

  // Snapshot at a fixed date
  db.prepare('INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), now, acct, '2026-02-01', 100, 'EUR');

  // Adjustments before and after snapshot date
  createBalanceAdjustment({ accountId: acct, date: '2026-01-15', amount: 10, reason: 'fix' });
  createBalanceAdjustment({ accountId: acct, date: '2026-02-01', amount: -3, reason: 'same-day fix' });
  createBalanceAdjustment({ accountId: acct, date: '2026-02-02', amount: 999, reason: 'should not apply yet' });

  const summary = getSummary();
  assert.equal(summary.accounts.length, 1);
  // 100 + (10-3) = 107
  assert.equal(summary.totalBalance.toFixed(2), '107.00');
});

test('an account without a balance stays in the summary and is not counted as zero', () => {
  const now = new Date().toISOString();
  const known = crypto.randomUUID();
  const unknown = crypto.randomUUID();
  const insert = db.prepare('INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)');
  insert.run(known, now, 'Known', 'FI00TEST1', 'bank');
  insert.run(unknown, now, 'Unknown', 'FI00TEST2', 'bank');
  db.prepare('INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), now, known, '2026-02-01', 100, 'EUR');

  const summary = getSummary();
  assert.equal(summary.accounts.length, 2);
  const missing = summary.accounts.find((a) => a.id === unknown)!;
  assert.equal(missing.balance, null);
  assert.equal(missing.date, null);
  assert.equal(summary.totalBalance, 100);
  assert.equal(summary.isComplete, false);
  assert.equal(summary.missingBalanceAccountCount, 1);
});

test('no accounts is complete; a known zero balance is a real zero', () => {
  const empty = getSummary();
  assert.equal(empty.isComplete, true);
  assert.equal(empty.missingBalanceAccountCount, 0);
  assert.deepEqual(empty.accounts, []);

  const now = new Date().toISOString();
  const acct = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)')
    .run(acct, now, 'A', 'FI00TEST', 'bank');
  db.prepare('INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), now, acct, '2026-02-01', 0, 'EUR');
  const zero = getSummary();
  assert.equal(zero.accounts[0].balance, 0);
  assert.equal(zero.isComplete, true);
});
