import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Fastify from 'fastify';

import { db } from '../src/db.js';
import { detectPatterns } from '../src/patterns.js';
import { activePatterns, decidePattern } from '../src/patternDecisions.js';
import { confirmPatternConfirmation, listPendingConfirmations } from '../src/patternConfirmations.js';
import { computeMonthlyForecast } from '../src/forecast.js';
import { getHouseholdSummary } from '../src/summary.js';
import { routes } from '../src/routes/index.js';
import { resetDb } from './setup/resetDb.js';

// Yearly created patterns and the annual-pattern handling they join (GLOSSARY.md,
// "Annual pattern", "Created pattern", "Lapsed pattern"). Everything here is fictional.

const ACTOR = 'agent-test';
const INSURANCE = 'Vakuutusyhtiö Turva';

const app = Fastify();
await app.register(routes);
after(() => app.close());

beforeEach(() => resetDb());

function mkAccount() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'Käyttötili', null, 'bank', 'checking');
  const session = crypto.randomUUID();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(session, new Date().toISOString(), 'test', 'csv', 'x', 1, crypto.randomUUID());
  return { account: id, session };
}
type Acct = ReturnType<typeof mkAccount>;

function charge(a: Acct, counterparty: string, amount: number, date: string) {
  const id = crypto.randomUUID();
  const raw = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(raw, now, a.session, '{}', date, amount, 'EUR');
  db.prepare('INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name, description, counterparty_iban) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, raw, a.session, a.account, date, date, amount, 'EUR', counterparty, null, null);
  return id;
}
const otherSpend = (a: Acct, date: string) => charge(a, 'Ruokakauppa Kulma', -12.3, date);

const create = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/patterns', payload: body, headers: { 'x-finance-actor': ACTOR } });
const decide = (id: string, decision: string) =>
  app.inject({ method: 'POST', url: `/patterns/${id}/decision`, payload: { decision }, headers: { 'x-finance-actor': ACTOR } });
const yearly = (a: Acct, ids: string[], extra: Record<string, unknown> = {}) =>
  create({ accountId: a.account, counterparty: INSURANCE, kind: 'recurring', interval: 'yearly', expectedAmount: 300, evidenceTransactionIds: ids, ...extra });

const rows = (counterparty = INSURANCE) =>
  db.prepare('SELECT * FROM recurring_patterns WHERE counterparty_name = ?').all(counterparty) as Array<Record<string, unknown>>;
/** Forecast of `month` (1–12) of 2027, made at the end of 2026. */
const forecastFor = (month: number) => computeMonthlyForecast(month, '2026-12-31', []);

// ── Creating ────────────────────────────────────────────────────────

test('yearly: one charge is enough; an annual pattern, confirmed by its actor, counted in its typical month', async () => {
  const a = mkAccount();
  const id = charge(a, INSURANCE, -300, '2026-03-15');
  const res = await yearly(a, [id]);
  assert.equal(res.statusCode, 200, res.body);
  const { pattern, created } = res.json();
  assert.equal(created, true);
  assert.equal(pattern.pattern_type, 'annual');
  assert.equal(pattern.interval_days, 365);
  assert.equal(pattern.typical_month, 3);
  assert.equal(pattern.origin, 'created');
  assert.equal(pattern.state, 'confirmed_recurring');
  assert.equal(pattern.decided_by, ACTOR);
  assert.equal(pattern.lapsed, false);

  const march = forecastFor(3);
  assert.deepEqual(march.annualItems.map((i) => [i.counterparty, i.amount, i.month, i.patternId, i.origin]), [
    [INSURANCE, 300, 3, pattern.id, 'created'],
  ]);
  assert.equal(march.projectedTotal, 300);
  assert.deepEqual(march.knownFixed, [], 'not a monthly fixed cost');
  assert.deepEqual(forecastFor(4).annualItems, []);
  assert.equal(getHouseholdSummary('2026-12-31').monthlySubscriptions, 0);
});

test('yearly: evidence charges must be at least 240 days apart and within 25 % of the expected amount', async () => {
  const a = mkAccount();
  const early = charge(a, INSURANCE, -300, '2025-09-01');
  const late = charge(a, INSURANCE, -300, '2026-03-15');
  let res = await yearly(a, [early, late]);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'evidence_interval_mismatch');
  assert.equal(res.json().details.minDaysApart, 240);

  const b = mkAccount();
  const last = charge(b, INSURANCE, -370, '2025-03-20'); // +23 %
  const now = charge(b, INSURANCE, -300, '2026-03-15'); // 360 days later
  res = await yearly(b, [last, now]);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().pattern.occurrence_count, 2);

  const c = mkAccount();
  const tooMuch = charge(c, INSURANCE, -380, '2026-03-15'); // +27 %
  res = await yearly(c, [tooMuch]);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'evidence_amount_mismatch');
  assert.equal(res.json().details.tolerance, 0.25);
  assert.equal(rows().length, 1);
});

// ── One pattern per account and counterparty ──────────────────────

test('yearly: an active detected annual pattern is a conflict; it can be decided instead, also rejected', async () => {
  const a = mkAccount();
  charge(a, INSURANCE, -300, '2025-03-15');
  const id = charge(a, INSURANCE, -310, '2026-03-14');
  detectPatterns(a.account, '2026-12-31');
  const [detected] = rows();
  assert.equal(detected.pattern_type, 'annual');

  const res = await yearly(a, [id]);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'pattern_exists');
  assert.equal(res.json().details.patternId, detected.id);
  assert.equal(rows().length, 1);

  const confirmed = await decide(detected.id as string, 'subscription');
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  assert.equal(confirmed.json().pattern.state, 'confirmed_subscription');
  assert.equal(confirmed.json().pattern.pattern_type, 'annual', 'a decision on an annual pattern keeps it annual');
  assert.equal(forecastFor(3).annualItems.length, 1);

  const rejected = await decide(detected.id as string, 'not_recurring');
  assert.equal(rejected.json().pattern.state, 'rejected');
  assert.deepEqual(forecastFor(3).annualItems, []);
  detectPatterns(a.account, '2026-12-31');
  assert.deepEqual(forecastFor(3).annualItems, [], 'the rejection survives detection');
  assert.equal(rows().length, 1);
});

test('yearly: an annual pattern confirmed through a confirmation is a conflict too', async () => {
  const a = mkAccount();
  const id = charge(a, INSURANCE, -300, '2026-03-15');
  detectPatterns(a.account, '2026-12-31');
  const [pending] = listPendingConfirmations();
  confirmPatternConfirmation(pending.id);
  const res = await yearly(a, [id]);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'pattern_exists');
  assert.equal(rows().length, 1);
});

test('yearly: creating resolves the pending annual confirmations of the counterparty, on every account; never asked again', async () => {
  const a = mkAccount();
  const id = charge(a, INSURANCE, -300, '2026-03-15');
  const b = mkAccount();
  charge(b, INSURANCE, -300, '2025-05-15'); // the same payment from another account a year before
  charge(b, 'Lehtitalo Sivu', -120, '2026-05-15'); // another counterparty: still asked
  detectPatterns(a.account, '2026-12-31');
  detectPatterns(b.account, '2026-12-31');
  assert.equal(listPendingConfirmations().length, 3);

  assert.equal((await yearly(a, [id])).statusCode, 200);
  assert.deepEqual(listPendingConfirmations().map((c) => c.counterparty_name), ['Lehtitalo Sivu']);
  const statuses = db.prepare('SELECT status, resolved_at FROM pattern_confirmations WHERE counterparty_name = ?').all(INSURANCE) as Array<{ status: string; resolved_at: string | null }>;
  assert.deepEqual(statuses.map((s) => s.status), ['superseded', 'superseded']);
  assert.ok(statuses.every((s) => s.resolved_at));

  detectPatterns(a.account, '2026-12-31');
  detectPatterns(b.account, '2026-12-31');
  assert.deepEqual(listPendingConfirmations().map((c) => c.counterparty_name), ['Lehtitalo Sivu']);
  assert.equal(rows().length, 1);
  assert.deepEqual(forecastFor(3).annualItems.map((i) => i.counterparty), [INSURANCE], 'counted once');
});

test('confirmations: one superseded or hidden by a pattern cannot be confirmed (409), so nothing doubles or retypes', async () => {
  const a = mkAccount();
  const id = charge(a, INSURANCE, -300, '2026-03-15');
  const b = mkAccount();
  charge(b, INSURANCE, -300, '2025-04-10'); // another month, so asked too
  detectPatterns(a.account, '2026-12-31');
  detectPatterns(b.account, '2026-12-31');
  const [onA, onB] = ['a', 'b'].map((k) =>
    (db.prepare('SELECT id FROM pattern_confirmations WHERE account_id = ?').get(k === 'a' ? a.account : b.account) as { id: string }).id
  );
  assert.equal((await yearly(a, [id])).statusCode, 200);
  assert.throws(() => confirmPatternConfirmation(onA), /not_pending/);
  assert.throws(() => confirmPatternConfirmation(onB), /not_pending/);

  // Pending but hidden: an active pattern for the counterparty appeared on its account.
  const c = mkAccount();
  charge(c, 'Lehtitalo Sivu', -120, '2025-01-20');
  detectPatterns(c.account, '2026-12-31');
  const [pending] = listPendingConfirmations();
  const ids = ['2026-09-20', '2026-10-20', '2026-11-20'].map((d) => charge(c, 'Lehtitalo Sivu', -120, d));
  await create({ accountId: c.account, counterparty: 'Lehtitalo Sivu', kind: 'subscription', interval: 'monthly', expectedAmount: 120, evidenceTransactionIds: ids });
  db.prepare("UPDATE pattern_confirmations SET status = 'pending' WHERE id = ?").run(pending.id); // as if never superseded
  assert.throws(() => confirmPatternConfirmation(pending.id), /pattern_exists/);
  assert.equal(rows('Lehtitalo Sivu')[0].pattern_type, 'subscription');
  assert.equal(rows().length, 1);
});

test('yearly: a bill paid weeks earlier than a year still attaches and moves the typical month', async () => {
  const a = mkAccount();
  const ids = [charge(a, INSURANCE, -300, '2024-12-20'), charge(a, INSURANCE, -300, '2025-12-20')];
  assert.equal((await yearly(a, ids)).statusCode, 200);
  charge(a, INSURANCE, -300, '2026-11-05'); // 320 days later
  detectPatterns(a.account, '2026-11-30');
  const [row] = rows();
  assert.equal(row.occurrence_count, 3);
  assert.equal(row.typical_month, 11);
  assert.deepEqual(computeMonthlyForecast(1, '2026-11-30', []).annualItems, [], 'December has nothing left to pay');
});

test('yearly: a pending confirmation is hidden while the counterparty has an active pattern on its account', async () => {
  const a = mkAccount();
  charge(a, INSURANCE, -300, '2026-03-15');
  detectPatterns(a.account, '2026-12-31');
  assert.equal(listPendingConfirmations().length, 1);
  // A monthly pattern of the same counterparty appears later (e.g. created by an agent).
  const ids = ['2026-10-15', '2026-11-15'].map((d) => charge(a, INSURANCE, -25, d));
  const res = await create({ accountId: a.account, counterparty: INSURANCE, kind: 'recurring', interval: 'monthly', expectedAmount: 25, evidenceTransactionIds: ids });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(listPendingConfirmations(), []);
});

test('yearly: detection keeps one pattern; a later charge attaches to it and moves its typical month', async () => {
  const a = mkAccount();
  const id = charge(a, INSURANCE, -300, '2026-03-15');
  const { pattern } = (await yearly(a, [id])).json();
  charge(a, INSURANCE, -320, '2027-02-26'); // 348 days later, billed in February this time
  detectPatterns(a.account, '2027-06-30');
  const after = rows();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, pattern.id);
  assert.equal(after[0].origin, 'created');
  assert.equal(after[0].pattern_type, 'annual');
  assert.equal(after[0].typical_amount, 300, 'the created amount stays');
  assert.equal(after[0].occurrence_count, 2);
  assert.equal(after[0].typical_month, 2);
});

test('yearly: re-stating with a new price updates it; reset withdraws it from the forecast', async () => {
  const a = mkAccount();
  const id = charge(a, INSURANCE, -300, '2026-03-15');
  const first = (await yearly(a, [id])).json();
  const again = await yearly(a, [id], { expectedAmount: 310 });
  assert.equal(again.json().updated, true);
  assert.equal(again.json().pattern.id, first.pattern.id);
  assert.equal(forecastFor(3).annualItems[0].amount, 310);

  const reset = await decide(first.pattern.id, 'reset');
  assert.equal(reset.json().pattern.state, 'unconfirmed');
  assert.deepEqual(forecastFor(3).annualItems, [], 'nobody vouches for a withdrawn created pattern');
});

// ── Lapse with yearly periods ──────────────────────────────────────

test('lapse: a created yearly pattern lapses two years (plus 35 days) after its last charge', async () => {
  const a = mkAccount();
  const id = charge(a, INSURANCE, -300, '2026-03-15');
  const { pattern } = (await yearly(a, [id])).json();
  // 2026-03-15 + 2 × 365 + 35 days = 2028-04-18 (2028 is a leap year).
  otherSpend(a, '2028-04-17');
  detectPatterns(a.account, '2028-04-30');
  assert.equal(activePatterns().find((p) => p.id === pattern.id)?.lapsed, false);
  otherSpend(a, '2028-04-18');
  detectPatterns(a.account, '2028-04-30');
  const p = activePatterns().find((x) => x.id === pattern.id)!;
  assert.equal(p.lapsed, true);
  assert.equal(p.lapsed_since, '2028-04-18');
  const march = computeMonthlyForecast(11, '2028-04-30', []);
  assert.equal(march.targetMonth, '2029-03');
  assert.deepEqual(march.annualItems, []);
  assert.deepEqual(march.lapsedAnnualItems.map((i) => [i.patternId, i.lapsed, i.lapsedSince]), [[pattern.id, true, '2028-04-18']]);
});

test('lapse: a detected annual pattern lapses too, and counts again when a charge comes', () => {
  const a = mkAccount();
  charge(a, INSURANCE, -300, '2024-03-15');
  charge(a, INSURANCE, -300, '2025-03-15');
  otherSpend(a, '2027-04-19'); // 2025-03-15 + 765
  detectPatterns(a.account, '2027-04-30');
  const [row] = rows();
  assert.equal(row.pattern_type, 'annual');
  assert.equal(row.lapsed_since, '2027-04-19');
  assert.deepEqual(computeMonthlyForecast(11, '2027-04-30', []).annualItems, []);

  charge(a, INSURANCE, -300, '2027-04-25');
  detectPatterns(a.account, '2027-04-30');
  assert.equal(rows()[0].lapsed_since, null);
  assert.equal(computeMonthlyForecast(11, '2027-04-30', []).annualItems.length, 1);
});

test('decisions: a decision made while monthly does not follow the row when it turns annual, nor the other way round', () => {
  const a = mkAccount();
  charge(a, INSURANCE, -300, '2025-03-15');
  charge(a, INSURANCE, -300, '2026-03-15');
  detectPatterns(a.account, '2026-12-31');
  const [row] = rows();
  decidePattern(row.id as string, 'not_recurring', ACTOR);
  assert.equal(activePatterns().length, 0);
  db.prepare("UPDATE recurring_patterns SET pattern_type = 'recurring' WHERE id = ?").run(row.id);
  assert.equal(activePatterns()[0].state, 'unconfirmed', 'the annual rejection is not a monthly one');
});
