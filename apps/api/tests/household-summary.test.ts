// IMPORTANT: set DB_PATH before any project imports
process.env.DB_PATH = ':memory:';

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import { getHouseholdSummary } from '../src/summary.js';

initDb();

function mkAccount(subtype = 'checking', name = 'Test Account') {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, now, name, null, 'bank', subtype);
  return id;
}

function mkSnapshot(accountId: string, balance: number, daysAgo: number) {
  const date = new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), now, accountId, date, balance, 'EUR');
  return date;
}

function mkImportSession(daysAgo = 0) {
  const id = crypto.randomUUID();
  const ts = new Date(Date.now() - daysAgo * 86400_000).toISOString();
  db.prepare(
    'INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, ts, 'test', 'csv', 'x', 1, crypto.randomUUID());
  return id;
}

function mkSubscriptionPattern(accountId: string, amount: number, isActive = 1) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO recurring_patterns
      (id, created_at, updated_at, account_id, counterparty_name, pattern_type, interval_days, typical_amount, currency, first_seen, last_seen, occurrence_count, is_active)
      VALUES (?, ?, ?, ?, ?, 'subscription', 30, ?, 'EUR', ?, ?, 3, ?)`
  ).run(id, now, now, accountId, 'Service', amount, date, date, isActive);
  return id;
}

function mkBriefingSession(importSessionId: string | null = null) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO briefing_sessions (id, created_at, import_session_id, finding_count) VALUES (?, ?, ?, ?)'
  ).run(id, now, importSessionId, 0);
  return id;
}

function mkFinding(briefingSessionId: string, severity = 'info', impactEur: number | null = null) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO insight_findings
      (id, created_at, briefing_session_id, finding_type, title, description, severity, impact_eur, transaction_ids, metadata, dismissed_at)
      VALUES (?, ?, ?, 'test_finding', 'Test Finding', 'Test description', ?, ?, '[]', '{}', NULL)`
  ).run(id, now, briefingSessionId, severity, impactEur);
  return id;
}

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

// Test 1: empty DB returns zeros
test('getHouseholdSummary — empty DB returns zeros', () => {
  const summary = getHouseholdSummary();
  assert.equal(summary.liquidAssets, 0);
  assert.equal(summary.totalSavings, 0);
  assert.equal(summary.creditDebt, 0);
  assert.equal(summary.monthlySubscriptions, 0);
  assert.equal(summary.runwayMonths, null);
  assert.deepEqual(summary.accounts, []);
  assert.equal(summary.dataAgeDays, 0);
});

// Test 2: liquidAssets sums checking accounts only
test('liquidAssets sums checking accounts only', () => {
  const checkingId = mkAccount('checking', 'Checking');
  const savingsId = mkAccount('savings', 'Savings');

  mkSnapshot(checkingId, 1000, 1);
  mkSnapshot(savingsId, 5000, 1);

  const summary = getHouseholdSummary();
  assert.equal(summary.liquidAssets, 1000);
  assert.equal(summary.totalSavings, 5000);
});

// Test 3: creditDebt is positive (absolute) for credit_card account
test('creditDebt is positive (absolute) for credit_card account', () => {
  const creditId = mkAccount('credit_card', 'Credit Card');
  mkSnapshot(creditId, -1200, 1);

  const summary = getHouseholdSummary();
  assert.ok(summary.creditDebt > 0, 'creditDebt should be positive');
  assert.equal(summary.creditDebt, 1200);
});

// Test 4: account trend: up when balance increased
test('account trend: up when balance increased', () => {
  const acctId = mkAccount('checking', 'My Bank');
  // Older snapshot first (more daysAgo), newer second
  mkSnapshot(acctId, 1000, 5);
  mkSnapshot(acctId, 1100, 1);

  const summary = getHouseholdSummary();
  assert.equal(summary.accounts.length, 1);
  assert.equal(summary.accounts[0].trend, 'up');
});

// Test 5: account trend: down when balance decreased
test('account trend: down when balance decreased', () => {
  const acctId = mkAccount('checking', 'My Bank');
  mkSnapshot(acctId, 1000, 5);
  mkSnapshot(acctId, 900, 1);

  const summary = getHouseholdSummary();
  assert.equal(summary.accounts.length, 1);
  assert.equal(summary.accounts[0].trend, 'down');
});

// Test 6: account trend: null when only 1 snapshot
test('account trend: null when only 1 snapshot', () => {
  const acctId = mkAccount('checking', 'My Bank');
  mkSnapshot(acctId, 1000, 1);

  const summary = getHouseholdSummary();
  assert.equal(summary.accounts.length, 1);
  assert.equal(summary.accounts[0].trend, null);
});

// Test 7: monthlySubscriptions sums active subscription patterns
test('monthlySubscriptions sums active subscription patterns', () => {
  const acctId = mkAccount('checking', 'My Bank');
  mkSnapshot(acctId, 1000, 1);

  mkSubscriptionPattern(acctId, 9.99, 1);
  mkSubscriptionPattern(acctId, 15.99, 1);
  // Inactive pattern should not be counted
  mkSubscriptionPattern(acctId, 100.00, 0);

  const summary = getHouseholdSummary();
  assert.ok(
    Math.abs(summary.monthlySubscriptions - 25.98) < 0.001,
    `Expected ~25.98, got ${summary.monthlySubscriptions}`
  );
});

// Test 8: briefing endpoint returns latest briefing session
test('briefing endpoint returns latest briefing session — queried via DB directly', () => {
  const importSessionId = mkImportSession(0);
  const briefingId = mkBriefingSession(importSessionId);
  const f1 = mkFinding(briefingId, 'alert', 500);
  const f2 = mkFinding(briefingId, 'info', null);

  // Simulate what the GET /briefing/latest endpoint does
  const session = db
    .prepare(`SELECT * FROM briefing_sessions ORDER BY created_at DESC LIMIT 1`)
    .get() as any;

  assert.ok(session, 'briefing session should exist');
  assert.equal(session.id, briefingId);

  const findings = db
    .prepare(
      `SELECT id, finding_type, title, description, severity, impact_eur, transaction_ids, metadata, created_at
       FROM insight_findings
       WHERE briefing_session_id = ? AND dismissed_at IS NULL
       ORDER BY
         CASE severity WHEN 'alert' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END ASC,
         impact_eur DESC`
    )
    .all(briefingId) as any[];

  assert.equal(findings.length, 2);
  // alert severity finding should come first
  assert.equal(findings[0].id, f1);
  assert.equal(findings[0].severity, 'alert');
});

// Test 9: dismiss marks finding as dismissed
test('dismiss marks finding as dismissed', () => {
  const importSessionId = mkImportSession(0);
  const briefingId = mkBriefingSession(importSessionId);
  const findingId = mkFinding(briefingId, 'info', null);

  // Simulate the POST /briefing/:findingId/dismiss endpoint
  const now = new Date().toISOString();
  const result = db
    .prepare(`UPDATE insight_findings SET dismissed_at = ? WHERE id = ?`)
    .run(now, findingId) as { changes: number };

  assert.equal(result.changes, 1);

  const row = db
    .prepare(`SELECT dismissed_at FROM insight_findings WHERE id = ?`)
    .get(findingId) as any;

  assert.ok(row.dismissed_at !== null, 'dismissed_at should be set');
});
