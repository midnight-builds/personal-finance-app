import './setup/testDb.js';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import {
  DEMO_CHECKING_OPENING,
  DEMO_SAVINGS_OPENING,
  demoCheckingRows,
  demoSavingsRows,
  seedDemo,
  type DemoRow,
} from '../src/demo/demoData.js';
import { daysBefore } from '../src/ledger.js';
import { detectPatterns } from '../src/patterns.js';
import { searchTransactions } from '../src/transactionSearch.js';
import { listAccounts } from '../src/accounts.js';
import { listTransactions } from '../src/query.js';
import { resetDb } from './setup/resetDb.js';

// Characterization of pattern detection, transaction search, the account list
// and the transaction list's recurring flags on the Ledger. The demo plan is
// the oracle: the overlapping month's duplicate copies count once and the
// savings transfers never count as spending.
const ANCHOR = '2026-11-05';
const checking = demoCheckingRows(ANCHOR);
const savings = demoSavingsRows(ANCHOR);
const isTransfer = (r: DemoRow) => r.counterparty.startsWith('Oma ');
const sum = (rows: Array<{ amount: number }>) => Math.round(rows.reduce((s, r) => s + r.amount * 100, 0)) / 100;
// The second checking export repeats the whole month before the anchor month.
const overlap = checking.filter((r) => r.date.startsWith('2026-10'));

let accounts: { checking: string; savings: string };

type PatternRow = {
  id: string;
  counterparty_name: string;
  pattern_type: string;
  occurrence_count: number;
  interval_days: number;
  typical_amount: number;
  first_seen: string;
  last_seen: string;
  is_active: number;
  user_confirmed: number | null;
};
const patterns = () =>
  db.prepare('SELECT * FROM recurring_patterns ORDER BY counterparty_name').all() as PatternRow[];
const pendingConfirmations = () =>
  db
    .prepare(`SELECT counterparty_name, typical_month, typical_amount FROM pattern_confirmations WHERE status = 'pending' ORDER BY counterparty_name`)
    .all()
    .map((r) => ({ ...r })) as Array<{ counterparty_name: string; typical_month: number; typical_amount: number }>;

before(async () => {
  resetDb();
  ({ accountIds: accounts } = await seedDemo(ANCHOR));
  // The import already ran detection with the real clock; start from a clean slate.
  db.exec('DELETE FROM recurring_patterns; DELETE FROM pattern_confirmations;');
  detectPatterns(accounts.checking, ANCHOR);
  detectPatterns(accounts.savings, ANCHOR);
});

test('patterns: monthly bills count each payment once', () => {
  const window = checking.filter((r) => r.date >= daysBefore(ANCHOR, 180) && r.amount < 0 && !isTransfer(r));
  const byName = new Map(patterns().map((p) => [p.counterparty_name, p]));
  for (const name of ['Asunto Oy Demokatu', 'Elisa Oyj', 'Netflix', 'Helen Oy']) {
    const plan = window.filter((r) => r.counterparty === name);
    const p = byName.get(name);
    assert.ok(p, `${name} detected`);
    assert.equal(p.occurrence_count, plan.length, name);
    assert.equal(p.first_seen, `${plan[0].date}T00:00:00.000Z`);
    assert.equal(p.last_seen, `${plan[plan.length - 1].date}T00:00:00.000Z`);
    assert.ok(p.interval_days >= 28 && p.interval_days <= 31, `${name} interval ${p.interval_days}`);
    assert.ok(Math.abs(p.typical_amount - Math.abs(sum(plan)) / plan.length) < 1e-9, `${name} amount`);
  }
  assert.equal(byName.get('Netflix')!.pattern_type, 'subscription');
  assert.equal(byName.get('Asunto Oy Demokatu')!.pattern_type, 'recurring');
});

test('patterns: own-account transfers are never recurring spend', () => {
  const names = patterns().map((p) => p.counterparty_name);
  assert.ok(names.length > 0);
  assert.ok(!names.some((n) => n.startsWith('Oma ')), names.join(', '));
});

test('patterns: a one-off large payment becomes a confirmation candidate, even when imported twice', () => {
  // Verkkokauppa.com falls in the overlapping month: two copies, one purchase.
  assert.ok(overlap.some((r) => r.counterparty === 'Verkkokauppa.com'));
  const patterned = new Set(patterns().map((p) => p.counterparty_name));
  const expenses = checking.filter((r) => r.amount < 0 && !isTransfer(r));
  const singles = expenses.filter(
    (r) =>
      Math.abs(r.amount) >= 80 &&
      !patterned.has(r.counterparty) &&
      expenses.filter((o) => o.counterparty === r.counterparty && Math.abs(o.amount) >= 80).length === 1
  );
  assert.deepEqual(
    pendingConfirmations(),
    singles
      .map((r) => ({ counterparty_name: r.counterparty, typical_month: Number(r.date.slice(5, 7)), typical_amount: -r.amount }))
      .sort((a, b) => a.counterparty_name.localeCompare(b.counterparty_name))
  );
});

test('patterns: re-running detection adds nothing and keeps user decisions', () => {
  db.prepare(
    `INSERT INTO recurring_patterns (id, created_at, updated_at, account_id, counterparty_name, pattern_type, interval_days,
       typical_amount, currency, first_seen, last_seen, occurrence_count, is_active, typical_month, user_confirmed)
     VALUES ('user-off', 'x', 'x', ?, 'Kuntosali Demo', 'annual', 365, 300, 'EUR', 'x', 'x', 1, 0, 3, 1)`
  ).run(accounts.checking);
  const before = patterns();
  const confirmations = pendingConfirmations();
  detectPatterns(accounts.checking, ANCHOR);
  detectPatterns(accounts.savings, ANCHOR);
  const after = patterns();
  assert.deepEqual(
    after.map(({ id, counterparty_name, occurrence_count, is_active }) => ({ id, counterparty_name, occurrence_count, is_active })),
    before.map(({ id, counterparty_name, occurrence_count, is_active }) => ({ id, counterparty_name, occurrence_count, is_active }))
  );
  assert.deepEqual(pendingConfirmations(), confirmations);
  db.prepare(`DELETE FROM recurring_patterns WHERE id = 'user-off'`).run();
});

test('search: counts each transaction once and leaves transfers out', () => {
  const plan = [...checking, ...savings].filter((r) => !isTransfer(r));
  const all = searchTransactions({ limit: 500 });
  assert.equal(all.total, plan.length);
  assert.equal(sum(all.items), sum(plan));
  assert.ok(all.items.every((i) => !i.isTransfer));

  const withTransfers = searchTransactions({ includeTransfers: true, limit: 500 });
  assert.equal(withTransfers.total, checking.length + savings.length);
  assert.equal(withTransfers.items.filter((i) => i.isTransfer).length, [...checking, ...savings].filter(isTransfer).length);
});

test('search: every copy of a duplicated transfer is a transfer', () => {
  const dupes = searchTransactions({ includeDuplicates: true, limit: 500 });
  assert.equal(dupes.total, checking.length + savings.length - [...checking, ...savings].filter(isTransfer).length + overlap.filter((r) => !isTransfer(r)).length);
  assert.ok(!dupes.items.some((i) => i.counterpartyName?.startsWith('Oma ')));

  const everything = searchTransactions({ includeDuplicates: true, includeTransfers: true, limit: 500 });
  assert.equal(everything.total, checking.length + savings.length + overlap.length);
  const transferRows = everything.items.filter((i) => i.counterpartyName?.startsWith('Oma '));
  assert.ok(transferRows.length > [...checking, ...savings].filter(isTransfer).length, 'duplicate transfer copies are listed');
  assert.ok(transferRows.every((i) => i.isTransfer));
});

test('search: filters, newest-first order and paging', () => {
  const all = searchTransactions({ limit: 500 }).items;
  for (let k = 1; k < all.length; k++) {
    const [a, b] = [all[k - 1], all[k]];
    assert.ok(a.bookingDate! > b.bookingDate! || (a.bookingDate === b.bookingDate && a.id < b.id), `order at ${k}`);
  }
  const paged = [0, 1, 2, 3, 4, 5].flatMap((page) => searchTransactions({ limit: 20, offset: page * 20 }).items);
  assert.deepEqual(paged.map((i) => i.id), all.map((i) => i.id));

  // Case-insensitive for ASCII, like SQLite LIKE.
  const markets = checking.filter((r) => /market/i.test(r.counterparty));
  assert.equal(searchTransactions({ q: 'MARKET', limit: 500 }).total, markets.length);

  const october = searchTransactions({ from: '2026-10-01', to: '2026-10-31', maxAmount: -100, limit: 500 });
  assert.deepEqual(
    october.items.map((i) => i.amount).sort((a, b) => a - b),
    overlap.filter((r) => !isTransfer(r) && r.amount <= -100).map((r) => r.amount).sort((a, b) => a - b)
  );
  assert.ok(october.items.every((i) => i.bookingDate?.startsWith('2026-10') && i.accountName === 'Käyttötili'));

  const savingsOnly = searchTransactions({ accountId: accounts.savings, includeTransfers: true, limit: 500 });
  assert.equal(savingsOnly.total, savings.length);
});

test('accounts: latest balance per the Ledger, snapshot date in stored form', () => {
  const [cAcc, sAcc] = listAccounts();
  assert.equal(cAcc.id, accounts.checking);
  assert.equal(cAcc.balance, sum([{ amount: DEMO_CHECKING_OPENING }, ...checking, { amount: -40 }]));
  assert.equal(cAcc.balance_date, `${checking[checking.length - 1].date}T00:00:00.000Z`);
  assert.equal(cAcc.currency, 'EUR');
  assert.equal(sAcc.balance, sum([{ amount: DEMO_SAVINGS_OPENING }, ...savings]));
  assert.equal(cAcc.account_subtype, 'checking');
});

test('transaction list: shows every row, recurring flags count each payment once', () => {
  const rows = listTransactions();
  const stored = (db.prepare('SELECT COUNT(*) AS n FROM normalized_transactions').get() as { n: number }).n;
  assert.equal(rows.length, Math.min(200, stored));
  const netflix = rows.filter((r) => r.counterpartyName === 'Netflix');
  assert.ok(netflix.length > checking.filter((r) => r.counterparty === 'Netflix').length, 'duplicate copies are listed');
  assert.ok(netflix.every((r) => r.recurringMonthly && !r.recurringWeekly && !r.recurringDaily));
  // Two Spotify payments are not yet a recurring series.
  assert.ok(rows.filter((r) => r.counterpartyName === 'Spotify').every((r) => !r.recurringMonthly));
});
