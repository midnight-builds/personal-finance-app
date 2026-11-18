import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Fastify from 'fastify';

import { db } from '../src/db.js';
import { CONFIDENT, detectPatterns, redetectPatternsIfRulesChanged, scorePattern } from '../src/patterns.js';
import { activePatterns, decidePattern, establishedSubscriptions, recurringQuestions } from '../src/patternDecisions.js';
import { computeMonthlyForecast } from '../src/forecast.js';
import { getHouseholdSummary } from '../src/summary.js';
import { routes } from '../src/routes/index.js';
import { resetDb } from './setup/resetDb.js';

// Confidence, the user's decision on recurring patterns and the "Onko tämä
// toistuva?" questions (GLOSSARY.md). Every counterparty here is fictional.

const AS_OF = '2026-06-30';
const IBAN = 'FI00 1234 5600 0007 85';

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

function charge(a: Acct, counterparty: string, amount: number, date: string, iban: string | null = null) {
  const id = crypto.randomUUID();
  const raw = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(raw, now, a.session, '{}', date, amount, 'EUR');
  db.prepare('INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name, description, counterparty_iban) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, raw, a.session, a.account, date, date, amount, 'EUR', counterparty, null, iban);
  return id;
}

/** One charge on `day` of each of `months` months from month `from` (default January). */
function monthly(a: Acct, counterparty: string, amounts: number | number[], day: number, months = 6, iban: string | null = null, from = 1) {
  return Array.from({ length: months }, (_, k) => {
    const amount = Array.isArray(amounts) ? amounts[k] : amounts;
    return charge(a, counterparty, amount, `2026-${String(from + k).padStart(2, '0')}-${String(day).padStart(2, '0')}`, iban);
  });
}

/** Three charges up to June, the latest month of the data: a new pattern, not a stopped (lapsed) one. */
const recent = (a: Acct, counterparty: string, amount: number, day: number, iban: string | null = null) =>
  monthly(a, counterparty, amount, day, 3, iban, 4);

const pattern = (counterparty: string) => activePatterns().find((p) => p.counterparty_name === counterparty);
const question = (counterparty: string) => recurringQuestions().find((q) => q.counterparty === counterparty);
const forecast = () => computeMonthlyForecast(1, AS_OF);
const fixed = () => forecast().knownFixed.map((i) => i.counterparty);
const uncertain = () => forecast().uncertainRecurring.map((i) => i.counterparty);
const subscriptions = () => establishedSubscriptions().map((p) => p.counterparty_name);
const decide = (counterparty: string, decision: 'recurring' | 'subscription' | 'not_recurring', actor = 'user') =>
  decidePattern(pattern(counterparty)!.id, decision, actor);

// ── Confidence ──────────────────────────────────────────────────────

test('confidence: 0.4 × charges + 0.3 × interval + 0.3 × amount, documented factors', () => {
  const c = (date: string, amount = -10) => ({ date, amount, viaIban: false });
  // Three steady charges: the count factor keeps it below CONFIDENT.
  const three = scorePattern([c('2026-01-05'), c('2026-02-05'), c('2026-03-05')]);
  assert.deepEqual(three.factors, { charges: 0.33, interval: 0.9, amount: 1 });
  assert.equal(three.confidence, 0.7);
  assert.ok(three.confidence < CONFIDENT);
  assert.equal(three.amountFixed, true);
  assert.equal(three.paymentMethod, 'card');

  const six = scorePattern(['01', '02', '03', '04', '05', '06'].map((m) => c(`2026-${m}-05`)));
  assert.equal(six.factors.charges, 1);
  assert.ok(six.confidence >= 0.9);

  const varying = scorePattern([c('2026-01-05', -10), c('2026-02-05', -11), c('2026-03-05', -9), c('2026-04-05', -10)]);
  assert.equal(varying.amountFixed, false);
  assert.ok(varying.factors.amount < 1);
});

// ── Acceptance: restaurants, groceries, people, a subscription, a bill ──

test('restaurant: two same-sized purchases form no pattern; weekly lunches are an uncertain recurring cost', () => {
  const a = mkAccount();
  charge(a, 'Ravintola Kultainen Kauha', -24.9, '2026-04-10');
  charge(a, 'Ravintola Kultainen Kauha', -24.9, '2026-05-10');
  for (const [date, amount] of [
    ['2026-06-01', -11.5],
    ['2026-06-05', -12.9],
    ['2026-06-15', -10.8],
    ['2026-06-21', -12.0],
    ['2026-06-27', -11.2],
  ] as const) {
    charge(a, 'Lounasbaari Haarukka', amount, date);
  }
  detectPatterns(a.account, AS_OF);

  assert.equal(pattern('Ravintola Kultainen Kauha'), undefined);
  const lunch = pattern('Lounasbaari Haarukka')!;
  assert.equal(lunch.pattern_type, 'recurring');
  assert.ok(lunch.confidence! < CONFIDENT, `confidence ${lunch.confidence}`);
  assert.equal(lunch.established, false);
  assert.deepEqual(subscriptions(), []);
  assert.deepEqual(fixed(), []);
  assert.deepEqual(uncertain(), ['Lounasbaari Haarukka']);
  assert.deepEqual(question('Lounasbaari Haarukka')!.reasons, ['low_confidence']);
});

test('groceries: frequent purchases of varying size form no pattern and no fixed cost', () => {
  const a = mkAccount();
  const amounts = [-38.2, -71.45, -12.3, -54.9, -26.75, -88.1, -19.99, -47.6];
  amounts.forEach((amount, k) => charge(a, 'Lähikauppa Omena', amount, `2026-06-${String(3 + k * 3).padStart(2, '0')}`));
  charge(a, 'Supermarket Kori', -45.1, '2026-05-20');
  charge(a, 'Supermarket Kori', -45.1, '2026-05-27');
  detectPatterns(a.account, AS_OF);

  assert.deepEqual(activePatterns(), []);
  assert.deepEqual(recurringQuestions(), []);
  assert.equal(getHouseholdSummary(AS_OF).monthlySubscriptions, 0);
  assert.equal(forecast().knownFixedTotal, 0);
});

test('person: a fixed monthly payment to an IBAN is never a subscription without the user’s word; once established it is not asked', () => {
  const a = mkAccount();
  monthly(a, 'Maija Meikäläinen', -50, 10, 6, IBAN);
  detectPatterns(a.account, AS_OF);

  const p = pattern('Maija Meikäläinen')!;
  assert.equal(p.pattern_type, 'recurring');
  assert.equal(p.payment_method, 'account_payment');
  assert.deepEqual(subscriptions(), []);
  assert.equal(p.established, true);
  assert.equal(question('Maija Meikäläinen'), undefined, 'confident: no confirmation needed');

  decide('Maija Meikäläinen', 'subscription');
  assert.deepEqual(subscriptions(), ['Maija Meikäläinen']);
  assert.equal(question('Maija Meikäläinen'), undefined);
});

test('streaming subscription: counted once confident; at three charges only after the user confirms it', () => {
  const a = mkAccount();
  monthly(a, 'Suoratoisto Kuvavirta', -12.99, 3, 6);
  recent(a, 'Äänikirjapalvelu Tarina', -9.99, 15);
  // The first three months; the fourth month comes later.
  detectPatterns(a.account, AS_OF);

  const sure = pattern('Suoratoisto Kuvavirta')!;
  assert.equal(sure.pattern_type, 'subscription');
  assert.ok(sure.confidence! >= CONFIDENT);
  const fresh = pattern('Äänikirjapalvelu Tarina')!;
  assert.equal(fresh.pattern_type, 'subscription');
  assert.ok(fresh.confidence! < CONFIDENT);

  assert.deepEqual(subscriptions(), ['Suoratoisto Kuvavirta']);
  assert.equal(getHouseholdSummary(AS_OF).monthlySubscriptions, 12.99);
  assert.deepEqual(fixed(), ['Suoratoisto Kuvavirta']);
  assert.deepEqual(uncertain(), ['Äänikirjapalvelu Tarina']);
  // Only the uncertain one is asked; the fixed card amount is a hint, not a trigger.
  assert.equal(question('Suoratoisto Kuvavirta'), undefined);
  assert.deepEqual(question('Äänikirjapalvelu Tarina')!.reasons, ['low_confidence', 'fixed_amount_card']);
  assert.equal(question('Äänikirjapalvelu Tarina')!.evidence.transactions.length, 3);
  assert.equal(question('Äänikirjapalvelu Tarina')!.suggestedAnswer, 'subscription');

  decide('Äänikirjapalvelu Tarina', 'subscription');
  assert.deepEqual(subscriptions().sort(), ['Suoratoisto Kuvavirta', 'Äänikirjapalvelu Tarina']);
  assert.equal(getHouseholdSummary(AS_OF).monthlySubscriptions, 22.98);
  assert.deepEqual(fixed().sort(), ['Suoratoisto Kuvavirta', 'Äänikirjapalvelu Tarina']);
  assert.deepEqual(uncertain(), []);
});

test('monthly bill: six months of an e-invoice of varying amount is an established fixed cost and not asked', () => {
  const a = mkAccount();
  monthly(a, 'Sähkölaitos Virta Oy', [-64.2, -61.8, -66.5, -63.1, -60.4, -65.0], 20, 6, IBAN);
  detectPatterns(a.account, AS_OF);

  const bill = pattern('Sähkölaitos Virta Oy')!;
  assert.equal(bill.pattern_type, 'recurring');
  assert.equal(bill.established, true);
  assert.deepEqual(fixed(), ['Sähkölaitos Virta Oy']);
  assert.equal(question('Sähkölaitos Virta Oy'), undefined);
  assert.deepEqual(subscriptions(), []);
});

test('only uncertain, undecided patterns are asked; decided and rejected ones never', () => {
  const a = mkAccount();
  monthly(a, 'Suoratoisto Kuvavirta', -12.99, 3, 6); // established
  recent(a, 'Rahasto Kasvu', -100, 12, IBAN); // uncertain
  recent(a, 'Maija Meikäläinen', -50, 10, IBAN); // uncertain
  recent(a, 'Äänikirjapalvelu Tarina', -9.99, 15); // uncertain
  detectPatterns(a.account, AS_OF);
  assert.deepEqual(recurringQuestions().map((q) => q.counterparty).sort(), ['Maija Meikäläinen', 'Rahasto Kasvu', 'Äänikirjapalvelu Tarina']);
  for (const q of recurringQuestions()) assert.ok(q.reasons.includes('low_confidence'));

  decide('Rahasto Kasvu', 'not_recurring', 'hermes');
  decide('Maija Meikäläinen', 'recurring', 'user');
  detectPatterns(a.account, AS_OF);
  assert.deepEqual(recurringQuestions().map((q) => q.counterparty), ['Äänikirjapalvelu Tarina']);
});

test('monthly bill: four charges with a wider spread stay uncertain and are asked until confirmed', () => {
  const a = mkAccount();
  monthly(a, 'Vesiosuuskunta Lähde', [-60, -66, -72, -63], 20, 4, IBAN);
  detectPatterns(a.account, AS_OF);

  const bill = pattern('Vesiosuuskunta Lähde')!;
  assert.equal(bill.pattern_type, 'recurring');
  assert.ok(bill.confidence! < CONFIDENT, `confidence ${bill.confidence}`);
  assert.deepEqual(uncertain(), ['Vesiosuuskunta Lähde']);
  assert.deepEqual(question('Vesiosuuskunta Lähde')!.reasons, ['low_confidence']);

  decide('Vesiosuuskunta Lähde', 'recurring');
  assert.deepEqual(fixed(), ['Vesiosuuskunta Lähde']);
});

test('forecast keeps uncertain patterns out of projectedTotal and reports them apart', () => {
  const a = mkAccount();
  monthly(a, 'Suoratoisto Kuvavirta', -12.99, 3, 6);
  recent(a, 'Äänikirjapalvelu Tarina', -9.99, 15);
  detectPatterns(a.account, AS_OF);

  const f = forecast();
  assert.equal(f.knownFixedTotal, 12.99);
  assert.equal(f.uncertainRecurringTotal, 9.99);
  // No history for the target month: the fixed costs are the floor.
  assert.equal(f.projectedTotal, 12.99);
  assert.equal(f.projectedTotalWithUncertain, 22.98);
  assert.equal(f.knownFixed[0].state, 'unconfirmed');
});

// ── Decisions are durable ────────────────────────────────────────────

test('decisions survive detection and a rules-version re-detection', () => {
  const a = mkAccount();
  monthly(a, 'Maija Meikäläinen', -50, 10, 6, IBAN);
  monthly(a, 'Rahasto Kasvu', -100, 12, 6, IBAN);
  monthly(a, 'Suoratoisto Kuvavirta', -12.99, 3, 6);
  detectPatterns(a.account, AS_OF);
  decide('Maija Meikäläinen', 'recurring');
  decide('Rahasto Kasvu', 'not_recurring');
  decide('Suoratoisto Kuvavirta', 'subscription');

  const check = () => {
    assert.equal(pattern('Maija Meikäläinen')!.state, 'confirmed_recurring');
    assert.equal(pattern('Rahasto Kasvu'), undefined, 'rejected stays out');
    assert.equal(pattern('Suoratoisto Kuvavirta')!.state, 'confirmed_subscription');
    assert.deepEqual(recurringQuestions(), []);
    assert.deepEqual(fixed().sort(), ['Maija Meikäläinen', 'Suoratoisto Kuvavirta']);
    assert.deepEqual(uncertain(), []);
  };
  check();

  // A further month of charges, then the import's detection.
  charge(a, 'Maija Meikäläinen', -50, '2026-07-10', IBAN);
  charge(a, 'Rahasto Kasvu', -100, '2026-07-12', IBAN);
  charge(a, 'Suoratoisto Kuvavirta', -12.99, '2026-07-03');
  detectPatterns(a.account, '2026-07-31');
  check();

  db.prepare("DELETE FROM app_settings WHERE key = 'patternRulesVersion'").run();
  assert.equal(redetectPatternsIfRulesChanged('2026-07-31'), true);
  check();
});

test('a confirmed subscription stays one when its price changes', () => {
  const a = mkAccount();
  monthly(a, 'Suoratoisto Kuvavirta', -12.99, 3, 4);
  detectPatterns(a.account, AS_OF);
  decide('Suoratoisto Kuvavirta', 'subscription');

  charge(a, 'Suoratoisto Kuvavirta', -14.99, '2026-05-03');
  charge(a, 'Suoratoisto Kuvavirta', -14.99, '2026-06-03');
  detectPatterns(a.account, AS_OF);

  const p = pattern('Suoratoisto Kuvavirta')!;
  assert.equal(p.detected_type, 'recurring');
  assert.equal(p.pattern_type, 'subscription');
  assert.deepEqual(subscriptions(), ['Suoratoisto Kuvavirta']);
  assert.deepEqual(fixed(), ['Suoratoisto Kuvavirta']);
});

test('a decided pattern that stops is deactivated but keeps its decision when it resumes', () => {
  const a = mkAccount();
  monthly(a, 'Rahasto Kasvu', -100, 12, 3, IBAN);
  detectPatterns(a.account, '2026-03-31');
  decide('Rahasto Kasvu', 'not_recurring');

  // Months of other bookings but none to the fund: its charges have stopped.
  charge(a, 'Lähikauppa Omena', -23.4, '2026-08-28');
  detectPatterns(a.account, '2026-08-31');
  const row = db.prepare("SELECT is_active FROM recurring_patterns WHERE counterparty_name = 'Rahasto Kasvu'").get() as { is_active: number };
  assert.equal(row.is_active, 0);

  for (const m of ['09', '10', '11']) charge(a, 'Rahasto Kasvu', -100, `2026-${m}-12`, IBAN);
  detectPatterns(a.account, '2026-11-30');
  const resumed = db.prepare("SELECT is_active FROM recurring_patterns WHERE counterparty_name = 'Rahasto Kasvu'").get() as { is_active: number };
  assert.equal(resumed.is_active, 1);
  assert.equal(pattern('Rahasto Kasvu'), undefined, 'still rejected');
  assert.deepEqual(recurringQuestions(), [], 'not asked again');
});

test('patterns of an account whose exports lag behind stay active: their charges did not stop', () => {
  const a = mkAccount();
  monthly(a, 'Suoratoisto Kuvavirta', -12.99, 3, 6);
  detectPatterns(a.account, AS_OF);
  decide('Suoratoisto Kuvavirta', 'subscription');

  // Five months later, nothing imported since: the window ends at the account's own data.
  detectPatterns(a.account, '2026-11-30');
  db.prepare("DELETE FROM app_settings WHERE key = 'patternRulesVersion'").run();
  redetectPatternsIfRulesChanged('2026-11-30');
  assert.deepEqual(subscriptions(), ['Suoratoisto Kuvavirta']);
  assert.deepEqual(fixed(), ['Suoratoisto Kuvavirta']);
});

test('any actor may change any decision, the latest wins, and the history keeps every one', () => {
  const a = mkAccount();
  monthly(a, 'Suoratoisto Kuvavirta', -12.99, 3, 6);
  detectPatterns(a.account, AS_OF);
  const id = pattern('Suoratoisto Kuvavirta')!.id;

  decidePattern(id, 'subscription', 'user');
  const overridden = decidePattern(id, 'not_recurring', 'agent-a');
  assert.equal(overridden.recorded, true);
  assert.equal(overridden.pattern.state, 'rejected');
  assert.equal(overridden.pattern.decided_by, 'agent-a');
  assert.deepEqual(fixed(), []);

  decidePattern(id, 'recurring', 'user');
  assert.equal(pattern('Suoratoisto Kuvavirta')!.state, 'confirmed_recurring');

  const rows = db.prepare('SELECT decision, actor FROM pattern_decisions ORDER BY id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { decision: 'subscription', actor: 'user' },
    { decision: 'not_recurring', actor: 'agent-a' },
    { decision: 'recurring', actor: 'user' },
  ]);
});

test('reset returns a pattern to unconfirmed: detection rules apply and an uncertain one is asked again', () => {
  const a = mkAccount();
  monthly(a, 'Rahasto Kasvu', -100, 12, 3, IBAN);
  detectPatterns(a.account, AS_OF);
  const id = pattern('Rahasto Kasvu')!.id;

  assert.equal(decidePattern(id, 'reset', 'user').recorded, false, 'nothing to reset');
  decidePattern(id, 'not_recurring', 'agent-a');
  assert.equal(pattern('Rahasto Kasvu'), undefined);

  const reset = decidePattern(id, 'reset', 'user');
  assert.equal(reset.recorded, true);
  assert.equal(reset.pattern.state, 'unconfirmed');
  assert.equal(reset.pattern.decided_by, null);
  assert.deepEqual(uncertain(), ['Rahasto Kasvu']);
  assert.deepEqual(recurringQuestions().map((q) => q.counterparty), ['Rahasto Kasvu']);
  detectPatterns(a.account, AS_OF);
  assert.equal(pattern('Rahasto Kasvu')!.state, 'unconfirmed');
  assert.equal(decidePattern(id, 'reset', 'user').recorded, false, 'already reset');
});

test('a decision applies to monthly/weekly patterns only: a row turned annual follows its own rules', () => {
  const a = mkAccount();
  monthly(a, 'Rahasto Kasvu', -100, 12, 6, IBAN);
  detectPatterns(a.account, AS_OF);
  const { id } = pattern('Rahasto Kasvu')!;
  decide('Rahasto Kasvu', 'not_recurring');

  db.prepare("UPDATE recurring_patterns SET pattern_type = 'annual', typical_month = 6 WHERE id = ?").run(id);
  const annual = activePatterns().find((p) => p.id === id)!;
  assert.equal(annual.state, 'unconfirmed');
  assert.equal(annual.pattern_type, 'annual');
  assert.equal(annual.decided_by, null);

  db.prepare("UPDATE recurring_patterns SET pattern_type = 'recurring' WHERE id = ?").run(id);
  assert.equal(pattern('Rahasto Kasvu'), undefined, 'monthly again: rejected again');
});

test('the briefing asks the open questions with their charges and leaves rejected patterns out', async () => {
  const { runBriefing } = await import('../src/briefing.js');
  const a = mkAccount();
  const ids = recent(a, 'Rahasto Kasvu', -100, 12, IBAN);
  recent(a, 'Maija Meikäläinen', -50, 10, IBAN);
  monthly(a, 'Suoratoisto Kuvavirta', -12.99, 3, 6);
  detectPatterns(a.account, AS_OF);
  decide('Maija Meikäläinen', 'not_recurring');

  const briefingId = await runBriefing(a.session, AS_OF);
  const findings = db
    .prepare('SELECT finding_type, title, transaction_ids, metadata FROM insight_findings WHERE briefing_session_id = ?')
    .all(briefingId) as Array<{ finding_type: string; title: string; transaction_ids: string; metadata: string }>;
  const questions = findings.filter((f) => f.finding_type === 'recurring_question');
  assert.equal(questions.length, 1);
  assert.match(questions[0].title, /^Onko tämä toistuva\? Rahasto Kasvu$/);
  assert.deepEqual(JSON.parse(questions[0].transaction_ids).sort(), [...ids].sort());
  assert.equal(JSON.parse(questions[0].metadata).patternId, pattern('Rahasto Kasvu')!.id);
  assert.ok(!findings.some((f) => f.title.includes('Maija')), 'a rejected pattern is not reported');
  assert.ok(!findings.some((f) => f.finding_type === 'new_recurring' && f.title.includes('Rahasto')), 'asked, not also announced');
  assert.ok(!questions.some((f) => f.title.includes('Kuvavirta')), 'an established pattern is not asked');

  // Answered since (e.g. by an agent): the stored card is no longer shown.
  const { withoutAnsweredQuestions } = await import('../src/briefing.js');
  const stored = db
    .prepare('SELECT finding_type, metadata FROM insight_findings WHERE briefing_session_id = ?')
    .all(briefingId) as Array<{ finding_type: string; metadata: string | null }>;
  assert.equal(withoutAnsweredQuestions(stored).filter((f) => f.finding_type === 'recurring_question').length, 1);
  decide('Rahasto Kasvu', 'recurring', 'hermes');
  assert.equal(withoutAnsweredQuestions(stored).filter((f) => f.finding_type === 'recurring_question').length, 0);
  assert.equal(withoutAnsweredQuestions(stored).length, stored.length - 1);
});

// ── REST ─────────────────────────────────────────────────────────────

const app = Fastify();
await app.register(routes);
await app.ready();
after(() => app.close());

test('REST: answer a question with the actor, re-stating appends nothing, history lists it', async () => {
  const a = mkAccount();
  monthly(a, 'Rahasto Kasvu', -100, 12, 3, IBAN);
  detectPatterns(a.account, AS_OF);

  const questions = (await app.inject({ method: 'GET', url: '/patterns/questions' })).json();
  assert.equal(questions.length, 1);
  const { patternId } = questions[0];

  const answer = (decision: string) =>
    app.inject({
      method: 'POST',
      url: `/patterns/${patternId}/decision`,
      headers: { 'x-finance-actor': 'hermes' },
      payload: { decision },
    });
  const first = await answer('recurring');
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().recorded, true);
  assert.equal(first.json().pattern.state, 'confirmed_recurring');
  assert.equal(first.json().pattern.decided_by, 'hermes');
  assert.equal((await answer('recurring')).json().recorded, false);

  const log = (await app.inject({ method: 'GET', url: '/patterns/decisions' })).json();
  assert.equal(log.total, 1);
  assert.equal(log.items[0].actor, 'hermes');
  assert.equal(log.items[0].decision, 'recurring');
  assert.deepEqual((await app.inject({ method: 'GET', url: '/patterns/questions' })).json(), []);

  assert.equal((await answer('maybe')).statusCode, 400);
  const missing = await app.inject({ method: 'POST', url: '/patterns/nope/decision', payload: { decision: 'recurring' } });
  assert.equal(missing.statusCode, 404);
});

test('REST: annual patterns are not decided here', async () => {
  const a = mkAccount();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO recurring_patterns (id, created_at, updated_at, account_id, counterparty_name, pattern_type,
      interval_days, typical_amount, currency, first_seen, last_seen, occurrence_count, is_active, typical_month)
    VALUES (?, ?, ?, ?, 'Vakuutusyhtiö Turva', 'annual', 365, 300, 'EUR', ?, ?, 2, 1, 3)`).run(id, now, now, a.account, now, now);
  const res = await app.inject({ method: 'POST', url: `/patterns/${id}/decision`, payload: { decision: 'not_recurring' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'not_monthly_pattern');
});
