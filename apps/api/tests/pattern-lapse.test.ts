import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Fastify from 'fastify';

import { db } from '../src/db.js';
import { detectPatterns, redetectPatternsIfRulesChanged } from '../src/patterns.js';
import { activePatterns, decidePattern, establishedSubscriptions, recurringQuestions } from '../src/patternDecisions.js';
import { computeMonthlyForecast } from '../src/forecast.js';
import { getHouseholdSummary } from '../src/summary.js';
import { runBriefing } from '../src/briefing.js';
import { routes } from '../src/routes/index.js';
import { resetDb } from './setup/resetDb.js';

// Lapsed patterns (GLOSSARY.md, "Lapsed pattern") and weekly patterns at their real
// frequency in the forecast. Every counterparty and amount here is fictional.

const ACTOR = 'agent-test';

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

/** Something else booked on the account that day: moves the account's latest booking. */
const otherSpend = (a: Acct, date: string) => charge(a, 'Ruokakauppa Kulma', -12.3, date);

const create = (body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/patterns', payload: body, headers: { 'x-finance-actor': ACTOR } });

const pattern = (counterparty: string) => activePatterns().find((p) => p.counterparty_name === counterparty);
const recurring = async () => (await app.inject({ method: 'GET', url: '/recurring' })).json() as Array<Record<string, unknown>>;
const decisionLog = async () => (await app.inject({ method: 'GET', url: '/patterns/decisions' })).json().items as unknown[];

const GYM = 'Kuntosali Liikku';

/** A created monthly subscription from one charge on 2026-03-04. */
async function createdGym() {
  const a = mkAccount();
  const id = charge(a, GYM, -39.9, '2026-03-04');
  const res = await create({
    accountId: a.account,
    counterparty: GYM,
    kind: 'subscription',
    interval: 'monthly',
    expectedAmount: 39.9,
    evidenceTransactionIds: [id],
  });
  assert.equal(res.statusCode, 200, res.body);
  return { a, id: res.json().pattern.id as string };
}

// ── Lapse ───────────────────────────────────────────────────────────

test('lapse: a created pattern stops counting two monthly periods after its last charge, measured on the account’s latest booking', async () => {
  const { a, id } = await createdGym();
  // The account's data ends at the charge; today is months later. Nothing lapsed: the export lags.
  assert.equal(pattern(GYM)?.lapsed, false);
  assert.equal(pattern(GYM)?.lapsed_since, null);

  // 2026-03-04 + 2 × 31 + 5 days = 2026-05-10. The day before, it still counts.
  otherSpend(a, '2026-05-09');
  detectPatterns(a.account, '2026-05-31');
  assert.equal(pattern(GYM)?.lapsed, false);
  assert.deepEqual(computeMonthlyForecast(1, '2026-05-31', []).knownFixed.map((i) => i.patternId), [id]);

  otherSpend(a, '2026-05-10');
  detectPatterns(a.account, '2026-05-31');
  const p = pattern(GYM)!;
  assert.equal(p.lapsed, true);
  assert.equal(p.lapsed_since, '2026-05-10');
  assert.equal(p.is_active, 1, 'not deleted or deactivated');
  assert.equal(p.state, 'confirmed_subscription', 'its decision stays');

  const f = computeMonthlyForecast(1, '2026-05-31', []);
  assert.deepEqual(f.knownFixed, []);
  assert.deepEqual(f.uncertainRecurring, []);
  assert.equal(f.knownFixedTotal, 0);
  assert.deepEqual(
    f.lapsedRecurring.map((i) => [i.patternId, i.lapsed, i.lapsedSince]),
    [[id, true, '2026-05-10']],
    'listed apart, counted nowhere'
  );
  assert.deepEqual(establishedSubscriptions(), []);
  assert.equal(getHouseholdSummary('2026-05-31').monthlySubscriptions, 0);

  const listed = (await recurring()).find((r) => r.id === id);
  assert.equal(listed?.lapsed, true);
  assert.equal(listed?.lapsed_since, '2026-05-10');
  assert.equal((await decisionLog()).length, 1, 'decision history unchanged');

  // A charge again: it counts again, automatically.
  charge(a, GYM, -39.9, '2026-05-20');
  detectPatterns(a.account, '2026-05-31');
  assert.equal(pattern(GYM)?.lapsed, false);
  assert.deepEqual(computeMonthlyForecast(1, '2026-05-31', []).knownFixed.map((i) => i.patternId), [id]);
  assert.equal(getHouseholdSummary('2026-05-31').monthlySubscriptions, 39.9);
});

test('lapse: the subscription-creep finding leaves a lapsed subscription out', async () => {
  const { a } = await createdGym();
  otherSpend(a, '2026-06-01');
  detectPatterns(a.account, '2026-06-30');
  const session = crypto.randomUUID();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format) VALUES (?, ?, ?, ?)')
    .run(session, new Date().toISOString(), 'test', 'csv');
  const briefing = await runBriefing(session, '2026-06-30');
  const types = (db.prepare('SELECT finding_type FROM insight_findings WHERE briefing_session_id = ?').all(briefing) as Array<{ finding_type: string }>).map((r) => r.finding_type);
  assert.ok(!types.includes('subscription_creep'), types.join());
  assert.ok(!types.includes('new_recurring'), 'a lapsed pattern is not news');
});

test('lapse: any charge from the counterparty keeps it alive, also at a new price outside the expected amount', async () => {
  const { a } = await createdGym();
  charge(a, GYM, -49.9, '2026-04-04'); // +25 %: not attached, but the counterparty still charges
  otherSpend(a, '2026-06-01');
  detectPatterns(a.account, '2026-06-30');
  assert.equal(pattern(GYM)?.lapsed, false, '2026-04-04 + 67 days is after 2026-06-01');
  otherSpend(a, '2026-06-10');
  detectPatterns(a.account, '2026-06-30');
  assert.equal(pattern(GYM)?.lapsed, true);
});

test('lapse: a lapsed pattern can still be rejected, and then is not listed as lapsed either', async () => {
  const { a, id } = await createdGym();
  otherSpend(a, '2026-06-01');
  detectPatterns(a.account, '2026-06-30');
  const res = await app.inject({
    method: 'POST', url: `/patterns/${id}/decision`, payload: { decision: 'not_recurring' }, headers: { 'x-finance-actor': ACTOR },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().pattern.state, 'rejected');
  assert.deepEqual(computeMonthlyForecast(1, '2026-06-30', []).lapsedRecurring, []);
  assert.equal((await decisionLog()).length, 2);
});

test('lapse: creating a pattern from an old charge returns it lapsed at once', async () => {
  const a = mkAccount();
  const id = charge(a, GYM, -39.9, '2026-03-04');
  otherSpend(a, '2026-06-01');
  const res = await create({
    accountId: a.account, counterparty: GYM, kind: 'subscription', interval: 'monthly', expectedAmount: 39.9, evidenceTransactionIds: [id],
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().pattern.lapsed, true);
  assert.equal(res.json().pattern.lapsed_since, '2026-05-10');
});

const LUNCH = 'Lounasravintola Pata';
/** Mondays of June 2026. */
const JUNE_MONDAYS = ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22'];

test('lapse: applies to detected patterns too — a confirmed weekly one stops counting after two missed weeks', () => {
  const a = mkAccount();
  for (const d of JUNE_MONDAYS) charge(a, LUNCH, -11.5, d);
  detectPatterns(a.account, '2026-06-30');
  const p = pattern(LUNCH)!;
  assert.equal(p.detected_type, 'recurring');
  assert.equal(p.interval_days, 7);
  decidePattern(p.id, 'recurring', ACTOR);

  // 2026-06-22 + 2 × 7 + 3 days = 2026-07-09.
  otherSpend(a, '2026-07-08');
  detectPatterns(a.account, '2026-07-31');
  assert.equal(pattern(LUNCH)?.lapsed, false);

  otherSpend(a, '2026-07-09');
  detectPatterns(a.account, '2026-07-31');
  const lapsed = pattern(LUNCH)!;
  assert.equal(lapsed.is_active, 1, 'still active: four charges in the window');
  assert.equal(lapsed.lapsed, true);
  assert.equal(lapsed.lapsed_since, '2026-07-09');
  assert.deepEqual(computeMonthlyForecast(1, '2026-07-31', []).knownFixed, []);
});

test('lapse: an uncertain lapsed pattern is not asked about', () => {
  const a = mkAccount();
  for (const d of JUNE_MONDAYS.slice(0, 3)) charge(a, LUNCH, -11.5, d);
  detectPatterns(a.account, '2026-06-30');
  assert.deepEqual(recurringQuestions().map((q) => q.counterparty), [LUNCH]);
  otherSpend(a, '2026-07-02'); // 2026-06-15 + 17
  detectPatterns(a.account, '2026-07-31');
  assert.deepEqual(recurringQuestions(), []);
  assert.deepEqual(computeMonthlyForecast(1, '2026-07-31', []).uncertainRecurring, []);
});

test('lapse: a rules-version re-detection fills in the lapse of stored patterns', async () => {
  const { a } = await createdGym();
  otherSpend(a, '2026-06-01');
  db.prepare('UPDATE recurring_patterns SET lapsed_since = NULL').run();
  db.prepare("DELETE FROM app_settings WHERE key = 'patternRulesVersion'").run();
  assert.equal(redetectPatternsIfRulesChanged('2026-06-30'), true);
  assert.equal(pattern(GYM)?.lapsed, true);
});

// ── Weekly patterns at their real frequency ─────────────────────────

test('forecast: a weekly pattern counts once per expected charge date in the forecast month', () => {
  const a = mkAccount();
  for (const d of JUNE_MONDAYS) charge(a, LUNCH, -11.5, d);
  detectPatterns(a.account, '2026-06-30');

  // Mondays: July 2026 has four (6, 13, 20, 27), August five (3, 10, 17, 24, 31).
  const july = computeMonthlyForecast(1, '2026-06-30', []);
  const august = computeMonthlyForecast(2, '2026-06-30', []);
  assert.deepEqual(july.knownFixed.map((i) => [i.counterparty, i.chargesInMonth, i.amount]), [[LUNCH, 4, 46]]);
  assert.equal(july.knownFixedTotal, 46);
  assert.deepEqual(august.knownFixed.map((i) => [i.chargesInMonth, i.amount]), [[5, 57.5]]);
  assert.equal(august.knownFixedTotal, 57.5);
});

test('forecast: a monthly pattern still counts one charge a month', async () => {
  await createdGym();
  const f = computeMonthlyForecast(1, '2026-03-31', []);
  assert.deepEqual(f.knownFixed.map((i) => [i.chargesInMonth, i.amount]), [[1, 39.9]]);
});

test('subscription total: a weekly subscription counts 52/12 charges a month', async () => {
  const a = mkAccount();
  const ids = JUNE_MONDAYS.map((d) => charge(a, 'Lehtipalvelu Viikko', -5, d));
  const res = await create({
    accountId: a.account, counterparty: 'Lehtipalvelu Viikko', kind: 'subscription', interval: 'weekly', expectedAmount: 5, evidenceTransactionIds: ids,
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().pattern.monthly_amount, 21.67);
  assert.equal(getHouseholdSummary('2026-06-30').monthlySubscriptions, 21.67);
  assert.deepEqual(establishedSubscriptions().map((p) => p.monthly_amount), [21.67]);
});
