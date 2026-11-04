import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { initDb, db } from '../src/db.js';
import { getBalanceSnapshotsForAccount } from '../src/balanceSnapshots.js';

initDb();

function mkAccount() {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, new Date().toISOString(), 'Test', null, 'bank', 'checking');
  return id;
}

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec('DELETE FROM balance_snapshots; DELETE FROM accounts;');
  db.exec('PRAGMA foreign_keys=ON;');
});

test('returns empty array when account has no snapshots', () => {
  const id = mkAccount();
  const rows = getBalanceSnapshotsForAccount(id);
  assert.deepEqual(rows, []);
});

test('returns snapshots ordered by date ascending', () => {
  const id = mkAccount();
  const now = new Date().toISOString();
  const ins = db.prepare(
    'INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)'
  );
  ins.run(crypto.randomUUID(), now, id, '2025-03-01', 1200, 'EUR');
  ins.run(crypto.randomUUID(), now, id, '2025-01-01', 1000, 'EUR');
  ins.run(crypto.randomUUID(), now, id, '2025-02-01', 1100, 'EUR');

  const rows = getBalanceSnapshotsForAccount(id);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].date, '2025-01-01');
  assert.equal(rows[0].balance, 1000);
  assert.equal(rows[1].date, '2025-02-01');
  assert.equal(rows[2].date, '2025-03-01');
  assert.equal(rows[2].balance, 1200);
});

test('only returns snapshots for the requested account', () => {
  const id1 = mkAccount();
  const id2 = mkAccount();
  const now = new Date().toISOString();
  const ins = db.prepare(
    'INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)'
  );
  ins.run(crypto.randomUUID(), now, id1, '2025-01-01', 1000, 'EUR');
  ins.run(crypto.randomUUID(), now, id2, '2025-01-01', 2000, 'EUR');

  const rows = getBalanceSnapshotsForAccount(id1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].balance, 1000);
});
