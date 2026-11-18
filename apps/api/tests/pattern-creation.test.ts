import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Fastify from 'fastify';

import { db } from '../src/db.js';
import { detectPatterns, redetectPatternsIfRulesChanged } from '../src/patterns.js';
import { activePatterns, decidePattern, establishedSubscriptions, recurringQuestions } from '../src/patternDecisions.js';
import { confirmPatternConfirmation } from '../src/patternConfirmations.js';
import { computeMonthlyForecast } from '../src/forecast.js';
import { getHouseholdSummary } from '../src/summary.js';
import { routes } from '../src/routes/index.js';
import { resetDb } from './setup/resetDb.js';

// Patterns an actor creates that detection never proposed (GLOSSARY.md, "Created
// pattern"). Every counterparty here is fictional.

const AS_OF = '2026-06-30';
const ACTOR = 'agent-test';

const app = Fastify();
await app.register(routes);
after(() => app.close());

beforeEach(() => resetDb());

function mkAccount(name = 'Käyttötili') {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), name, null, 'bank', 'checking');
  const session = crypto.randomUUID();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(session, new Date().toISOString(), 'test', 'csv', 'x', 1, crypto.randomUUID());
  return { account: id, session };
}

type Acct = ReturnType<typeof mkAccount>;

function charge(a: Acct, counterparty: string, amount: number, date: string | null) {
  const id = crypto.randomUUID();
  const raw = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(raw, now, a.session, '{}', date, amount, 'EUR');
  db.prepare('INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name, description, counterparty_iban) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, raw, a.session, a.account, date, date, amount, 'EUR', counterparty, null, null);
  return id;
}

/** One charge on `day` of each month from `first` to `last` (1-based, 2026). */
function monthly(a: Acct, counterparty: string, amount: number, day: number, first: number, last: number) {
  const ids: string[] = [];
  for (let m = first; m <= last; m++) ids.push(charge(a, counterparty, amount, `2026-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`));
  return ids;
}

type Body = {
  accountId: string;
  counterparty: string;
  kind: 'recurring' | 'subscription';
  interval: 'weekly' | 'monthly';
  expectedAmount: number;
  evidenceTransactionIds: string[];
};

const create = (body: Partial<Body>, actor = ACTOR) =>
  app.inject({ method: 'POST', url: '/patterns', payload: body, headers: { 'x-finance-actor': actor } });

const rows = (counterparty: string) =>
  db.prepare('SELECT * FROM recurring_patterns WHERE counterparty_name = ?').all(counterparty) as Array<Record<string, unknown>>;
const forecast = () => computeMonthlyForecast(1, AS_OF, []);
const fixed = () => forecast().knownFixed.map((i) => i.counterparty);
const uncertain = () => forecast().uncertainRecurring.map((i) => i.counterparty);
const subscriptions = () => establishedSubscriptions().map((p) => p.counterparty_name);
const listed = () => activePatterns().map((p) => p.counterparty_name);
const snapshot = (sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));

function newContract() {
  const a = mkAccount();
  const [id] = monthly(a, 'Kuntosali Liikku', -39.9, 4, 6, 6);
  const body: Body = {
    accountId: a.account,
    counterparty: 'Kuntosali Liikku',
    kind: 'subscription',
    interval: 'monthly',
    expectedAmount: 39.9,
    evidenceTransactionIds: [id],
  };
  return { a, id, body };
}

// ── Creating ────────────────────────────────────────────────────────

test('create: one charge is enough; confirmed at once by the actor, counted like a confirmed subscription', async () => {
  const { a, id, body } = newContract();
  detectPatterns(a.account, AS_OF);
  assert.deepEqual(listed(), [], 'detection never proposes a single charge');

  const money = () => snapshot('SELECT * FROM normalized_transactions ORDER BY id');
  const categorization = () => snapshot('SELECT * FROM categorization_decisions ORDER BY rowid');
  const before = { money: money(), categorization: categorization() };

  const res = await create(body);
  assert.equal(res.statusCode, 200, res.body);
  const { pattern, created } = res.json();
  assert.equal(created, true);
  assert.equal(pattern.origin, 'created');
  assert.equal(pattern.created_by, ACTOR);
  assert.equal(pattern.decided_by, ACTOR);
  assert.equal(pattern.state, 'confirmed_subscription');
  assert.equal(pattern.pattern_type, 'subscription');
  assert.equal(pattern.established, true);
  assert.equal(pattern.typical_amount, 39.9);
  assert.equal(pattern.interval_days, 30);
  assert.equal(pattern.occurrence_count, 1);
  assert.deepEqual(pattern.evidence_transaction_ids, [id]);

  assert.deepEqual(fixed(), ['Kuntosali Liikku']);
  assert.equal(forecast().knownFixed[0].origin, 'created');
  assert.equal(forecast().knownFixedTotal, 39.9);
  assert.deepEqual(subscriptions(), ['Kuntosali Liikku']);
  assert.equal(getHouseholdSummary(AS_OF).monthlySubscriptions, 39.9);
  assert.deepEqual(recurringQuestions(), [], 'decided: never asked');

  const log = (await app.inject({ method: 'GET', url: '/patterns/decisions' })).json();
  assert.deepEqual(
    log.items.map((i: { actor: string; decision: string; patternId: string }) => [i.actor, i.decision, i.patternId]),
    [[ACTOR, 'subscription', pattern.id]]
  );

  // Only the pattern and its decision were written.
  assert.deepEqual(money(), before.money);
  assert.deepEqual(categorization(), before.categorization);
});

const decisions = async () =>
  (await app.inject({ method: 'GET', url: '/patterns/decisions' })).json().items.map(
    (i: { actor: string; decision: string }) => [i.actor, i.decision]
  );

test('create: the same request again writes nothing; other values re-state the created pattern', async () => {
  const { a, body } = newContract();
  const first = (await create(body)).json();
  const again = await create(body);
  assert.equal(again.statusCode, 200);
  assert.deepEqual([again.json().created, again.json().updated], [false, false]);
  assert.equal(again.json().pattern.id, first.pattern.id);
  assert.equal((await decisions()).length, 1);

  // The price went up: the new amount, cited from the new charge, replaces the old one.
  const [dearer] = monthly(a, 'Kuntosali Liikku', -44.9, 4, 7, 7);
  const repriced = await create({ ...body, expectedAmount: 44.9, evidenceTransactionIds: [dearer] }, 'user');
  assert.equal(repriced.statusCode, 200, repriced.body);
  assert.deepEqual([repriced.json().created, repriced.json().updated], [false, true]);
  assert.equal(repriced.json().pattern.id, first.pattern.id);
  assert.equal(repriced.json().pattern.typical_amount, 44.9);
  assert.equal(repriced.json().pattern.created_by, 'user');
  assert.equal((await decisions()).length, 1, 'still confirmed as a subscription: no new decision');
  assert.equal(computeMonthlyForecast(1, '2026-07-31', []).knownFixedTotal, 44.9);

  const retyped = await create({ ...body, kind: 'recurring', expectedAmount: 44.9, evidenceTransactionIds: [dearer] });
  assert.equal(retyped.json().pattern.state, 'confirmed_recurring');
  assert.deepEqual(await decisions(), [[ACTOR, 'recurring'], [ACTOR, 'subscription']]);
  assert.equal(rows('Kuntosali Liikku').length, 1);
});

test('create: re-stating a rejected created pattern confirms it again, as a decision would', async () => {
  const { body } = newContract();
  const { pattern } = (await create(body)).json();
  decidePattern(pattern.id, 'not_recurring', 'user');
  assert.deepEqual(fixed(), []);
  const res = await create(body);
  assert.deepEqual([res.json().created, res.json().updated, res.json().pattern.state], [false, true, 'confirmed_subscription']);
  assert.deepEqual(await decisions(), [[ACTOR, 'subscription'], ['user', 'not_recurring'], [ACTOR, 'subscription']]);
  assert.deepEqual(fixed(), ['Kuntosali Liikku']);
});

test('create: an active detected pattern for the counterparty is a conflict; decide it instead', async () => {
  const a = mkAccount();
  const ids = monthly(a, 'Sähkö Virtanen', -60, 8, 1, 6);
  detectPatterns(a.account, AS_OF);
  const detected = activePatterns()[0];
  const res = await create({
    accountId: a.account,
    counterparty: 'Sähkö Virtanen',
    kind: 'recurring',
    interval: 'monthly',
    expectedAmount: 60,
    evidenceTransactionIds: [ids[5]],
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { error: 'pattern_exists', details: { patternId: detected.id, origin: 'detected', state: 'unconfirmed' } });
});

test('create: a stopped (inactive) detected pattern is taken over, keeping its id: one row per counterparty', async () => {
  const a = mkAccount();
  monthly(a, 'Lehti Sanomat', -15, 10, 1, 3);
  detectPatterns(a.account, '2026-03-31');
  const old = rows('Lehti Sanomat');
  assert.equal(old.length, 1);
  // A later booking moves the detection window on: the three old charges have stopped.
  charge(a, 'Muu Kauppa', -5, '2026-12-01');
  detectPatterns(a.account, '2026-12-31');
  assert.equal(rows('Lehti Sanomat')[0].is_active, 0);

  const fresh = charge(a, 'Lehti Sanomat', -16, '2026-12-10');
  const res = await create({
    accountId: a.account,
    counterparty: 'Lehti Sanomat',
    kind: 'subscription',
    interval: 'monthly',
    expectedAmount: 16,
    evidenceTransactionIds: [fresh],
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().pattern.id, old[0].id);
  assert.equal(res.json().pattern.origin, 'created');
  assert.equal(rows('Lehti Sanomat').length, 1);
});

// ── Validation ──────────────────────────────────────────────────────

test('create: evidence must exist and be booked charges of that account and counterparty', async () => {
  const { a, id, body } = newContract();
  const other = mkAccount('Säästötili');
  const elsewhere = charge(other, 'Kuntosali Liikku', -39.9, '2026-06-04');
  const otherShop = charge(a, 'Ruokakauppa Kulma', -39.9, '2026-06-05');
  const refund = charge(a, 'Kuntosali Liikku', 39.9, '2026-06-06');
  const pending = charge(a, 'Kuntosali Liikku', -39.9, null);
  const transferOut = charge(a, 'Kuntosali Liikku', -39.9, '2026-05-04');
  const transferIn = charge(other, 'Oma siirto', 39.9, '2026-05-04');
  db.prepare('INSERT INTO transfer_links (id, created_at, from_transaction_id, to_transaction_id, confidence) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), new Date().toISOString(), transferOut, transferIn, 100);
  const near = charge(a, 'Kuntosali Liikku', -39.9, '2026-06-14');
  const pricey = charge(a, 'Kuntosali Liikku', -59.9, '2026-04-04');

  const cases: Array<[Partial<Body>, number, string, unknown?]> = [
    [{ ...body, accountId: 'no-such-account' }, 404, 'account_not_found'],
    [{ ...body, evidenceTransactionIds: ['no-such-transaction'] }, 400, 'evidence_not_found', { transactionIds: ['no-such-transaction'] }],
    [{ ...body, evidenceTransactionIds: [id, id] }, 400, 'evidence_duplicate', { transactionIds: [id] }],
    [{ ...body, evidenceTransactionIds: [elsewhere] }, 400, 'evidence_other_account', { transactionIds: [elsewhere] }],
    [{ ...body, evidenceTransactionIds: [id, otherShop] }, 400, 'evidence_other_counterparty', { transactionIds: [otherShop] }],
    [{ ...body, evidenceTransactionIds: [refund] }, 400, 'evidence_not_charge', { transactionIds: [refund] }],
    [{ ...body, evidenceTransactionIds: [pending] }, 400, 'evidence_not_booked', { transactionIds: [pending] }],
    [{ ...body, evidenceTransactionIds: [transferOut] }, 400, 'evidence_transfer', { transactionIds: [transferOut] }],
    [{ ...body, evidenceTransactionIds: [pricey, id] }, 400, 'evidence_amount_mismatch', { transactionIds: [pricey], expectedAmount: 39.9, tolerance: 0.2 }],
    [{ ...body, evidenceTransactionIds: [id, near] }, 400, 'evidence_interval_mismatch', { transactionIds: [id, near], minDaysApart: 20 }],
    [{ ...body, counterparty: 'Ruokakauppa Kulma' }, 400, 'evidence_other_counterparty', { transactionIds: [id] }],
  ];
  for (const [payload, status, error, details] of cases) {
    const res = await create(payload);
    assert.equal(res.statusCode, status, `${error}: ${res.body}`);
    assert.equal(res.json().error, error);
    if (details !== undefined) assert.deepEqual(res.json().details, details, error);
  }

  for (const bad of [
    { ...body, kind: 'annual' },
    { ...body, interval: 'yearly' },
    { ...body, expectedAmount: -39.9 },
    { ...body, evidenceTransactionIds: [] },
    { ...body, counterparty: '' },
  ]) {
    const res = await create(bad as Partial<Body>);
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.equal(res.json().error, 'invalid_request');
  }

  // Nothing was written by any refused request.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recurring_patterns').get()!.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pattern_decisions').get()!.n, 0);
});

test('create: weekly charges must be at least 5 days apart', async () => {
  const a = mkAccount();
  const ids = ['2026-06-01', '2026-06-08', '2026-06-11'].map((d) => charge(a, 'Lounasravintola Pata', -11.5, d));
  const base = {
    accountId: a.account,
    counterparty: 'Lounasravintola Pata',
    kind: 'recurring' as const,
    interval: 'weekly' as const,
    expectedAmount: 11.5,
  };
  const bad = await create({ ...base, evidenceTransactionIds: ids });
  assert.equal(bad.json().error, 'evidence_interval_mismatch');
  assert.deepEqual(bad.json().details, { transactionIds: [ids[1], ids[2]], minDaysApart: 5 });
  const ok = await create({ ...base, evidenceTransactionIds: ids.slice(0, 2) });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().pattern.interval_days, 7);
  assert.equal(ok.json().pattern.occurrence_count, 2);
});

// ── Detection never removes, rewrites or duplicates it ─────────────

test('detection: later charges attach to a created pattern; when detection finds it too there is still one, unchanged', async () => {
  const { a, body } = newContract();
  const { pattern } = (await create(body)).json();

  // Three more months: detection alone would now find this subscription.
  monthly(a, 'Kuntosali Liikku', -39.9, 4, 7, 9);
  detectPatterns(a.account, '2026-09-30');

  const [row] = rows('Kuntosali Liikku');
  assert.equal(rows('Kuntosali Liikku').length, 1);
  assert.equal(row.id, pattern.id);
  assert.equal(row.origin, 'created');
  assert.equal(row.is_active, 1);
  assert.equal(row.pattern_type, 'subscription');
  assert.equal(row.typical_amount, 39.9, 'the expected amount stays');
  assert.equal(row.interval_days, 30);
  assert.equal(row.occurrence_count, 4, 'the evidence and three later charges');
  assert.equal(String(row.last_seen).slice(0, 10), '2026-09-04');
  assert.equal(computeMonthlyForecast(1, '2026-09-30', []).knownFixed.filter((i) => i.counterparty === 'Kuntosali Liikku').length, 1);

  // Purchases from the same counterparty are not charges of it: one far from the expected
  // amount, nor one near it in a month that already has its charge.
  charge(a, 'Kuntosali Liikku', -120, '2026-09-20');
  charge(a, 'Kuntosali Liikku', -38, '2026-09-12');
  detectPatterns(a.account, '2026-09-30');
  assert.equal(rows('Kuntosali Liikku')[0].occurrence_count, 4);
  assert.equal(rows('Kuntosali Liikku')[0].is_active, 1);
  assert.equal(rows('Kuntosali Liikku')[0].typical_amount, 39.9);
});

test('detection: a created pattern is never deactivated, also when no new charge comes or detection runs again for new rules', async () => {
  const { a, body } = newContract();
  const { pattern } = (await create(body)).json();
  const before = rows('Kuntosali Liikku');

  detectPatterns(a.account, AS_OF);
  charge(a, 'Muu Kauppa', -5, '2027-06-01'); // the window moves far past the only charge
  detectPatterns(a.account, '2027-06-30');
  db.prepare("DELETE FROM app_settings WHERE key = 'patternRulesVersion'").run();
  assert.equal(redetectPatternsIfRulesChanged('2027-06-30'), true);

  const after = rows('Kuntosali Liikku');
  assert.equal(after.length, 1);
  assert.equal(after[0].is_active, 1);
  for (const k of ['id', 'origin', 'pattern_type', 'typical_amount', 'interval_days', 'first_seen', 'created_by', 'evidence_transaction_ids']) {
    assert.equal(after[0][k], before[0][k], k);
  }
  // Kept, but lapsed: a year without a charge (pattern-lapse.test.ts).
  assert.equal(after[0].lapsed_since, '2026-08-10');
  assert.deepEqual(computeMonthlyForecast(1, '2027-06-30', []).knownFixed, []);
  assert.deepEqual(computeMonthlyForecast(1, '2027-06-30', []).lapsedRecurring.map((i) => i.patternId), [pattern.id]);
});

test('detection: annual detection and an annual confirmation never take over a created pattern', async () => {
  const a = mkAccount();
  charge(a, 'Vakuutus Turva', -300, '2025-03-15');
  const recent = charge(a, 'Vakuutus Turva', -310, '2026-03-15');
  const res = await create({
    accountId: a.account,
    counterparty: 'Vakuutus Turva',
    kind: 'recurring',
    interval: 'monthly',
    expectedAmount: 310,
    evidenceTransactionIds: [recent],
  });
  assert.equal(res.statusCode, 200, res.body);
  detectPatterns(a.account, AS_OF);
  const [row] = rows('Vakuutus Turva');
  assert.equal(row.pattern_type, 'recurring', 'not turned annual');
  assert.equal(row.typical_amount, 310);

  const confirmation = crypto.randomUUID();
  db.prepare(
    `INSERT INTO pattern_confirmations (id, created_at, account_id, counterparty_name, typical_month, typical_amount, currency, status)
     VALUES (?, ?, ?, 'Vakuutus Turva', 3, 300, 'EUR', 'pending')`
  ).run(confirmation, new Date().toISOString(), a.account);
  assert.throws(() => confirmPatternConfirmation(confirmation), /pattern_exists/);
  assert.equal(rows('Vakuutus Turva')[0].pattern_type, 'recurring');
});

// ── Decisions on a created pattern ─────────────────────────────────

test('decisions: rejecting a created pattern removes it from every count; reset withdraws it; a new decision restores it', async () => {
  const { a, body } = newContract();
  const { pattern } = (await create(body)).json();

  decidePattern(pattern.id, 'not_recurring', 'user');
  detectPatterns(a.account, AS_OF);
  assert.deepEqual(fixed(), []);
  assert.deepEqual(uncertain(), []);
  assert.deepEqual(subscriptions(), []);
  assert.deepEqual(listed(), []);

  // Reset: nobody vouches for it and its single charge does not establish it.
  const reset = decidePattern(pattern.id, 'reset', 'user');
  assert.equal(reset.pattern.state, 'unconfirmed');
  assert.equal(reset.pattern.established, false);
  assert.deepEqual(fixed(), []);
  assert.deepEqual(uncertain(), [], 'not even uncertain: detection never proposed it');
  assert.deepEqual(listed(), []);
  assert.deepEqual(recurringQuestions(), [], 'not asked about either');
  assert.equal(rows('Kuntosali Liikku')[0].is_active, 1, 'kept, with its history');

  decidePattern(pattern.id, 'recurring', ACTOR);
  assert.deepEqual(fixed(), ['Kuntosali Liikku']);
  assert.deepEqual(subscriptions(), []);
});

test('decisions: after a reset a created pattern whose own charges establish it counts like a detected one', async () => {
  const { a, body } = newContract();
  const { pattern } = (await create(body)).json();
  monthly(a, 'Kuntosali Liikku', -39.9, 4, 7, 11);
  detectPatterns(a.account, '2026-11-30');
  decidePattern(pattern.id, 'reset', 'user');
  const p = activePatterns().find((x) => x.id === pattern.id)!;
  assert.equal(p.state, 'unconfirmed');
  assert.ok(p.confidence! >= 0.75, String(p.confidence));
  assert.equal(p.established, true);
  assert.deepEqual(computeMonthlyForecast(1, '2026-11-30', []).knownFixed.map((i) => i.patternId), [pattern.id]);

  // Withdrawn, it is detection's: found again, it becomes a detected pattern, still one row.
  detectPatterns(a.account, '2026-11-30');
  assert.equal(rows('Kuntosali Liikku').length, 1);
  assert.equal(rows('Kuntosali Liikku')[0].origin, 'detected');
  assert.equal(rows('Kuntosali Liikku')[0].created_by, ACTOR, 'who created it stays as history');
  assert.deepEqual(computeMonthlyForecast(1, '2026-11-30', []).knownFixed.map((i) => i.patternId), [pattern.id]);
});

test('decisions: a withdrawn created pattern follows its charges: a new price is detected, stopped ones end it', async () => {
  const { a, body } = newContract();
  const { pattern } = (await create(body)).json();
  decidePattern(pattern.id, 'reset', 'user');
  // Six months at a new price, outside the 20 % of the old expected amount.
  monthly(a, 'Kuntosali Liikku', -59.9, 4, 7, 12);
  detectPatterns(a.account, '2026-12-31');
  const [row] = rows('Kuntosali Liikku');
  assert.equal(rows('Kuntosali Liikku').length, 1);
  assert.equal(row.id, pattern.id);
  assert.equal(row.origin, 'detected');
  assert.equal(row.typical_amount, 59.9);
  assert.deepEqual(computeMonthlyForecast(1, '2026-12-31', []).knownFixed.map((i) => i.amount), [59.9]);

  // Another withdrawn one whose single charge is all there is: detection ends it.
  const b = mkAccount('Toinen tili');
  const [only] = monthly(b, 'Lehti Sanomat', -15, 10, 6, 6);
  const other = (await create({ ...body, accountId: b.account, counterparty: 'Lehti Sanomat', expectedAmount: 15, evidenceTransactionIds: [only] })).json();
  decidePattern(other.pattern.id, 'reset', 'user');
  detectPatterns(b.account, AS_OF);
  assert.equal(rows('Lehti Sanomat')[0].is_active, 0);
});

test('detection: a created pattern still vouched for stays active after its charges stop, but lapses and counts nowhere', async () => {
  const { a, body } = newContract();
  await create(body);
  charge(a, 'Muu Kauppa', -5, '2027-06-01');
  detectPatterns(a.account, '2027-06-30');
  assert.deepEqual(listed(), ['Kuntosali Liikku']);
  assert.deepEqual(computeMonthlyForecast(1, '2027-06-30', []).knownFixed, []);
  assert.deepEqual(subscriptions(), []);
});
