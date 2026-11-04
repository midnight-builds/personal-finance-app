import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { initDb, db } from '../src/db.js';
import { searchTransactions } from '../src/transactionSearch.js';

initDb();

let accountId = '';
let sessionId = '';

function mkTx(
  date: string,
  amount: number,
  counterparty: string,
  description = '',
  groupId: string | null = null,
  createdAt = new Date().toISOString(),
  account = accountId
) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO normalized_transactions
       (id, created_at, import_session_id, account_id, booking_date, amount, currency, counterparty_name, description, transaction_group_id)
     VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?)`
  ).run(id, createdAt, sessionId, account, date, amount, counterparty, description, groupId);
  return id;
}

function mkAccount(name: string) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, NULL, ?)')
    .run(id, new Date().toISOString(), name, 'bank');
  return id;
}

function mkCategory(name: string) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO categories (id, created_at, name, built_in) VALUES (?, ?, ?, 0)')
    .run(id, new Date().toISOString(), name);
  return id;
}

function categorize(txId: string, categoryId: string, createdAt: string) {
  db.prepare(
    'INSERT INTO categorization_decisions (id, created_at, transaction_id, category_id, source) VALUES (?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), createdAt, txId, categoryId, 'user');
}

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`DELETE FROM categorization_decisions; DELETE FROM categories;
           DELETE FROM transfer_links; DELETE FROM normalized_transactions;
           DELETE FROM import_sessions; DELETE FROM accounts;`);
  db.exec('PRAGMA foreign_keys=ON;');
  accountId = crypto.randomUUID();
  sessionId = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)')
    .run(accountId, new Date().toISOString(), 'Main', 'FI2112345600000785', 'bank');
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format) VALUES (?, ?, ?, ?)')
    .run(sessionId, new Date().toISOString(), 'Nordea', 'CSV');
});

test('filters by date range, text and amount; newest first', () => {
  mkTx('2026-01-05', -12.5, 'K-Market Kallio');
  mkTx('2026-02-10', -40, 'K-Market Kallio');
  mkTx('2026-02-11', -9.9, 'Netflix');
  mkTx('2026-03-01', 2500, 'Employer Oy', 'Palkka');

  const feb = searchTransactions({ from: '2026-02-01', to: '2026-02-28' });
  assert.equal(feb.total, 2);
  assert.deepEqual(feb.items.map((t) => t.counterpartyName), ['Netflix', 'K-Market Kallio']);

  const market = searchTransactions({ q: 'market' });
  assert.equal(market.total, 2);

  const big = searchTransactions({ maxAmount: -20 });
  assert.equal(big.total, 1);
  assert.equal(big.items[0].amount, -40);

  const salary = searchTransactions({ q: 'palkka' });
  assert.equal(salary.items[0].counterpartyName, 'Employer Oy');
});

test('excludes transfers by default and never returns IBANs', () => {
  const a = mkTx('2026-02-01', -100, 'Own savings');
  const b = mkTx('2026-02-01', 100, 'Own checking');
  mkTx('2026-02-02', -5, 'Cafe');
  db.prepare('INSERT INTO transfer_links (id, created_at, from_transaction_id, to_transaction_id, confidence) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), new Date().toISOString(), a, b, 90);

  const res = searchTransactions({});
  assert.equal(res.total, 1);
  assert.equal(JSON.stringify(res).includes('FI21'), false);

  const all = searchTransactions({ includeTransfers: true });
  assert.equal(all.total, 3);
  assert.equal(all.items.filter((t) => t.isTransfer).length, 2);
});

test('LIKE wildcards in query are treated literally', () => {
  mkTx('2026-02-01', -1, 'abc');
  assert.equal(searchTransactions({ q: '%' }).total, 0);
});

test('pagination and validation', () => {
  for (let i = 1; i <= 5; i++) mkTx(`2026-01-0${i}`, -i, 'Shop');
  const page = searchTransactions({ limit: 2, offset: 2 });
  assert.equal(page.total, 5);
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].bookingDate, '2026-01-03');
  assert.throws(() => searchTransactions({ limit: 10000 }));
  assert.throws(() => searchTransactions({ from: '1.2.2026' }));
  assert.throws(() => searchTransactions({ from: '2026-99-99' }));
  assert.throws(() => searchTransactions({ to: '2026-02-30' }));
});

test('overlapping imports are collapsed to one row per group by default', () => {
  const group = crypto.randomUUID();
  const first = mkTx('2026-10-03', -30, 'Cafe', '', group, '2026-10-04T00:00:00.000Z');
  mkTx('2026-10-03', -30, 'Cafe', '', group, '2026-10-10T00:00:00.000Z');
  mkTx('2026-10-04', -7, 'Kiosk');

  const res = searchTransactions({});
  assert.equal(res.total, 2);
  assert.equal(res.items.find((t) => t.counterpartyName === 'Cafe')?.id, first);

  assert.equal(searchTransactions({ includeDuplicates: true }).total, 3);
});

test('filters by account and by the latest category decision only', () => {
  const food = mkCategory('Food');
  const fun = mkCategory('Fun');
  const other = mkAccount('Savings');
  const recategorized = mkTx('2026-03-01', -20, 'Cinema');
  categorize(recategorized, food, '2026-03-01T10:00:00Z');
  categorize(recategorized, fun, '2026-03-02T10:00:00Z'); // the user changed their mind
  const groceries = mkTx('2026-03-02', -30, 'Market');
  categorize(groceries, food, '2026-03-02T10:00:00Z');
  mkTx('2026-03-03', -5, 'Kiosk', '', null, new Date().toISOString(), other);

  assert.deepEqual(searchTransactions({ categoryId: food }).items.map((t) => t.counterpartyName), ['Market']);
  const [cinema] = searchTransactions({ categoryId: fun }).items;
  assert.equal(cinema.counterpartyName, 'Cinema');
  assert.equal(cinema.categoryName, 'Fun');

  assert.deepEqual(searchTransactions({ accountId: other }).items.map((t) => t.accountName), ['Savings']);
  assert.equal(searchTransactions({ accountId: accountId }).total, 2);
});
