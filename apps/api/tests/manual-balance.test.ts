import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Fastify from 'fastify';

import { db } from '../src/db.js';
import { listAccounts } from '../src/accounts.js';
import { balanceHistory } from '../src/balanceHistory.js';
import { getSummary } from '../src/summary.js';
import { routes } from '../src/routes/index.js';
import { resetDb } from './setup/resetDb.js';

// A balance adjustment corrects a balance the bank reported; an account without
// one gets its first balance as a balance observation instead (a manual
// snapshot; balance-observations.test.ts covers the change sets). An adjustment
// the Ledger cannot use is refused or flagged, never silently dropped.

const app = Fastify();
await app.register(routes);
after(() => app.close());

beforeEach(() => resetDb());

function account(name: string, subtype: 'checking' | 'savings' | 'credit_card') {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    new Date().toISOString(),
    name,
    null,
    'bank',
    subtype
  );
  return id;
}

/** A transaction booked that day, without a balance (a card export has no Saldo). */
function bookedOn(accountId: string, date: string) {
  const now = new Date().toISOString();
  const session = crypto.randomUUID();
  db.prepare(
    'INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(session, now, 'test', 'csv', session, 1, session);
  db.prepare(
    `INSERT INTO normalized_transactions (id, created_at, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', ?)`
  ).run(crypto.randomUUID(), now, session, accountId, `${date}T00:00:00.000Z`, date, -10, 'Testikauppa');
}

function importedSnapshot(accountId: string, date: string, balance: number) {
  db.prepare('INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)').run(
    crypto.randomUUID(),
    new Date().toISOString(),
    accountId,
    date,
    balance,
    'EUR'
  );
}

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
/** A balance observation from the web UI; a liability's debt is stated positive. */
const observe = (accountId: string, date: string, amount: unknown) =>
  post(`/accounts/${encodeURIComponent(accountId)}/balance-observations`, { date, amount });

test('an adjustment on a credit card without any balance is refused, not stored', async () => {
  const card = account('Testikortti', 'credit_card');
  bookedOn(card, '2026-10-20');

  const res = await post('/balance-adjustments', { accountId: card, date: '2026-10-20', amount: -500 });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'balance_snapshot_missing');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM balance_adjustments').get() as { n: number }).n, 0);
});

test('an adjustment on a checking account without any balance is refused too', async () => {
  const checking = account('Testikäyttötili', 'checking');

  const res = await post('/balance-adjustments', { accountId: checking, date: '2026-10-20', amount: 25 });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'balance_snapshot_missing');
});

test('an adjustment on an unknown account is 404', async () => {
  const res = await post('/balance-adjustments', { accountId: 'nope', date: '2026-10-20', amount: 25 });
  assert.equal(res.statusCode, 404);
});

test("a credit card's observed debt is debt in accounts, summary and balance history alike", async () => {
  const card = account('Testikortti', 'credit_card');
  const checking = account('Testikäyttötili', 'checking');
  bookedOn(card, '2026-10-20');
  importedSnapshot(checking, '2026-10-20', 1000);
  bookedOn(checking, '2026-10-20');

  const res = await observe(card, '2026-10-20', 600);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().observation.after.balance, -600);
  assert.equal(res.json().observation.after.debt, 600);
  assert.equal(res.json().observation.after.currency, 'EUR');

  const listed = listAccounts().find((a) => a.id === card)!;
  assert.equal(listed.balance, -600);
  assert.equal(String(listed.balance_date).slice(0, 10), '2026-10-20');

  const summary = getSummary('2026-10-20');
  assert.equal(summary.isComplete, true);
  assert.equal(summary.missingBalanceAccountCount, 0);
  assert.equal(summary.totalBalance, 400);
  assert.equal(summary.accounts.find((a) => a.id === card)!.balance, -600);

  const history = balanceHistory({ interval: 'day', from: '2026-10-19', to: '2026-10-20' });
  const [before, on] = history.points;
  assert.equal(before.accounts.find((a) => a.accountId === card)!.balance, null, 'nothing carried back before the observation');
  assert.equal(before.isComplete, false);
  assert.equal(on.accounts.find((a) => a.accountId === card)!.balance, -600);
  assert.equal(on.liabilities, 600);
  assert.equal(on.netWorth, 400);
  assert.equal(on.isComplete, true);
  assert.equal(history.accounts.find((a) => a.id === card)!.knownFrom, '2026-10-20');
});

test('the snapshot list tells an observation from an imported balance', async () => {
  const checking = account('Testikäyttötili', 'checking');
  importedSnapshot(checking, '2026-10-01', 1000);
  await observe(checking, '2026-10-15', 900);

  const res = await app.inject({ method: 'GET', url: `/balance-snapshots/${checking}` });
  assert.deepEqual(
    res.json().map((s: { date: string; source: string }) => [s.date.slice(0, 10), s.source]),
    [
      ['2026-10-01', 'import'],
      ['2026-10-15', 'manual'],
    ]
  );
});

test('an observation never replaces a balance stored for the same day', async () => {
  const checking = account('Testikäyttötili', 'checking');
  importedSnapshot(checking, '2026-10-20', 1000);

  const res = await observe(checking, '2026-10-20', 5);

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'snapshot_exists');
  assert.equal(listAccounts()[0].balance, 1000);
});

test('an observation is refused for an unknown account, a future day or a bad value', async () => {
  const checking = account('Testikäyttötili', 'checking');
  assert.equal((await observe('nope', '2026-10-20', 1)).statusCode, 404);
  assert.equal((await observe(checking, '2999-01-01', 1)).json().error, 'date_in_future');
  assert.equal((await observe(checking, '20.10.2026', 1)).statusCode, 400);
  assert.equal((await observe(checking, '2026-10-20', 'x')).statusCode, 400);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM balance_snapshots').get() as { n: number }).n, 0);
});

test('an adjustment on an account with a balance corrects it and says it is applied', async () => {
  const checking = account('Testikäyttötili', 'checking');
  importedSnapshot(checking, '2026-10-20', 1000);

  const res = await post('/balance-adjustments', { accountId: checking, date: '2026-10-20', amount: -50, reason: 'korjaus' });
  assert.equal(res.statusCode, 200);

  assert.equal(listAccounts()[0].balance, 950);
  const [listed] = (await app.inject({ method: 'GET', url: '/balance-adjustments' })).json();
  assert.equal(listed.applied, true);
});

test('an adjustment dated after the latest balance waits for a later balance and says so', async () => {
  const checking = account('Testikäyttötili', 'checking');
  importedSnapshot(checking, '2026-10-20', 1000);

  const res = await post('/balance-adjustments', { accountId: checking, date: '2026-11-01', amount: -50 });
  assert.equal(res.statusCode, 200);

  assert.equal(listAccounts()[0].balance, 1000, 'not applied to an earlier balance');
  const [listed] = (await app.inject({ method: 'GET', url: '/balance-adjustments' })).json();
  assert.equal(listed.applied, false);

  importedSnapshot(checking, '2026-11-05', 1200);
  assert.equal(listAccounts()[0].balance, 1150);
  const [again] = (await app.inject({ method: 'GET', url: '/balance-adjustments' })).json();
  assert.equal(again.applied, true);
});

test('an adjustment stored before this check, on an account without a balance, is listed as not applied', async () => {
  const card = account('Testikortti', 'credit_card');
  db.prepare('INSERT INTO balance_adjustments (id, created_at, account_id, date, amount, reason) VALUES (?, ?, ?, ?, ?, ?)').run(
    crypto.randomUUID(),
    new Date().toISOString(),
    card,
    '2026-10-20',
    -500,
    null
  );

  const [listed] = (await app.inject({ method: 'GET', url: '/balance-adjustments' })).json();
  assert.equal(listed.applied, false);
});
