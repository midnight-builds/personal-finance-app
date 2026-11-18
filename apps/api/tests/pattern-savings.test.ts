import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { db } from '../src/db.js';
import { detectPatterns, redetectPatternsIfRulesChanged } from '../src/patterns.js';
import { activePatterns, decidePattern, establishedSubscriptions, recurringQuestions } from '../src/patternDecisions.js';
import { computeMonthlyForecast } from '../src/forecast.js';
import { getHouseholdSummary } from '../src/summary.js';
import { resetDb } from './setup/resetDb.js';

// Savings and investment paid by card: a fixed monthly fund purchase charges like a
// subscription, but is not one (GLOSSARY.md, "Savings pattern"). Every counterparty
// here is fictional.

const AS_OF = '2026-06-30';

beforeEach(() => resetDb());
after(() => resetDb());

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

/** One card charge on day 5 of each month January–June. */
function monthly(a: Acct, counterparty: string, amount: number, description: string | null = null) {
  for (let m = 1; m <= 6; m++) {
    const date = `2026-0${m}-05`;
    const raw = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(raw, now, a.session, '{}', date, amount, 'EUR');
    db.prepare('INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name, description, counterparty_iban) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), now, raw, a.session, a.account, date, date, amount, 'EUR', counterparty, description, null);
  }
}

// A fund purchase as the bank describes it: units bought at a price, with a fee.
const FUND_ORDER = 'MERKINTÄ   Testi Maailma Osake KPL KURSSI            12,34500 PALKKIO              0,00';

const pattern = (counterparty: string) => activePatterns().find((p) => p.counterparty_name === counterparty);
const question = (counterparty: string) => recurringQuestions().find((q) => q.counterparty === counterparty);
const forecast = () => computeMonthlyForecast(1, AS_OF);
const fixed = () => forecast().knownFixed.map((i) => i.counterparty);
const uncertain = () => forecast().uncertainRecurring.map((i) => i.counterparty);
const subscriptions = () => establishedSubscriptions().map((p) => p.counterparty_name);

function setup() {
  const a = mkAccount();
  monthly(a, 'Testi Maailma Osake', -20, FUND_ORDER); // fund purchase, told by its description
  monthly(a, 'Testirahasto Oy', -50); // monthly saving, told by its name
  monthly(a, 'Suoratoisto Testi', -12.99); // a real streaming subscription
  monthly(a, 'Kuntosali Testi', -39); // another fixed card charge
  detectPatterns(a.account, AS_OF);
  return a;
}

test('a fund purchase or monthly saving by card is a savings pattern, not a subscription', () => {
  setup();
  for (const cp of ['Testi Maailma Osake', 'Testirahasto Oy']) {
    const p = pattern(cp)!;
    assert.equal(p.pattern_type, 'recurring', cp);
    assert.equal(p.savings, true, cp);
    assert.ok(p.confidence! >= 0.75, `${cp}: steady charges, confident`);
    assert.equal(p.established, false, `${cp}: unconfirmed savings needs the user's word`);
  }
  for (const cp of ['Suoratoisto Testi', 'Kuntosali Testi']) {
    assert.equal(pattern(cp)!.pattern_type, 'subscription', cp);
    assert.equal(pattern(cp)!.savings, false, cp);
  }
});

test('unconfirmed savings stays out of the subscription total and creep, and the forecast keeps it apart', () => {
  setup();
  assert.deepEqual(subscriptions().sort(), ['Kuntosali Testi', 'Suoratoisto Testi']);
  assert.equal(getHouseholdSummary(AS_OF).monthlySubscriptions, 51.99);
  assert.deepEqual(fixed().sort(), ['Kuntosali Testi', 'Suoratoisto Testi']);
  assert.deepEqual(uncertain().sort(), ['Testi Maailma Osake', 'Testirahasto Oy']);
  const item = forecast().uncertainRecurring.find((i) => i.counterparty === 'Testirahasto Oy')!;
  assert.equal(item.type, 'recurring');
  assert.equal(item.state, 'unconfirmed');
  assert.equal(item.savings, true);
});

test('unconfirmed savings is asked about as a recurring question', () => {
  setup();
  const q = question('Testi Maailma Osake')!;
  assert.ok(q, 'asked although confident');
  assert.equal(q.suggestedAnswer, 'recurring');
  assert.ok(q.reasons.includes('savings'));
  assert.ok(q.reasons.includes('fixed_amount_card'));
  assert.ok(!q.reasons.includes('low_confidence'), 'its charges are steady');
  assert.equal(question('Suoratoisto Testi'), undefined);
});

test('a decision settles a savings pattern', () => {
  setup();
  decidePattern(pattern('Testirahasto Oy')!.id, 'recurring', 'user');
  assert.ok(fixed().includes('Testirahasto Oy'));
  assert.ok(!subscriptions().includes('Testirahasto Oy'));
  assert.equal(question('Testirahasto Oy'), undefined);

  // The user may still call it a subscription: then it is one.
  decidePattern(pattern('Testi Maailma Osake')!.id, 'subscription', 'user');
  assert.ok(subscriptions().includes('Testi Maailma Osake'));
});

test('re-detection reclassifies a savings pattern stored as a subscription, transactions untouched', () => {
  const a = setup();
  // As the previous rules left it.
  db.prepare("UPDATE recurring_patterns SET pattern_type = 'subscription', savings = NULL WHERE counterparty_name = 'Testi Maailma Osake'").run();
  db.prepare("DELETE FROM app_settings WHERE key = 'patternRulesVersion'").run();
  const before = db.prepare('SELECT * FROM normalized_transactions ORDER BY id').all();

  assert.equal(redetectPatternsIfRulesChanged(AS_OF), true);
  assert.equal(pattern('Testi Maailma Osake')!.pattern_type, 'recurring');
  assert.ok(!subscriptions().includes('Testi Maailma Osake'));
  assert.deepEqual(db.prepare('SELECT * FROM normalized_transactions ORDER BY id').all(), before);
  assert.ok(a);
});

test('words alone in a message, a savings bank or investment news are not savings', () => {
  const a = mkAccount();
  monthly(a, 'Säästöpankin palvelumaksu', -6); // a bank fee
  monthly(a, 'Sijoitustieto Testi', -9.9); // an investment newsletter
  monthly(a, 'Suoratoisto Toinen', -7.99, 'säästä vuositilauksella'); // a message, not saving
  detectPatterns(a.account, AS_OF);
  for (const cp of ['Säästöpankin palvelumaksu', 'Sijoitustieto Testi', 'Suoratoisto Toinen']) {
    assert.equal(pattern(cp)!.savings, false, cp);
    assert.equal(pattern(cp)!.pattern_type, 'subscription', cp);
  }
});
