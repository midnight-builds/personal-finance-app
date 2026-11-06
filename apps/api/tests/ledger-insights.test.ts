import './setup/testDb.js';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import {
  DEMO_SAVINGS_IBAN,
  DEMO_SAVINGS_OPENING,
  demoCheckingRows,
  demoSavingsRows,
  seedDemo,
  type DemoRow,
} from '../src/demo/demoData.js';
import { daysBefore, ledgerTotals } from '../src/ledger.js';
import { getInsights } from '../src/insights.js';
import { runBriefing } from '../src/briefing.js';
import { getSummary } from '../src/summary.js';
import { createBalanceAdjustment } from '../src/balanceAdjustments.js';
import { resetDb } from './setup/resetDb.js';

// Characterization of insights and the import briefing on the Ledger. The demo
// plan is the oracle: the overlapping month's duplicate copies count once, and
// transfers between own accounts are never spending.
const ANCHOR = '2026-11-05';
const checking = demoCheckingRows(ANCHOR);
const savings = demoSavingsRows(ANCHOR);
const isTransfer = (r: DemoRow) => r.counterparty.startsWith('Oma ');
const sum = (rows: Array<{ amount: number }>) => Math.round(rows.reduce((s, r) => s + r.amount * 100, 0)) / 100;
const fromTo = (rows: DemoRow[], from: string, to: string) => rows.filter((r) => r.date >= from && r.date <= to);
const spend = (rows: DemoRow[]) => rows.filter((r) => r.amount < 0 && !isTransfer(r));

let savingsId = '';
const counterpartyOf = (id: string) =>
  (db.prepare('SELECT counterparty_name AS c FROM normalized_transactions WHERE id = ?').get(id) as { c: string }).c;

type Finding = { finding_type: string; title: string; description: string; transaction_ids: string | null; metadata: string | null };
async function briefing(asOf: string): Promise<Finding[]> {
  const id = await runBriefing('test', asOf);
  return db
    .prepare('SELECT * FROM insight_findings WHERE briefing_session_id = ? ORDER BY rowid')
    .all(id) as Finding[];
}

before(async () => {
  delete process.env.OPENAI_API_KEY;
  resetDb();
  const seeded = await seedDemo(ANCHOR);
  savingsId = seeded.accountIds.savings;
  db.prepare(`UPDATE accounts SET account_subtype = 'savings' WHERE iban = ?`).run(DEMO_SAVINGS_IBAN);
  db.prepare(
    `INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key)
     VALUES ('test', ?, 'test', 'csv', 'x', 0, 'test')`
  ).run(new Date().toISOString());
});

test('insights: large expenses of the last 30 days, each once, no transfers', () => {
  const expected = spend(fromTo(checking, daysBefore(ANCHOR, 30), ANCHOR))
    .filter((r) => r.amount <= -200)
    .sort((a, b) => a.amount - b.amount);
  assert.ok(expected.some((r) => r.date.startsWith('2026-10')), 'window reaches the overlapping month');
  const large = getInsights(ANCHOR).filter((i) => i.id.startsWith('large-expense-'));
  assert.deepEqual(
    large.map((i) => [i.title, i.description]),
    expected.map((r) => [`Iso yksittäinen meno: ${r.counterparty}`, `${(-r.amount).toFixed(2)} EUR (30 pv)`])
  );
  assert.deepEqual(large.map((i) => counterpartyOf(i.transactionIds[0])), expected.map((r) => r.counterparty));
});

test('insights: windows end on the day asked for', () => {
  const titles = (asOf: string) => getInsights(asOf).map((i) => i.title);
  // The laptop is bought on 2026-10-19.
  assert.ok(!titles('2026-10-18').includes('Iso yksittäinen meno: Verkkokauppa.com'));
  assert.ok(titles('2026-10-19').includes('Iso yksittäinen meno: Verkkokauppa.com'));
});

test('insights: two coffees a month are not repeated small purchases', () => {
  // The overlapping month's coffees arrive twice; counted once they are two, under the threshold of three.
  const coffees = fromTo(checking, daysBefore(ANCHOR, 30), ANCHOR).filter((r) => r.counterparty === 'Kahvila Papu');
  assert.equal(coffees.length, 2);
  assert.ok(!getInsights(ANCHOR).some((i) => i.id === 'small-Kahvila Papu'));
});

test('insights: rising categories add up like the Ledger', () => {
  const rising = getInsights(ANCHOR).filter((i) => i.id.startsWith('trend-'));
  assert.ok(rising.length > 0);
  const last3 = new Map(ledgerTotals('category', { from: daysBefore(ANCHOR, 90), to: ANCHOR }).map((t) => [t.label, t]));
  for (const i of rising) {
    const cat = i.title.replace('Kategoria kasvaa: ', '');
    assert.ok(i.description.startsWith(`Kulut viime 3 kk ${(-last3.get(cat)!.net).toFixed(2)} EUR`), i.description);
    assert.equal(new Set(i.transactionIds).size, i.transactionIds.length);
  }
});

test('insights: monthly spike of the last full month, recurring charges left out', () => {
  // October vs July–September. Charges with the same merchant and amount in 3+ of
  // those months are recurring; the laptop and the new Spotify are not.
  const months = fromTo(checking, '2026-07-01', '2026-10-31').filter((r) => r.amount < 0 && !isTransfer(r));
  const monthsOf = new Map<string, Set<string>>();
  for (const r of months) {
    const k = `${r.counterparty}|${r.amount}`;
    monthsOf.set(k, (monthsOf.get(k) ?? new Set()).add(r.date.slice(0, 7)));
  }
  const counted = months.filter((r) => monthsOf.get(`${r.counterparty}|${r.amount}`)!.size < 3);
  const monthSum = (ym: string) => -sum(counted.filter((r) => r.date.startsWith(ym)));
  const prevAvg = (monthSum('2026-07') + monthSum('2026-08') + monthSum('2026-09')) / 3;

  const spike = getInsights(ANCHOR).find((i) => i.id.startsWith('monthly-spike-'));
  assert.ok(spike);
  assert.equal(spike.id, 'monthly-spike-2026-10');
  assert.equal(
    spike.description,
    `Kulut 2026-10: ${monthSum('2026-10').toFixed(2)} EUR (edellisten 3 kk keskiarvo ${prevAvg.toFixed(2)} EUR)`
  );
  assert.deepEqual(spike.transactionIds.map(counterpartyOf), ['Verkkokauppa.com', 'Spotify']);
});

test('briefing: one-off purchases are counted once and transfers are not purchases', async () => {
  const oneOffs = (await briefing(ANCHOR)).filter((f) => f.finding_type === 'one_off_impact');
  const ids = oneOffs.flatMap((f) => JSON.parse(f.transaction_ids!) as string[]);
  assert.equal(new Set(ids).size, ids.length);
  const names = ids.map(counterpartyOf);
  assert.deepEqual(names.filter((n) => n === 'Verkkokauppa.com'), ['Verkkokauppa.com']);
  assert.ok(!names.some((n) => n.startsWith('Oma ')));
});

test('briefing: spending anomalies compare with the average over the history there is', async () => {
  // September is the demo's grocery spike month; the history before it starts in June.
  const asOf = '2026-09-30';
  const baselineEnd = daysBefore(asOf, 30);
  const covered = Math.round((Date.parse(baselineEnd) - Date.parse('2026-06-01')) / 86400000) + 1;
  const anomalies = (await briefing(asOf)).filter((f) => f.finding_type === 'spending_anomaly');
  assert.ok(anomalies.length > 0);
  const last30 = new Map(ledgerTotals('category', { from: daysBefore(asOf, 29), to: asOf }).map((t) => [t.label, t]));
  const before = new Map(ledgerTotals('category', { to: baselineEnd }).map((t) => [t.label, t]));
  for (const f of anomalies) {
    const m = JSON.parse(f.metadata!) as { category: string; spend30d: number; avg30d: number };
    assert.equal(m.spend30d, -last30.get(m.category)!.expense);
    assert.equal(m.avg30d, Math.round((-before.get(m.category)!.expense / covered) * 30 * 100) / 100);
    assert.ok(m.spend30d > 2 * m.avg30d);
  }
});

test('briefing: an ordinary month is not an anomaly', async () => {
  // Every category spends about its usual amount in the 30 days to the anchor.
  const anomalies = (await briefing(ANCHOR)).filter((f) => f.finding_type === 'spending_anomaly');
  assert.deepEqual(anomalies.map((f) => f.title), []);
});

test('briefing: savings progress over the 30 days up to the latest snapshot', async () => {
  // The latest snapshot is the October deposit; 30 days earlier the September one.
  const balances = savings.map((_, i) => sum([{ amount: DEMO_SAVINGS_OPENING }, ...savings.slice(0, i + 1)]));
  const [latest, monthAgo] = [balances[balances.length - 1], balances[balances.length - 2]];
  const [f] = (await briefing(ANCHOR)).filter((x) => x.finding_type === 'savings_progress');
  assert.deepEqual(JSON.parse(f.metadata!), { currentBalance: latest, delta: sum([{ amount: latest }, { amount: -monthAgo }]) });
  assert.match(f.description, /viimeisen 30 päivän aikana/);
});

test('briefing: savings balances include corrections, like the summary', async () => {
  // Before the Ledger the briefing read raw snapshots and ignored corrections.
  const octoberDeposit = savings[savings.length - 1].date;
  createBalanceAdjustment({ accountId: savingsId, date: octoberDeposit, amount: 25, reason: 'test' });
  const [f] = (await briefing(ANCHOR)).filter((x) => x.finding_type === 'savings_progress');
  const meta = JSON.parse(f.metadata!) as { currentBalance: number; delta: number };
  const summaryBalance = getSummary(ANCHOR).accounts.find((a) => a.id === savingsId)!.balance;
  assert.equal(meta.currentBalance, summaryBalance);
  assert.equal(meta.delta, 325);
});
