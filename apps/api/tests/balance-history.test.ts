import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Fastify from 'fastify';

import { db } from '../src/db.js';
import { balanceHistory } from '../src/balanceHistory.js';
import { daysBefore } from '../src/ledger.js';
import { routes } from '../src/routes/index.js';
import { resetDb } from './setup/resetDb.js';

const app = Fastify();
await app.register(routes);
after(() => app.close());

beforeEach(() => resetDb());

function account(name: string, subtype: 'checking' | 'savings' | 'credit_card' = 'checking') {
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

/** A day's closing balance, as an import stores it, and a transaction booked that day. */
function balanceOn(accountId: string, date: string, balance: number) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)').run(
    crypto.randomUUID(),
    now,
    accountId,
    date,
    balance,
    'EUR'
  );
  bookedOn(accountId, date);
}

/** A transaction booked that day, without a balance (a row with a blank Saldo). */
function bookedOn(accountId: string, date: string) {
  const now = new Date().toISOString();
  const session = crypto.randomUUID();
  db.prepare(
    'INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(session, now, 'test', 'csv', session, 1, session);
  db.prepare(
    `INSERT INTO normalized_transactions (id, created_at, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', ?)`
  ).run(crypto.randomUUID(), now, session, accountId, `${date}T00:00:00.000Z`, date, -1, 'Testi');
}

const point = (h: ReturnType<typeof balanceHistory>, date: string) => {
  const p = h.points.find((x) => x.date === date);
  assert.ok(p, `point ${date} in ${h.points.map((x) => x.date).join(', ')}`);
  return p;
};
const balanceOf = (p: ReturnType<typeof point>, accountId: string) => p.accounts.find((a) => a.accountId === accountId)!.balance;

test('monthly points fall on month ends and the last one on `to`', () => {
  const checking = account('Käyttötili');
  balanceOn(checking, '2026-08-01', 100);
  balanceOn(checking, '2026-10-25', 300);
  const h = balanceHistory({ from: '2026-08-15', to: '2026-10-20', interval: 'month' });
  assert.deepEqual(h.points.map((p) => p.date), ['2026-08-31', '2026-09-30', '2026-10-20']);
});

test('weekly points fall on Sundays and daily points on every day', () => {
  const checking = account('Käyttötili');
  balanceOn(checking, '2026-09-01', 100);
  balanceOn(checking, '2026-10-31', 100);
  const weekly = balanceHistory({ from: '2026-10-01', to: '2026-10-14', interval: 'week' });
  assert.deepEqual(weekly.points.map((p) => p.date), ['2026-10-04', '2026-10-11', '2026-10-14']);
  const daily = balanceHistory({ from: '2026-10-01', to: '2026-10-03', interval: 'day' });
  assert.deepEqual(daily.points.map((p) => p.date), ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('a balance carries over days without transactions, from the latest snapshot', () => {
  const checking = account('Käyttötili');
  balanceOn(checking, '2026-09-10', 1000);
  balanceOn(checking, '2026-10-05', 800);
  const h = balanceHistory({ from: '2026-09-01', to: '2026-10-05', interval: 'month' });
  assert.equal(balanceOf(point(h, '2026-09-30'), checking), 1000);
  assert.equal(balanceOf(point(h, '2026-10-05'), checking), 800);
});

test('an account first seen mid-period is unknown before, not zero, and the point is incomplete', () => {
  const checking = account('Käyttötili');
  const savings = account('Säästötili', 'savings');
  balanceOn(checking, '2026-07-01', 1000);
  balanceOn(checking, '2026-10-31', 1000);
  balanceOn(savings, '2026-09-15', 5000);
  balanceOn(savings, '2026-10-31', 5000);
  const h = balanceHistory({ from: '2026-08-01', to: '2026-10-31', interval: 'month' });

  const aug = point(h, '2026-08-31');
  assert.equal(balanceOf(aug, savings), null);
  assert.equal(aug.isComplete, false);
  assert.deepEqual(aug.coverage, { includedAccountIds: [checking], missingAccountIds: [savings] });
  assert.equal(aug.netWorth, 1000);

  const oct = point(h, '2026-10-31');
  assert.equal(oct.isComplete, true);
  assert.equal(oct.netWorth, 6000);
});

test('an account without any balance is missing from every point', () => {
  const checking = account('Käyttötili');
  const card = account('Luottokortti', 'credit_card');
  balanceOn(checking, '2026-09-01', 500);
  balanceOn(checking, '2026-10-31', 500);
  const h = balanceHistory({ from: '2026-09-01', to: '2026-10-31', interval: 'month' });
  for (const p of h.points) {
    assert.equal(balanceOf(p, card), null);
    assert.equal(p.isComplete, false);
    assert.deepEqual(p.coverage.missingAccountIds, [card]);
  }
  const card0 = h.accounts.find((a) => a.id === card)!;
  assert.equal(card0.knownFrom, null);
});

test('days after an account’s imported data are unknown, not its last balance', () => {
  const checking = account('Käyttötili');
  const savings = account('Säästötili', 'savings');
  balanceOn(checking, '2026-08-01', 1000);
  balanceOn(checking, '2026-10-31', 1000);
  balanceOn(savings, '2026-08-01', 2000);
  balanceOn(savings, '2026-09-10', 2500); // its last export ends here
  const h = balanceHistory({ from: '2026-08-01', to: '2026-10-31', interval: 'month' });
  assert.equal(balanceOf(point(h, '2026-09-30'), savings), null);
  assert.equal(h.accounts.find((a) => a.id === savings)!.knownUntil, '2026-09-10');
  assert.equal(point(h, '2026-08-31').netWorth, 3000);
});

test('a transfer between own accounts does not change net worth', () => {
  const checking = account('Käyttötili');
  const savings = account('Säästötili', 'savings');
  balanceOn(checking, '2026-09-01', 1000);
  balanceOn(savings, '2026-09-01', 0);
  balanceOn(checking, '2026-10-10', 700);
  balanceOn(savings, '2026-10-10', 300);
  const h = balanceHistory({ from: '2026-09-01', to: '2026-10-10', interval: 'month' });
  assert.equal(point(h, '2026-09-30').netWorth, 1000);
  assert.equal(point(h, '2026-10-10').netWorth, 1000);
});

test('credit card debt is a liability', () => {
  const checking = account('Käyttötili');
  const card = account('Luottokortti', 'credit_card');
  balanceOn(checking, '2026-10-01', 2000);
  balanceOn(card, '2026-10-01', -450);
  const p = point(balanceHistory({ from: '2026-10-01', to: '2026-10-01', interval: 'day' }), '2026-10-01');
  assert.equal(p.assets, 2000);
  assert.equal(p.liabilities, 450);
  assert.equal(p.netWorth, 1550);
  assert.equal(p.isComplete, true);
});

test('investments are reported as untracked, never counted', () => {
  const checking = account('Käyttötili');
  balanceOn(checking, '2026-10-01', 100);
  const h = balanceHistory({ from: '2026-10-01', to: '2026-10-01', interval: 'day' });
  assert.deepEqual(h.untrackedAssetClasses, ['investments']);
});

test('balance adjustments are part of the balance', () => {
  const checking = account('Käyttötili');
  balanceOn(checking, '2026-10-01', 100);
  db.prepare(
    'INSERT INTO balance_adjustments (id, created_at, account_id, date, amount, reason) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), new Date().toISOString(), checking, '2026-10-01', 40, 'käteinen');
  const p = point(balanceHistory({ from: '2026-10-01', to: '2026-10-01', interval: 'day' }), '2026-10-01');
  assert.equal(p.netWorth, 140);
});

test('defaults: to = latest booking date, from = 12 months earlier, monthly', () => {
  const checking = account('Käyttötili');
  balanceOn(checking, '2025-11-01', 100);
  balanceOn(checking, '2026-10-20', 200);
  const h = balanceHistory({ interval: 'month' });
  assert.equal(h.to, '2026-10-20');
  assert.equal(h.from, '2025-10-20');
  assert.equal(h.points.at(-1)!.date, '2026-10-20');
});

test('a balance with bookings after its snapshot is unknown, not stale', () => {
  const checking = account('Käyttötili');
  balanceOn(checking, '2026-10-10', 1000);
  bookedOn(checking, '2026-10-15'); // no Saldo on these rows
  bookedOn(checking, '2026-10-20');
  const h = balanceHistory({ from: '2026-10-10', to: '2026-10-20', interval: 'day' });
  assert.equal(balanceOf(point(h, '2026-10-14'), checking), 1000);
  const late = point(h, '2026-10-15');
  assert.equal(balanceOf(late, checking), null);
  assert.equal(late.isComplete, false);
});

test('totals are unknown when no account is known, and nothing known is never complete', () => {
  const checking = account('Käyttötili');
  balanceOn(checking, '2026-10-10', 1000);
  const before = point(balanceHistory({ from: '2026-09-30', to: '2026-09-30', interval: 'day' }), '2026-09-30');
  assert.deepEqual([before.assets, before.liabilities, before.netWorth], [null, null, null]);
  assert.equal(before.isComplete, false);

  resetDb();
  const empty = point(balanceHistory({ from: '2026-09-30', to: '2026-09-30', interval: 'day' }), '2026-09-30');
  assert.equal(empty.netWorth, null);
  assert.equal(empty.isComplete, false);
});

test('at most BALANCE_HISTORY_MAX_POINTS points, `to` included', () => {
  const checking = account('Käyttötili');
  balanceOn(checking, '2026-10-01', 1);
  assert.equal(balanceHistory({ from: daysBefore('2026-10-01', 399), to: '2026-10-01', interval: 'day' }).points.length, 400);
  assert.throws(() => balanceHistory({ from: daysBefore('2026-10-01', 400), to: '2026-10-01', interval: 'day' }), /too_many_points/);
});

test('GET /balances/history validates its query and refuses too many points', async () => {
  const checking = account('Käyttötili');
  balanceOn(checking, '2026-10-01', 100);
  const ok = await app.inject({ method: 'GET', url: '/balances/history?from=2026-10-01&to=2026-10-01&interval=day' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().points.length, 1);

  assert.equal((await app.inject({ method: 'GET', url: '/balances/history?interval=year' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/balances/history?from=2026-10-02&to=2026-10-01' })).statusCode, 400);
  const tooMany = await app.inject({ method: 'GET', url: '/balances/history?from=2024-01-01&to=2026-10-01&interval=day' });
  assert.equal(tooMany.statusCode, 400);
  assert.equal(tooMany.json().error, 'too_many_points');
});
