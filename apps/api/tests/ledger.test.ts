import './setup/testDb.js';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEMO_CHECKING_OPENING,
  DEMO_SAVINGS_OPENING,
  demoCheckingRows,
  demoSavingsRows,
  seedDemo,
  type DemoSeedResult,
} from '../src/demo/demoData.js';
import { accountBalances, daysBefore, ledgerEntries, ledgerTotals, today } from '../src/ledger.js';
import { resetDb } from './setup/resetDb.js';

// The demo plan (rows as generated, before the import pipeline) is the oracle:
// what the Ledger reports must match what the household actually did.
const ANCHOR = '2026-11-05';
const checking = demoCheckingRows(ANCHOR);
const savings = demoSavingsRows(ANCHOR);
const isTransfer = (r: { counterparty: string }) => r.counterparty.startsWith('Oma ');
const sum = (rows: Array<{ amount: number }>) => Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;

let seed: DemoSeedResult;
before(async () => {
  resetDb();
  seed = await seedDemo(ANCHOR);
});

test('counts every real purchase once: duplicates and transfers left out', () => {
  const expected = checking.filter((r) => !isTransfer(r));
  const entries = ledgerEntries();
  assert.equal(entries.length, expected.length);
  assert.equal(sum(entries), sum(expected));
});

test('the overlapping month is not doubled', () => {
  const october = { from: '2026-10-01', to: '2026-10-31' };
  const expected = checking.filter((r) => r.date.startsWith('2026-10') && !isTransfer(r));
  assert.equal(sum(ledgerEntries(october)), sum(expected));
  // Both exports' copies are still there when asked for.
  assert.equal(ledgerEntries({ ...october, includeDuplicates: true }).length, expected.length * 2);
});

test('both copies of an overlapping transfer are transfers', () => {
  // The linker pairs only one copy of the October savings transfer.
  const copies = ledgerEntries({ from: '2026-10-16', to: '2026-10-16', includeDuplicates: true, includeTransfers: true })
    .filter((e) => e.counterparty === 'Oma säästötili');
  assert.equal(copies.length, 2);
  assert.ok(copies.every((e) => e.isTransfer));
});

test('transfers between own accounts can be included', () => {
  const entries = ledgerEntries({ includeTransfers: true });
  assert.equal(entries.length, checking.length + savings.length);
  assert.ok(entries.filter((e) => e.isTransfer).length === savings.length * 2);
});

test('scope by account and inclusive date range', () => {
  const entries = ledgerEntries({ accounts: [seed.accountIds.savings], includeTransfers: true });
  assert.equal(sum(entries), sum(savings));
  assert.deepEqual(ledgerEntries({ accounts: [] }), []);

  const day = ledgerEntries({ from: '2026-10-12', to: '2026-10-12' });
  assert.ok(day.length > 0 && day.every((e) => e.date === '2026-10-12'));
  // Same-day identical purchases are two purchases.
  assert.equal(day.filter((e) => e.counterparty === 'Kahvila Papu').length, 2);
});

test('category is the latest decision, the user overriding the rule engine', () => {
  const restaurant = ledgerEntries().filter((e) => e.counterparty === 'Ravintola Esimerkki');
  assert.ok(restaurant.length > 0);
  assert.ok(restaurant.every((e) => e.categoryName === 'Viihde ja harrastukset'));
});

test('totals per month and per category add up to the entries', () => {
  const months = ledgerTotals('month');
  assert.deepEqual(months.map((m) => m.key), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  const oct = months.find((m) => m.key === '2026-10')!;
  assert.equal(oct.income, 3200);
  assert.equal(oct.net, sum(checking.filter((r) => r.date.startsWith('2026-10') && !isTransfer(r))));

  const categories = ledgerTotals('category');
  assert.equal(sum(categories.map((c) => ({ amount: c.net }))), sum(ledgerEntries()));
  assert.ok(categories[0].expense <= categories[1].expense, 'largest spend first');
});

test('balances: latest snapshot plus adjustments, unknown before the first snapshot', () => {
  const [chk, sav] = accountBalances();
  assert.equal(chk.accountId, seed.accountIds.checking);
  assert.equal(chk.balance, Math.round((DEMO_CHECKING_OPENING + sum(checking) - 40) * 100) / 100);
  assert.equal(chk.adjustmentSum, -40);
  assert.equal(sav.balance, DEMO_SAVINGS_OPENING + sum(savings));

  const mid = accountBalances('2026-07-20');
  const upTo = (rows: typeof checking) => rows.filter((r) => r.date <= '2026-07-20');
  assert.equal(mid[0].balance, Math.round((DEMO_CHECKING_OPENING + sum(upTo(checking))) * 100) / 100);
  assert.equal(mid[1].balance, DEMO_SAVINGS_OPENING + sum(upTo(savings)));

  const beforeAny = accountBalances('2026-01-01');
  assert.ok(beforeAny.every((b) => b.balance === null && b.date === null));
});

test('days are Helsinki calendar days', () => {
  assert.equal(today(new Date('2026-11-04T22:30:00Z')), '2026-11-05');
  assert.equal(daysBefore('2026-03-01', 1), '2026-02-28');
  assert.throws(() => ledgerEntries({ from: '2026-10-01T00:00:00Z' }), /YYYY-MM-DD/);
});
