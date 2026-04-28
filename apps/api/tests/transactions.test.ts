import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DB_PATH = ':memory:';

import { initDb, db } from '../src/db.js';
import { seedDefaultCategories } from '../src/db.js';
import { listTransactions } from '../src/query.js';

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

test('listTransactions does not throw (regression: sqlite syntax error near %)', () => {
  const now = new Date().toISOString();
  const acct = crypto.randomUUID();
  const sess = crypto.randomUUID();
  const raw = crypto.randomUUID();
  const nt = crypto.randomUUID();

  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)')
    .run(acct, now, 'Test Account', 'FI00TEST', 'bank');

  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sess, now, 'Test', 'CSV', null, 1, null);

  db.prepare('INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(raw, now, sess, '{}', '2026-02-01', -12.34, 'EUR');

  db.prepare(`
    INSERT INTO normalized_transactions (
      id, created_at, raw_transaction_id, import_session_id, account_id,
      booking_date, transaction_date, amount, currency,
      counterparty_name, counterparty_iban, description, transaction_group_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nt,
    now,
    raw,
    sess,
    acct,
    '2026-02-01',
    '2026-02-01',
    -12.34,
    'EUR',
    'Coffee Shop',
    null,
    'Latte',
    null
  );

  const rows = listTransactions();
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, nt);
});
