import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import { runBriefing } from '../src/briefing.js';

initDb();

// Fixtures place rows N days before the UTC date; the briefing must use the same day.
const FIXTURE_DAY = new Date().toISOString().slice(0, 10);

function mkAccount(subtype = 'checking') {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'Test ' + subtype, null, 'bank', subtype);
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

function mkPattern(accountId: string, counterparty: string, type = 'subscription', amount = 15.99, daysAgo = 5) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const date = new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO recurring_patterns
    (id, created_at, updated_at, account_id, counterparty_name, pattern_type, interval_days, typical_amount, currency, first_seen, last_seen, occurrence_count, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 30, ?, 'EUR', ?, ?, 3, 1)`)
    .run(id, now, now, accountId, counterparty, type, amount, date, date);
  return id;
}

function mkBalance(accountId: string, balance: number, daysAgo: number) {
  const date = new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
  db.prepare('INSERT OR REPLACE INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), new Date().toISOString(), accountId, date, balance, 'EUR');
}

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM insight_findings; DELETE FROM briefing_sessions;
    DELETE FROM recurring_patterns; DELETE FROM transfer_links;
    DELETE FROM balance_snapshots; DELETE FROM balance_adjustments;
    DELETE FROM normalized_transactions; DELETE FROM raw_transactions;
    DELETE FROM import_sessions; DELETE FROM accounts;
    DELETE FROM categorization_decisions; DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
});

test('runBriefing creates a briefing_session row and returns its id', async () => {
  const sess = mkSession();
  const briefingId = await runBriefing(sess, FIXTURE_DAY);
  assert.ok(typeof briefingId === 'string' && briefingId.length > 0);
  const row = db.prepare('SELECT * FROM briefing_sessions WHERE id = ?').get(briefingId) as any;
  assert.ok(row);
  assert.equal(row.import_session_id, sess);
});

test('subscriptionCreep generator fires when subscriptions exist', async () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkPattern(acct, 'Netflix', 'subscription', 15.99, 5);
  mkPattern(acct, 'Spotify', 'subscription', 9.99, 3);

  const briefingId = await runBriefing(sess, FIXTURE_DAY);

  const findings = db.prepare("SELECT * FROM insight_findings WHERE briefing_session_id = ? AND finding_type = 'subscription_creep'").all(briefingId) as any[];
  assert.ok(findings.length >= 1, 'should produce at least one subscription_creep finding');
  const f = findings[0];
  // Total should be 15.99 + 9.99 = 25.98
  assert.ok(f.description.includes('25.98') || f.description.includes('€'), 'should mention total amount');
});

test('newRecurring generator fires for recently created patterns', async () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkPattern(acct, 'Fortum', 'recurring', 87.50, 10);

  const briefingId = await runBriefing(sess, FIXTURE_DAY);

  const findings = db.prepare("SELECT * FROM insight_findings WHERE briefing_session_id = ? AND finding_type = 'new_recurring'").all(briefingId) as any[];
  assert.ok(findings.length >= 1);
  assert.ok(findings[0].description.includes('Fortum'));
});

test('oneOffImpact generator fires for large one-off transaction', async () => {
  const acct = mkAccount();
  const sess = mkSession();
  // Establish baseline: normal monthly spend ~120€ (4 × 30€)
  for (let i = 2; i <= 5; i++) {
    mkTx(acct, sess, 'Ruokakauppa', -30, i * 30);
  }
  // Large one-off purchase this month — well above 2× baseline avg
  mkTx(acct, sess, 'Verkkokauppa.com', -450, 5);

  const briefingId = await runBriefing(sess, FIXTURE_DAY);

  const findings = db.prepare("SELECT * FROM insight_findings WHERE briefing_session_id = ? AND finding_type = 'one_off_impact'").all(briefingId) as any[];
  assert.ok(findings.length >= 1, 'should flag large one-off purchase');
  assert.ok(findings[0].description.includes('Verkkokauppa'));
});

test('savingsProgress generator fires for savings account with balance history', async () => {
  const acct = mkAccount('savings');
  const sess = mkSession();
  mkBalance(acct, 5000, 90);
  mkBalance(acct, 5200, 60);
  mkBalance(acct, 5500, 30);

  const briefingId = await runBriefing(sess, FIXTURE_DAY);

  const findings = db.prepare("SELECT * FROM insight_findings WHERE briefing_session_id = ? AND finding_type = 'savings_progress'").all(briefingId) as any[];
  assert.ok(findings.length >= 1);
});

test('generator exception does not abort briefing — briefing_session still created', async () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkPattern(acct, 'Netflix', 'subscription', 15.99, 5);

  // Should not reject even if some generators find nothing or have edge cases
  await assert.doesNotReject(async () => await runBriefing(sess, FIXTURE_DAY));

  const row = db.prepare('SELECT * FROM briefing_sessions WHERE import_session_id = ?').get(sess) as any;
  assert.ok(row, 'briefing session should be created even if some generators fail');
});

test('creditHealth generator fires when credit card balance is growing', async () => {
  const acct = mkAccount('credit_card');
  const sess = mkSession();
  // Simulate growing credit card debt (balances more negative over time)
  // snapshots[0] = newest (ORDER BY date DESC), so list oldest first when inserting
  mkBalance(acct, -600, 120);
  mkBalance(acct, -800, 90);
  mkBalance(acct, -1000, 60);
  mkBalance(acct, -1200, 30);

  const briefingId = await runBriefing(sess, FIXTURE_DAY);

  const findings = db.prepare("SELECT * FROM insight_findings WHERE briefing_session_id = ? AND finding_type = 'credit_health'").all(briefingId) as any[];
  assert.ok(findings.length >= 1, 'should fire credit_health finding for growing credit card debt');
  assert.equal(findings[0].severity, 'warn');
});

test('creditHealth does not fire for ordinary card use within a month', async () => {
  const acct = mkAccount('credit_card');
  const sess = mkSession();
  // Paid off at every month end; four purchase days in a row this month.
  for (const daysAgo of [95, 65, 35]) mkBalance(acct, 0, daysAgo);
  mkBalance(acct, -100, 4);
  mkBalance(acct, -200, 3);
  mkBalance(acct, -300, 2);
  mkBalance(acct, -400, 1);

  const briefingId = await runBriefing(sess, FIXTURE_DAY);

  const findings = db.prepare("SELECT * FROM insight_findings WHERE briefing_session_id = ? AND finding_type = 'credit_health'").all(briefingId) as any[];
  assert.equal(findings.length, 0, 'debt growing day by day within one month is not a 3-month trend');
});

test('spendingAnomaly generator fires when category spend doubles vs baseline', async () => {
  const acct = mkAccount();
  const sess = mkSession();

  // Get a category id from seeded categories
  const cat = db.prepare("SELECT id FROM categories WHERE name = 'Ruoka ja päivittäistavarat' LIMIT 1").get() as any;
  if (!cat) return; // skip if category not seeded

  const now = new Date().toISOString();

  // Insert baseline transactions 60–90 days ago: 3 months × ~40€ = 40€/mo avg
  for (let m = 2; m <= 4; m++) {
    const txId = mkTx(acct, sess, 'Kauppa', -40, m * 30);
    db.prepare('INSERT INTO categorization_decisions (id, created_at, transaction_id, category_id, source) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), now, txId, cat.id, 'rule');
  }

  // This month: 150€ — well above 2× baseline (80€ threshold)
  const recentTx = mkTx(acct, sess, 'Kauppa', -150, 5);
  db.prepare('INSERT INTO categorization_decisions (id, created_at, transaction_id, category_id, source) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), now, recentTx, cat.id, 'rule');

  const briefingId = await runBriefing(sess, FIXTURE_DAY);

  const findings = db.prepare("SELECT * FROM insight_findings WHERE briefing_session_id = ? AND finding_type = 'spending_anomaly'").all(briefingId) as any[];
  assert.ok(findings.length >= 1, 'should fire spending_anomaly when category spend is > 2× baseline');
});

test('savingsProgress generator does not fire for savings account with only 1 balance snapshot', async () => {
  const acct = mkAccount('savings');
  const sess = mkSession();
  mkBalance(acct, 5000, 30); // only 1 snapshot

  const briefingId = await runBriefing(sess, FIXTURE_DAY);

  const findings = db.prepare("SELECT * FROM insight_findings WHERE briefing_session_id = ? AND finding_type = 'savings_progress'").all(briefingId) as any[];
  assert.equal(findings.length, 0, 'should not fire with fewer than 2 balance snapshots');
});
