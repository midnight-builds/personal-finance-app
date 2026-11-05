import './setup/testDb.js';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEMO_CHECKING_OPENING,
  DEMO_SAVINGS_OPENING,
  demoCheckingRows,
  demoSavingsRows,
  seedDemo,
  type DemoRow,
} from '../src/demo/demoData.js';
import { daysBefore } from '../src/ledger.js';
import { getHouseholdSummary, getSummary } from '../src/summary.js';
import { getMonthlyOverview } from '../src/monthly.js';
import { computeMonthlyForecast, getForecast } from '../src/forecast.js';
import { resetDb } from './setup/resetDb.js';

// Characterization of the reports built on the Ledger. As in ledger.test.ts,
// the demo plan is the oracle: the reports must add up to what the household
// did, with the overlapping month's duplicate copies counted once.
const ANCHOR = '2026-11-05';
const checking = demoCheckingRows(ANCHOR);
const savings = demoSavingsRows(ANCHOR);
const isTransfer = (r: DemoRow) => r.counterparty.startsWith('Oma ');
const sum = (rows: Array<{ amount: number }>) => Math.round(rows.reduce((s, r) => s + r.amount * 100, 0)) / 100;
const between = (rows: DemoRow[], after: string, upTo: string) => rows.filter((r) => r.date > after && r.date <= upTo);

before(async () => {
  resetDb();
  await seedDemo(ANCHOR);
});

test('summary: balances are the latest snapshot plus the correction', () => {
  const s = getSummary(ANCHOR);
  const [cAcc, sAcc] = s.accounts;
  assert.equal(cAcc.balance, sum([{ amount: DEMO_CHECKING_OPENING }, ...checking, { amount: -40 }]));
  assert.equal(cAcc.adjustmentSum, -40);
  assert.equal(cAcc.date, checking[checking.length - 1].date);
  assert.equal(sAcc.balance, sum([{ amount: DEMO_SAVINGS_OPENING }, ...savings]));
  assert.equal(s.totalBalance, sum([{ amount: cAcc.balance! }, { amount: sAcc.balance! }]));
  assert.equal(s.isComplete, true);
});

test('summary: balances follow the day asked for', () => {
  // The correction is dated on the anchor, so a month earlier it does not count yet.
  const [cAcc] = getSummary('2026-10-20').accounts;
  const upTo = checking.filter((r) => r.date <= '2026-10-20');
  assert.equal(cAcc.date, upTo[upTo.length - 1].date);
  assert.equal(cAcc.balance, sum([{ amount: DEMO_CHECKING_OPENING }, ...upTo]));
});

test('summary: the last 30 days count each purchase once', () => {
  // The window reaches back into the month both checking exports contain.
  const window = between(checking, daysBefore(ANCHOR, 31), ANCHOR);
  assert.ok(window.some((r) => r.date.startsWith('2026-10')));
  const s = getSummary(ANCHOR);
  assert.equal(s.monthlyNet, sum(window.filter((r) => !isTransfer(r))));
  assert.equal(s.monthlyNetWithTransfers, sum([...window, ...between(savings, daysBefore(ANCHOR, 31), ANCHOR)]));
  assert.equal(s.runwayMonths, s.monthlyNet < 0 ? s.totalBalance / -s.monthlyNet : null);
});

test('household summary uses the same balances', () => {
  const h = getHouseholdSummary(ANCHOR);
  const s = getSummary(ANCHOR);
  assert.deepEqual(h.accounts.map((a) => a.balance), s.accounts.map((a) => a.balance));
});

test('monthly: pay periods add up to the plan, overlap counted once', () => {
  // Default payday 15, flex 2: the period labelled M runs from M-14 to (M+1)-13.
  const periods = getMonthlyOverview(6, ANCHOR);
  assert.deepEqual(periods.map((p) => p.month), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  for (const p of periods) {
    const [y, m] = p.month.split('-').map(Number);
    const after = new Date(Date.UTC(y, m - 1, 13)).toISOString().slice(0, 10);
    const upTo = new Date(Date.UTC(y, m, 13)).toISOString().slice(0, 10);
    const rows = between(checking, after, upTo).filter((r) => !isTransfer(r));
    assert.equal(p.income, sum(rows.filter((r) => r.amount > 0)), p.month);
    assert.equal(p.expense, sum(rows.filter((r) => r.amount < 0)), p.month);
    assert.equal(p.net, sum(rows), p.month);
  }
});

test('monthly: every month appears once, also at the end of a long month', () => {
  // SQLite's date('2026-03-31', '-1 months') is 2026-03-03, which used to repeat March.
  assert.deepEqual(getMonthlyOverview(3, '2026-03-31').map((p) => p.month), ['2026-01', '2026-02', '2026-03']);
});

test('forecast: history is the same month a year earlier, overlap counted once', () => {
  // From August 2027 the targets are Sep–Nov 2027; history is Sep–Nov 2026.
  const forecast = getForecast('2027-08-10');
  assert.deepEqual(forecast.map((f) => f.targetMonth), ['2027-09', '2027-10', '2027-11']);
  for (const f of forecast) {
    const month = `2026-${f.targetMonth.slice(5)}`;
    const spend = checking.filter((r) => r.date.startsWith(month) && r.amount < 0 && !isTransfer(r));
    assert.equal(f.historicalAvg, -sum(spend), f.targetMonth);
  }
  assert.deepEqual(computeMonthlyForecast(2, '2027-08-10'), forecast[1]);
});

test('forecast: no earlier year, no history', () => {
  assert.deepEqual(getForecast(ANCHOR).map((f) => [f.targetMonth, f.historicalAvg]), [
    ['2026-12', 0],
    ['2027-01', 0],
    ['2027-02', 0],
  ]);
});
