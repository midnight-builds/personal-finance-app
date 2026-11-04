import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { initDb, db } from '../src/db.js';
import { getDataStatus } from '../src/dataStatus.js';

initDb();

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec('DELETE FROM normalized_transactions; DELETE FROM raw_transactions; DELETE FROM import_sessions; DELETE FROM accounts;');
  db.exec('PRAGMA foreign_keys=ON;');
});

test('no imports: both timestamps are null', () => {
  assert.deepEqual(getDataStatus(), { lastImportAt: null, dataAsOf: null });
});

test('latest import time and latest booking date', () => {
  const insertSession = db.prepare(
    'INSERT INTO import_sessions (id, created_at, source_bank, format) VALUES (?, ?, ?, ?)'
  );
  insertSession.run('s1', '2026-10-01T08:00:00.000Z', 'nordea', 'csv');
  insertSession.run('s2', '2026-11-02T09:30:00.000Z', 'nordea', 'csv');
  // A failed import leaves a session without rows; it must not count.
  insertSession.run('s3-failed', '2026-11-03T10:00:00.000Z', 'nordea', 'csv');
  const insertRaw = db.prepare(
    'INSERT INTO raw_transactions (id, created_at, import_session_id, data) VALUES (?, ?, ?, ?)'
  );
  insertRaw.run('r1', '2026-10-01T08:00:00.000Z', 's1', '{}');
  insertRaw.run('r2', '2026-11-02T09:30:00.000Z', 's2', '{}');

  const acct = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)')
    .run(acct, '2026-10-01T08:00:00.000Z', 'A', 'FI00TEST', 'bank');
  const insertTx = (bookingDate: string | null) =>
    db
      .prepare(
        `INSERT INTO normalized_transactions (id, created_at, import_session_id, account_id, booking_date, amount, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(crypto.randomUUID(), '2026-11-02T09:30:00.000Z', 's2', acct, bookingDate, -1, 'EUR');
  insertTx('2026-10-30');
  insertTx('2026-10-31');
  insertTx(null);

  assert.deepEqual(getDataStatus(), { lastImportAt: '2026-11-02T09:30:00.000Z', dataAsOf: '2026-10-31' });
});
