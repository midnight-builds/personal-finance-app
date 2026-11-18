import crypto from 'crypto';
import { db } from './db.js';
import { daysBefore, ledgerEntries, today, type LedgerEntry } from './ledger.js';

// How far a monthly charge may book from its due day. Booking only slips later
// (weekends, holidays, card processing), so the late side is wider.
const DUE_DAY_EARLY = 3;
const DUE_DAY_LATE = 5;

/** Due date (UTC ms) on `day` of month `monthIndex` (0-based, may overflow years), clamped to the month's last day. */
function dueDate(year: number, monthIndex: number, day: number): number {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Date.UTC(year, monthIndex, Math.min(day, lastDay));
}

/**
 * Whether one charge falls due on `day` of each consecutive month: the k-th charge books
 * within the tolerance of the k-th month's due date. The first charge may belong to the
 * previous or next month (due the 31st, booked on the 1st). Two charges in one month
 * or a skipped month break the chain.
 */
function fitsMonthlyChain(days: string[], day: number): boolean {
  const [y, m] = days[0].split('-').map(Number);
  return [-1, 0, 1].some((shift) =>
    days.every((d, k) => {
      const offset = (Date.parse(d) - dueDate(y, m - 1 + shift + k, day)) / 86400_000;
      return offset >= -DUE_DAY_EARLY && offset <= DUE_DAY_LATE;
    })
  );
}

/**
 * A subscription charges the same amount on about the same day every month, with no
 * other charge from the counterparty in between; the due day is tried from the charges'
 * own days. Habitual purchases (groceries, lunch) vary in amount or day. A counterparty
 * paid only to an IBAN is a person or an e-invoice biller and stays recurring, and so
 * does one that is saved or invested in (`isSavingsCharge`). `occurrences` is in date order.
 */
function isSubscription(occurrences: Array<{ amount: number; date: string; viaIban: boolean; savings?: boolean }>): boolean {
  if (occurrences.every((o) => o.viaIban)) return false;
  if (isSavingsPattern(occurrences)) return false;
  const cents = Math.round(occurrences[0].amount * 100);
  if (occurrences.some((o) => Math.round(o.amount * 100) !== cents)) return false;
  const days = occurrences.map((o) => o.date.slice(0, 10));
  return [...new Set(days.map((d) => Number(d.slice(8))))].some((day) => fitsMonthlyChain(days, day));
}

/**
 * Two charges give one interval, which any pair of purchases a month apart passes.
 * Recurring patterns feed the forecast as fixed costs just like subscriptions, so a
 * pair is not even recurring: it needs a third occurrence to show a rhythm.
 */
const MIN_OCCURRENCES = 3;

// A fund purchase as Nordea describes it: "MERKINTÄ <fund> KPL KURSSI <price> PALKKIO <fee>".
// `\b` is ASCII-only: it never falls after the Ä.
const FUND_ORDER = /^\s*MERKINTÄ\s.*\bKURSSI\b/iu;
// Matched on the counterparty only: free-text messages and words like "sijoitus" name too
// much else (a newsletter, a rented flat). A savings bank is a bank, not saving.
const SAVINGS_WORDS = /rahasto|säästö(?!pank)|\bfunds?\b|\betf\b/iu;

/**
 * Whether a charge is saved or invested rather than spent: a fund purchase by its
 * description, or a counterparty naming a fund or saving.
 * A fixed monthly fund purchase by card charges like a subscription but is not one
 * (GLOSSARY.md, "Savings pattern").
 */
export function isSavingsCharge(counterparty: string | null, description: string | null): boolean {
  return FUND_ORDER.test(description ?? '') || SAVINGS_WORDS.test(counterparty ?? '');
}

/** Most charges (over half) are saved or invested: one odd message does not make a pattern savings. */
const isSavingsPattern = (charges: Array<{ savings?: boolean }>) =>
  charges.filter((c) => c.savings).length * 2 > charges.length;

export type Occurrence = {
  id: string; counterparty: string; amount: number; date: string; viaIban: boolean;
  /** Saved or invested, not spent (`isSavingsCharge`). */
  savings?: boolean;
};
type Charge = Omit<Occurrence, 'counterparty' | 'id'>;

/**
 * Confidence a monthly or weekly pattern reaches without the user's word: from this
 * on it counts as a fixed cost in the forecast and, if a subscription, in the
 * subscription total. Below it the pattern is uncertain (GLOSSARY.md).
 */
export const CONFIDENT = 0.75;

export type ConfidenceFactors = { charges: number; interval: number; amount: number };
export type PatternScore = {
  confidence: number;
  factors: ConfidenceFactors;
  /** Every charge had the same amount, to the cent. */
  amountFixed: boolean;
  /** `account_payment`: every charge went to an IBAN (a person or an e-invoice biller); `card`: none did. */
  paymentMethod: 'account_payment' | 'card' | 'mixed';
  /** Most charges were saved or invested (`isSavingsCharge`): a savings pattern. */
  savings: boolean;
};

const round2 = (x: number) => Math.round(x * 100) / 100;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Coefficient of variation: population standard deviation over the mean (0 for a single value). */
function variation(xs: number[]): number {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  if (mean === 0) return 0;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / mean;
}

/**
 * How strongly a pattern's charges (in date order) show a steady rhythm, 0–1:
 *
 *   confidence = 0.4 × charges + 0.3 × interval + 0.3 × amount
 *   charges  = min(1, (n − 2) / 3)               3 charges 0.33, 4 0.67, 5+ 1
 *   interval = max(0, 1 − cv(days between) / 0.5)
 *   amount   = max(0, 1 − cv(amounts) / 0.15)
 *
 * cv is the coefficient of variation. Factors and the result are rounded to two
 * decimals, so the stored factors reproduce the confidence. Three charges never reach
 * CONFIDENT; four steady ones do.
 */
export function scorePattern(charges: Charge[]): PatternScore {
  const days = charges.map((c) => Date.parse(c.date.slice(0, 10)) / 86400_000);
  const intervals = days.slice(1).map((d, i) => d - days[i]);
  const amounts = charges.map((c) => Math.abs(c.amount));
  const factors: ConfidenceFactors = {
    charges: round2(clamp01((charges.length - 2) / 3)),
    interval: round2(intervals.length === 0 ? 0 : clamp01(1 - variation(intervals) / 0.5)),
    amount: round2(clamp01(1 - variation(amounts) / 0.15)),
  };
  const cents = Math.round(amounts[0] * 100);
  const viaIban = charges.filter((c) => c.viaIban).length;
  return {
    confidence: round2(0.4 * factors.charges + 0.3 * factors.interval + 0.3 * factors.amount),
    factors,
    amountFixed: amounts.every((a) => Math.round(a * 100) === cents),
    paymentMethod: viaIban === charges.length ? 'account_payment' : viaIban === 0 ? 'card' : 'mixed',
    savings: isSavingsPattern(charges),
  };
}

/**
 * An account's countable expenses with a counterparty since `from`, ordered by
 * counterparty, then booking date. Counterparties that ever took part in a
 * transfer on this account are left out entirely, so own-account transfer
 * counterparties (e.g. "Siirto") never look like recurring spend.
 */
function recurringCandidates(entries: LedgerEntry[], from: string): Occurrence[] {
  const transferCounterparties = new Set(
    entries.filter((e) => e.isTransfer && e.counterparty !== null).map((e) => e.counterparty)
  );
  return entries
    .filter(
      (e) =>
        !e.isTransfer &&
        e.date >= from &&
        e.amount < 0 &&
        e.counterparty !== null &&
        !transferCounterparties.has(e.counterparty)
    )
    .map((e) => ({
      id: e.id,
      counterparty: e.counterparty!,
      amount: e.amount,
      date: e.bookedAt,
      viaIban: e.counterpartyIban !== null,
      savings: isSavingsCharge(e.counterparty, e.description),
    }))
    .sort((a, b) => binary(a.counterparty, b.counterparty) || binary(a.date, b.date));
}

// SQLite's default (BINARY) text order, which the detection used to iterate in.
const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function byCounterparty(rows: Occurrence[]) {
  const groups = new Map<string, Charge[]>();
  for (const r of rows) {
    if (!groups.has(r.counterparty)) groups.set(r.counterparty, []);
    groups.get(r.counterparty)!.push({ amount: r.amount, date: r.date, viaIban: r.viaIban, savings: r.savings });
  }
  return groups;
}

/**
 * Detection window of monthly and weekly patterns: the 180 days up to the account's
 * latest booking on or before the detection day. Ending it at the account's own data,
 * not at the calendar day, keeps an account whose exports lag behind from looking as
 * if its charges had stopped.
 */
const WINDOW_DAYS = 180;

function windowStart(entries: LedgerEntry[], asOf: string): string {
  return daysBefore(entries.at(-1)?.date ?? asOf, WINDOW_DAYS);
}

/**
 * The charges monthly/weekly patterns of an account rest on as of `asOf` (default:
 * today), per counterparty: its countable expenses in the detection window, found as
 * detection finds them. Oldest first.
 */
export function patternChargesOf(accountId: string, asOf: string = today()): Map<string, Occurrence[]> {
  const entries = ledgerEntries({ accounts: [accountId], to: asOf, includeTransfers: true });
  const charges = new Map<string, Occurrence[]>();
  for (const o of recurringCandidates(entries, windowStart(entries, asOf))) {
    if (!charges.has(o.counterparty)) charges.set(o.counterparty, []);
    charges.get(o.counterparty)!.push(o);
  }
  return charges;
}

const SCORE_COLUMNS = ['confidence', 'confidence_factors', 'amount_fixed', 'payment_method', 'savings'] as const;
const scoreValues = (s: PatternScore) =>
  [s.confidence, JSON.stringify(s.factors), s.amountFixed ? 1 : 0, s.paymentMethod, s.savings ? 1 : 0] as const;

/** Detects recurring, annual and confirmation-worthy payments of one account as of `asOf` (default: today). */
export function detectPatterns(accountId: string, asOf: string = today()): void {
  const now = new Date().toISOString();
  // Transfers are included only to find the counterparties to leave out.
  const entries = ledgerEntries({ accounts: [accountId], to: asOf, includeTransfers: true });
  const rows = recurringCandidates(entries, windowStart(entries, asOf));
  const groups = byCounterparty(rows);
  const detected = new Set<string>();

  for (const [counterparty, occurrences] of groups) {
    if (occurrences.length < MIN_OCCURRENCES) continue;

    // Check interval consistency — sort by date
    const sorted = occurrences.sort((a, b) => a.date.localeCompare(b.date));
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const a = new Date(sorted[i - 1].date).getTime();
      const b = new Date(sorted[i].date).getTime();
      intervals.push((b - a) / 86400_000);
    }

    const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    // Accept monthly (25–35 days) or weekly (6–8 days)
    const isMonthly = avgInterval >= 25 && avgInterval <= 35;
    const isWeekly = avgInterval >= 6 && avgInterval <= 8;
    if (!isMonthly && !isWeekly) continue;

    // Check amount consistency (±20%)
    // typical_amount is stored as a positive absolute value (e.g. 15.99, not -15.99)
    const amounts = sorted.map((o) => Math.abs(o.amount));
    const avgAmount = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    if (avgAmount === 0) continue;
    const consistent = amounts.every((a) => Math.abs(a - avgAmount) / avgAmount <= 0.2);
    if (!consistent) continue;

    const patternType = isSubscription(sorted) ? 'subscription' : 'recurring';
    const score = scorePattern(sorted);
    detected.add(counterparty);
    const firstSeen = sorted[0].date;
    const lastSeen = sorted[sorted.length - 1].date;

    // Upsert by account_id + counterparty_name
    const existing = db.prepare(
      `SELECT p.id, ${VOUCHED_CREATED} AS vouched FROM recurring_patterns p WHERE p.account_id = ? AND p.counterparty_name = ?`
    ).get(accountId, counterparty) as { id: string; vouched: number } | undefined;

    // Found by detection too: still the one created pattern, whose charges `refreshCreated`
    // updates. A withdrawn one is detection's from now on: it becomes a detected pattern.
    if (existing?.vouched) continue;
    if (existing) {
      db.prepare(`
        UPDATE recurring_patterns
        SET updated_at = ?, pattern_type = ?, interval_days = ?, typical_amount = ?,
            last_seen = ?, occurrence_count = ?, is_active = 1, origin = 'detected',
            ${SCORE_COLUMNS.map((c) => `${c} = ?`).join(', ')}
        WHERE id = ?
      `).run(now, patternType, Math.round(avgInterval), avgAmount, lastSeen, sorted.length, ...scoreValues(score), existing.id);
    } else {
      db.prepare(`
        INSERT INTO recurring_patterns
          (id, created_at, updated_at, account_id, counterparty_name, pattern_type,
           interval_days, typical_amount, currency, first_seen, last_seen, occurrence_count, is_active,
           ${SCORE_COLUMNS.join(', ')})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, 1, ${SCORE_COLUMNS.map(() => '?').join(', ')})
      `).run(
        crypto.randomUUID(), now, now, accountId, counterparty, patternType,
        Math.round(avgInterval), avgAmount, firstSeen, lastSeen, sorted.length, ...scoreValues(score)
      );
    }
  }

  reviseUndetected(accountId, groups, detected, now);
  refreshCreated(accountId, entries, now);

  const longHistory = recurringCandidates(entries, daysBefore(asOf, 1460));
  detectAnnualPatternsForAccount(accountId, longHistory);
  detectConfirmationCandidates(accountId, longHistory);
  // Last: annual detection may have retyped a row.
  markLapsed(accountId, entries);
}

/**
 * Active monthly/weekly patterns of the account that this run did not detect. One first
 * found on fewer than MIN_OCCURRENCES charges was detected on too little evidence, and one
 * with fewer such charges left in the window has stopped: both are deactivated. Otherwise
 * it stays active, since a varying price or a skipped month says nothing against a known
 * bill, but a subscription that no longer qualifies as one becomes recurring; its
 * confidence is scored again from the charges left.
 * A pattern with a user decision (pattern_decisions) is only ever deactivated when it
 * has stopped; the decision itself is not touched and applies again if the charges
 * resume. User-confirmed annual patterns stay as is, and so do created patterns
 * still vouched for (`refreshCreated`); a withdrawn one is revised like a detected one.
 */
function reviseUndetected(
  accountId: string,
  groups: Map<string, Charge[]>,
  detected: Set<string>,
  now: string
): void {
  const rows = db.prepare(`
    SELECT p.id, p.counterparty_name, p.pattern_type, p.occurrence_count,
           EXISTS (SELECT 1 FROM pattern_decisions d
                   WHERE d.account_id = p.account_id AND d.counterparty_name = p.counterparty_name
                     AND d.annual = 0) AS decided
    FROM recurring_patterns p
    WHERE p.account_id = ? AND p.is_active = 1 AND p.pattern_type IN ('subscription', 'recurring')
      AND p.user_confirmed IS NOT 1 AND NOT ${VOUCHED_CREATED}
  `).all(accountId) as Array<{
    id: string; counterparty_name: string | null; pattern_type: string; occurrence_count: number; decided: number;
  }>;
  const deactivate = db.prepare('UPDATE recurring_patterns SET is_active = 0, updated_at = ? WHERE id = ?');
  const demote = db.prepare("UPDATE recurring_patterns SET pattern_type = 'recurring', updated_at = ? WHERE id = ?");
  const rescore = db.prepare(
    `UPDATE recurring_patterns SET ${SCORE_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
  );
  for (const r of rows) {
    if (r.counterparty_name !== null && detected.has(r.counterparty_name)) continue;
    const occurrences = r.counterparty_name === null ? [] : groups.get(r.counterparty_name) ?? [];
    const stopped = occurrences.length < MIN_OCCURRENCES;
    const tooLittleEvidence = r.occurrence_count < MIN_OCCURRENCES && !r.decided;
    if (stopped || tooLittleEvidence) {
      deactivate.run(now, r.id);
      continue;
    }
    const sorted = [...occurrences].sort((a, b) => a.date.localeCompare(b.date));
    rescore.run(...scoreValues(scorePattern(sorted)), r.id);
    if (r.pattern_type === 'subscription' && !isSubscription(sorted)) demote.run(now, r.id);
  }
}

// ── Created patterns ────────────────────────────────────────────────
// A pattern an actor created (GLOSSARY.md, "Created pattern"; patternCreation.ts).
// While vouched for, detection never deactivates, retypes or re-prices one, and never
// adds a second row for its counterparty: what the actor said stays until a pattern
// decision or a new create request changes it. A `reset` withdraws it: detection then
// treats it as its own, revising, deactivating or (finding it) making it detected.

/**
 * SQL, true for a pattern `p` an actor created and still vouches for: its latest
 * decision (keyed by account and counterparty, as everywhere, and of its kind:
 * annual or monthly/weekly) is not `reset`.
 */
const VOUCHED_CREATED = `(p.origin = 'created' AND COALESCE((
    SELECT d.decision FROM pattern_decisions d
    WHERE d.account_id = p.account_id AND d.counterparty_name = p.counterparty_name
      AND d.annual = (p.pattern_type = 'annual')
    ORDER BY d.id DESC LIMIT 1), '') != 'reset')`;

/**
 * Two charges of a created pattern closer than this are not two of its periods.
 * Yearly: detection's shortest annual interval.
 */
export const MIN_DAYS_APART: Record<Period, number> = { weekly: 5, monthly: 20, yearly: 330 };

/**
 * How far a created pattern's charge may be from its expected amount: detection's
 * ±20 % for monthly and weekly patterns, its ±25 % for annual ones.
 */
export const CREATED_AMOUNT_TOLERANCE: Record<Period, number> = { weekly: 0.2, monthly: 0.2, yearly: 0.25 };

/** Whether a charge of `amount` (signed) fits a created pattern of `period` expecting `expected` (positive). */
export function fitsExpectedAmount(amount: number, expected: number, period: Period): boolean {
  // Cents, so 20 % of a round amount is not lost to floating point.
  return (
    Math.abs(Math.round(Math.abs(amount) * 100) - Math.round(expected * 100)) <=
    Math.round(expected * 100) * CREATED_AMOUNT_TOLERANCE[period]
  );
}

/**
 * The charges of a created pattern: the account's countable expenses with its
 * counterparty, from its first cited charge on, each within the tolerance of its
 * expected amount, and at most one per period (one `MIN_DAYS_APART` from the
 * previous). Later charges attach to it this way. `entries` and the result are
 * oldest first.
 */
function createdPatternCharges(
  entries: LedgerEntry[],
  p: {
    counterparty_name: string | null;
    first_seen: string;
    typical_amount: number | null;
    interval_days: number | null;
    pattern_type: string;
  }
): LedgerEntry[] {
  const from = p.first_seen.slice(0, 10);
  const period = periodOf(p.interval_days, p.pattern_type);
  const minDays = MIN_DAYS_APART[period];
  const charges: LedgerEntry[] = [];
  for (const e of entries) {
    const fits =
      !e.isTransfer &&
      e.amount < 0 &&
      e.counterparty === p.counterparty_name &&
      e.date >= from &&
      fitsExpectedAmount(e.amount, p.typical_amount ?? 0, period);
    const previous = charges.at(-1);
    if (fits && (!previous || (Date.parse(e.date) - Date.parse(previous.date)) / 86400_000 >= minDays)) charges.push(e);
  }
  return charges;
}

/**
 * Updates what the charges of the account's vouched-for created patterns show: the
 * latest one, how many there are and their confidence, and for a yearly one its
 * typical month (that of the latest charge, as detection sets it). Type, interval,
 * expected amount and activity stay as created.
 */
function refreshCreated(accountId: string, entries: LedgerEntry[], now: string): void {
  const rows = db
    .prepare(
      `SELECT p.id, p.counterparty_name, p.first_seen, p.typical_amount, p.interval_days, p.pattern_type,
              p.typical_month
       FROM recurring_patterns p
       WHERE p.account_id = ? AND ${VOUCHED_CREATED}`
    )
    .all(accountId) as Array<{
    id: string;
    counterparty_name: string | null;
    first_seen: string;
    typical_amount: number | null;
    interval_days: number | null;
    pattern_type: string;
    typical_month: number | null;
  }>;
  const update = db.prepare(
    `UPDATE recurring_patterns SET updated_at = ?, last_seen = ?, occurrence_count = ?, typical_month = ?,
       ${SCORE_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
  );
  for (const r of rows) {
    const charges = createdPatternCharges(entries, r);
    if (charges.length === 0) continue; // detection as of a day before its charges
    const score = scorePattern(
      charges.map((c) => ({
        amount: c.amount, date: c.bookedAt, viaIban: c.counterpartyIban !== null,
        savings: isSavingsCharge(c.counterparty, c.description),
      }))
    );
    const month = r.pattern_type === 'annual' ? monthOf(charges.at(-1)!.date) : r.typical_month;
    update.run(now, charges.at(-1)!.bookedAt, charges.length, month, ...scoreValues(score), r.id);
  }
}

// ── Periods and lapse ───────────────────────────────────────────────

export type Period = 'weekly' | 'monthly' | 'yearly';

/** Month 1–12 of a day YYYY-MM-DD. */
const monthOf = (day: string) => Number(day.slice(5, 7));

/**
 * How often a pattern is charged. An annual one (`pattern_type` `annual`: detected,
 * confirmed or created yearly) is yearly. A monthly/weekly one is weekly or monthly
 * by its interval: detection stores the average (6–8 days weekly, 25–35 monthly),
 * creation 7 or 30.
 */
export function periodOf(intervalDays: number | null, patternType?: string): Period {
  if (patternType === 'annual') return 'yearly';
  return (intervalDays ?? 30) <= 14 ? 'weekly' : 'monthly';
}

/** Nominal length of a period in days: the shortest that counts for a lapse. */
const PERIOD_DAYS: Record<Period, number> = { weekly: 7, monthly: 31, yearly: 365 };
/**
 * How late a period's charge may book (weekends, holidays, card processing). A yearly
 * bill may move by weeks: detection takes annual intervals up to 400 days.
 */
const LAPSE_GRACE_DAYS: Record<Period, number> = { weekly: 3, monthly: DUE_DAY_LATE, yearly: 35 };

/**
 * Days after its latest charge from which a pattern is lapsed: two periods (the
 * stored interval, at least the nominal one) plus the grace for a late booking.
 * Monthly 2 × 31 + 5 = 67, weekly 2 × 7 + 3 = 17, yearly 2 × 365 + 35 = 765.
 */
export function lapseDays(intervalDays: number | null, patternType?: string): number {
  const period = periodOf(intervalDays, patternType);
  return 2 * Math.max(intervalDays ?? 0, PERIOD_DAYS[period]) + LAPSE_GRACE_DAYS[period];
}

/**
 * Stores whether each pattern of the account has lapsed (GLOSSARY.md,
 * "Lapsed pattern"): `lapsed_since` is the day `lapseDays` after the latest charge
 * from its counterparty, once the account's latest booking (`entries`, oldest first;
 * not today, so a lagging export lapses nothing) has reached it; otherwise null.
 * A charge is any countable expense from the counterparty that is not a transfer,
 * whatever its amount, so a price change never lapses a live pattern. A new charge
 * clears the lapse on the next detection. Annual patterns lapse too, with yearly periods.
 */
function markLapsed(accountId: string, entries: LedgerEntry[]): void {
  const latestBooking = entries.at(-1)?.date;
  const lastCharge = new Map<string, string>();
  for (const e of entries) {
    if (!e.isTransfer && e.amount < 0 && e.counterparty !== null) lastCharge.set(e.counterparty, e.date);
  }
  const rows = db
    .prepare(
      `SELECT id, counterparty_name, pattern_type, interval_days, last_seen, lapsed_since, is_active
       FROM recurring_patterns WHERE account_id = ?`
    )
    .all(accountId) as Array<{
    id: string;
    counterparty_name: string | null;
    pattern_type: string;
    interval_days: number | null;
    last_seen: string;
    lapsed_since: string | null;
    is_active: number;
  }>;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const update = db.prepare('UPDATE recurring_patterns SET lapsed_since = ? WHERE id = ?');
  for (const r of rows) {
    let lapsedSince: string | null = null;
    const last = (r.counterparty_name !== null && lastCharge.get(r.counterparty_name)) || r.last_seen.slice(0, 10);
    // Inactive patterns count nowhere anyway; a row without a real day is not judged.
    if (r.is_active === 1 && latestBooking && DAY.test(last)) {
      const since = daysBefore(last, -lapseDays(r.interval_days, r.pattern_type));
      if (latestBooking >= since) lapsedSince = since;
    }
    if (lapsedSince !== r.lapsed_since) update.run(lapsedSince, r.id);
  }
}

/** `markLapsed` for an account as of `asOf` (default: today), outside detection (creating a pattern). */
export function refreshLapse(accountId: string, asOf: string = today()): void {
  markLapsed(accountId, ledgerEntries({ accounts: [accountId], to: asOf, includeTransfers: true }));
}

/**
 * How many charges of a monthly/weekly pattern fall in calendar month `month` (1–12)
 * of `year`: a monthly one has one; a weekly one has one on every day of the month
 * that is a whole number of weeks from its latest charge `lastSeen`, 4 or 5.
 */
export function chargesInMonth(intervalDays: number | null, lastSeen: string, year: number, month: number): number {
  if (periodOf(intervalDays) !== 'weekly') return 1;
  const day = (ms: number) => Math.round(ms / 86400_000);
  const anchor = day(Date.parse(lastSeen.slice(0, 10)));
  const first = day(Date.UTC(year, month - 1, 1));
  const last = day(Date.UTC(year, month, 0));
  return Math.floor((last - anchor) / 7) - Math.ceil((first - anchor) / 7) + 1;
}

/** Charges a month on average: 52/12 for a weekly pattern, 1 for a monthly one (the /kk totals). */
export function chargesPerMonth(intervalDays: number | null): number {
  return periodOf(intervalDays) === 'weekly' ? 52 / 12 : 1;
}

/**
 * Version of the detection rules. Bump it when they change, so the stored patterns of
 * every account are re-detected on the next API start instead of the next import.
 * 2: three charges minimum, subscriptions told by their charges (2026-11).
 * 3: confidence, amount_fixed and payment_method scored for every pattern (2026-11).
 * 4: lapsed_since set for every monthly/weekly pattern (2026-11).
 * 5: savings patterns told apart, never subscriptions (2026-11).
 * 6: annual patterns lapse too (2026-11).
 */
export const PATTERN_RULES_VERSION = '6';
const RULES_VERSION_KEY = 'patternRulesVersion';

/** Re-runs detection for every account, in one transaction, once per rules version. Returns whether it ran. */
export function redetectPatternsIfRulesChanged(asOf: string = today()): boolean {
  const stored = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(RULES_VERSION_KEY) as
    | { value: string }
    | undefined;
  if (stored?.value === PATTERN_RULES_VERSION) return false;

  db.exec('BEGIN');
  try {
    for (const { id } of db.prepare('SELECT id FROM accounts').all() as Array<{ id: string }>) detectPatterns(id, asOf);
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(RULES_VERSION_KEY, PATTERN_RULES_VERSION, new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

const ANNUAL_CONFIRMATION_THRESHOLD_EUR = 80;

/** Counterparties with an active recurring pattern on the account; `typeFilter` narrows by pattern type. */
function activeCounterparties(accountId: string, typeFilter = ''): Set<string | null> {
  const rows = db
    .prepare(`SELECT counterparty_name FROM recurring_patterns WHERE account_id = ? AND is_active = 1 ${typeFilter}`)
    .all(accountId) as Array<{ counterparty_name: string | null }>;
  return new Set(rows.map((r) => r.counterparty_name));
}

function detectAnnualPatternsForAccount(accountId: string, history: Occurrence[]): void {
  const now = new Date().toISOString();
  // Counterparties already detected as monthly/weekly are not annual.
  const recurring = activeCounterparties(accountId, "AND pattern_type IN ('subscription', 'recurring')");
  const rows = history.filter((r) => !recurring.has(r.counterparty));

  for (const [counterparty, occurrences] of byCounterparty(rows)) {
    if (occurrences.length < 2) continue;

    const sorted = occurrences.sort((a, b) => a.date.localeCompare(b.date));
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const a = new Date(sorted[i - 1].date).getTime();
      const b = new Date(sorted[i].date).getTime();
      intervals.push((b - a) / 86400_000);
    }

    const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    if (avgInterval < 330 || avgInterval > 400) continue;

    const amounts = sorted.map((o) => Math.abs(o.amount));
    const avgAmount = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    if (avgAmount === 0) continue;
    const consistent = amounts.every((a) => Math.abs(a - avgAmount) / avgAmount <= 0.25);
    if (!consistent) continue;

    const typicalMonth = new Date(sorted[sorted.length - 1].date).getMonth() + 1;

    const existing = db.prepare(
      `SELECT p.id, ${VOUCHED_CREATED} AS vouched FROM recurring_patterns p WHERE p.account_id = ? AND p.counterparty_name = ?`
    ).get(accountId, counterparty) as { id: string; vouched: number } | undefined;

    // A created pattern still vouched for is never rewritten by detection.
    if (existing?.vouched) continue;
    if (existing) {
      db.prepare(`
        UPDATE recurring_patterns SET updated_at = ?, pattern_type = 'annual', origin = 'detected',
          interval_days = ?, typical_amount = ?, last_seen = ?,
          occurrence_count = ?, is_active = 1, typical_month = ?
        WHERE id = ?
      `).run(now, Math.round(avgInterval), avgAmount,
             sorted[sorted.length - 1].date, sorted.length, typicalMonth, existing.id);
    } else {
      db.prepare(`
        INSERT INTO recurring_patterns
          (id, created_at, updated_at, account_id, counterparty_name, pattern_type,
           interval_days, typical_amount, currency, first_seen, last_seen,
           occurrence_count, is_active, typical_month)
        VALUES (?, ?, ?, ?, ?, 'annual', ?, ?, 'EUR', ?, ?, ?, 1, ?)
      `).run(
        crypto.randomUUID(), now, now, accountId, counterparty,
        Math.round(avgInterval), avgAmount,
        sorted[0].date, sorted[sorted.length - 1].date, sorted.length, typicalMonth
      );
    }
  }
}

function detectConfirmationCandidates(accountId: string, history: Occurrence[]): void {
  const now = new Date().toISOString();
  const patterned = activeCounterparties(accountId);
  const rows = history.filter(
    (r) => Math.abs(r.amount) >= ANNUAL_CONFIRMATION_THRESHOLD_EUR && !patterned.has(r.counterparty)
  );

  for (const [counterparty, occurrences] of byCounterparty(rows)) {
    if (occurrences.length !== 1) continue; // only true single-occurrence candidates

    const occ = occurrences[0];
    const typicalMonth = new Date(occ.date).getMonth() + 1;
    const typicalAmount = Math.abs(occ.amount);

    // Pending ones are asked already; a rejected one is the user's answer, not asked again.
    const alreadyAsked = db.prepare(
      "SELECT 1 FROM pattern_confirmations WHERE counterparty_name = ? AND typical_month = ? AND status IN ('pending', 'rejected')"
    ).get(counterparty, typicalMonth);
    if (alreadyAsked) continue;

    db.prepare(`
      INSERT INTO pattern_confirmations
        (id, created_at, account_id, counterparty_name, typical_month, typical_amount, currency, status)
      VALUES (?, ?, ?, ?, ?, ?, 'EUR', 'pending')
    `).run(crypto.randomUUID(), now, accountId, counterparty, typicalMonth, typicalAmount);
  }
}
