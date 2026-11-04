import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import { getInsights } from '../src/insights.js';

initDb();

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM insight_findings;
    DELETE FROM briefing_sessions;
    DELETE FROM recurring_patterns;
    DELETE FROM transfer_links;
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

function ymd(d: Date) {
  return d.toISOString().slice(0, 10);
}

function addMonths(date: Date, months: number) {
  // Date in UTC assumed; keep day=1.
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
}

test('monthly spike excludes known recurring monthly payments (and selects ids correctly)', () => {
  const nowIso = new Date().toISOString();
  const acct = crypto.randomUUID();
  const sess = crypto.randomUUID();

  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)').run(
    acct,
    nowIso,
    'Test Account',
    'FI00TEST',
    'bank'
  );
  db.prepare(
    'INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(sess, nowIso, 'Test', 'CSV', null, 1, null);

  const insertTx = (bookingDate: string, amount: number, name: string, desc: string) => {
    const raw = crypto.randomUUID();
    const nt = crypto.randomUUID();

    db.prepare(
      'INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(raw, nowIso, sess, '{}', bookingDate, amount, 'EUR');

    db.prepare(`
      INSERT INTO normalized_transactions (
        id, created_at, raw_transaction_id, import_session_id, account_id,
        booking_date, transaction_date, amount, currency,
        counterparty_name, counterparty_iban, description, transaction_group_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nt,
      nowIso,
      raw,
      sess,
      acct,
      bookingDate,
      bookingDate,
      amount,
      'EUR',
      name,
      null,
      desc,
      null
    );

    return nt;
  };

  // Use last full month and 3 full months before it (calendar months).
  const now = new Date();
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonthStart = addMonths(currentMonthStart, -1);

  const months = [
    addMonths(lastMonthStart, -3),
    addMonths(lastMonthStart, -2),
    addMonths(lastMonthStart, -1),
    lastMonthStart,
  ];

  // Recurring monthly payment (should be excluded from monthly spike totals and tx ids)
  const netflixIds: string[] = [];
  for (const m of months) {
    const d = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 2));
    netflixIds.push(insertTx(ymd(d), -10, 'Netflix', 'Subscription'));
  }

  // Baseline expenses that are *not* perfectly recurring by (name, amount) signature.
  // (Monthly spike excludes known recurring monthly payments detected by same name+amount across months.)
  const baseline = [-190, -210, -200];
  months.slice(0, 3).forEach((m, idx) => {
    const d = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 10));
    insertTx(ymd(d), baseline[idx], 'Groceries', 'Food');
  });

  // Last month has an extra large one-off, causing spike
  const tripId = insertTx(
    ymd(new Date(Date.UTC(lastMonthStart.getUTCFullYear(), lastMonthStart.getUTCMonth(), 15))),
    -400,
    'TravelCo',
    'Trip'
  );
  // Plus baseline in last month
  insertTx(
    ymd(new Date(Date.UTC(lastMonthStart.getUTCFullYear(), lastMonthStart.getUTCMonth(), 10))),
    -200,
    'Groceries',
    'Food'
  );

  const insights = getInsights();
  const ms = insights.find((i) => i.id.startsWith('monthly-spike-'));
  assert.ok(ms, 'expected monthly spike insight');

  assert.ok(ms.transactionIds.includes(tripId), 'expected the large one-off expense to be included');
  for (const id of netflixIds) {
    assert.ok(
      !ms.transactionIds.includes(id),
      'expected recurring monthly payment to be excluded from selected tx ids'
    );
  }
});
