import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DB_PATH = ':memory:';

import { initDb, db } from '../src/db.js';
import { getSummary } from '../src/summary.js';
import { createBalanceAdjustment } from '../src/balanceAdjustments.js';
import { seedDefaultCategories } from '../src/db.js';

initDb();

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
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
