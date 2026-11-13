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
 * paid only to an IBAN is a person or an e-invoice biller and stays recurring.
 * `occurrences` is in date order.
 */
function isSubscription(occurrences: Array<{ amount: number; date: string; viaIban: boolean }>): boolean {
  if (occurrences.every((o) => o.viaIban)) return false;
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

type Occurrence = { counterparty: string; amount: number; date: string; viaIban: boolean };

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
      counterparty: e.counterparty!,
      amount: e.amount,
      date: e.bookedAt,
      viaIban: e.counterpartyIban !== null,
    }))
    .sort((a, b) => binary(a.counterparty, b.counterparty) || binary(a.date, b.date));
}

// SQLite's default (BINARY) text order, which the detection used to iterate in.
const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function byCounterparty(rows: Occurrence[]) {
  const groups = new Map<string, Array<{ amount: number; date: string; viaIban: boolean }>>();
  for (const r of rows) {
    if (!groups.has(r.counterparty)) groups.set(r.counterparty, []);
    groups.get(r.counterparty)!.push({ amount: r.amount, date: r.date, viaIban: r.viaIban });
  }
  return groups;
}

/** Detects recurring, annual and confirmation-worthy payments of one account as of `asOf` (default: today). */
export function detectPatterns(accountId: string, asOf: string = today()): void {
  const now = new Date().toISOString();
  // Transfers are included only to find the counterparties to leave out.
  const entries = ledgerEntries({ accounts: [accountId], to: asOf, includeTransfers: true });
  const rows = recurringCandidates(entries, daysBefore(asOf, 180));
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
    detected.add(counterparty);
    const firstSeen = sorted[0].date;
    const lastSeen = sorted[sorted.length - 1].date;

    // Upsert by account_id + counterparty_name
    const existing = db.prepare(
      'SELECT id FROM recurring_patterns WHERE account_id = ? AND counterparty_name = ?'
    ).get(accountId, counterparty) as { id: string } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE recurring_patterns
        SET updated_at = ?, pattern_type = ?, interval_days = ?, typical_amount = ?,
            last_seen = ?, occurrence_count = ?, is_active = 1
        WHERE id = ?
      `).run(now, patternType, Math.round(avgInterval), avgAmount, lastSeen, sorted.length, existing.id);
    } else {
      db.prepare(`
        INSERT INTO recurring_patterns
          (id, created_at, updated_at, account_id, counterparty_name, pattern_type,
           interval_days, typical_amount, currency, first_seen, last_seen, occurrence_count, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, 1)
      `).run(
        crypto.randomUUID(), now, now, accountId, counterparty, patternType,
        Math.round(avgInterval), avgAmount, firstSeen, lastSeen, sorted.length
      );
    }
  }

  reviseUndetected(accountId, groups, detected, now);

  const longHistory = recurringCandidates(entries, daysBefore(asOf, 1460));
  detectAnnualPatternsForAccount(accountId, longHistory);
  detectConfirmationCandidates(accountId, longHistory);
}

/**
 * Active monthly/weekly patterns of the account that this run did not detect. One first
 * found on fewer than MIN_OCCURRENCES charges was detected on too little evidence, and one
 * with fewer such charges left in the window has stopped: both are deactivated. Otherwise
 * it stays active, since a varying price or a skipped month says nothing against a known
 * bill, but a subscription that no longer qualifies as one becomes recurring.
 * User-confirmed patterns stay as is.
 */
function reviseUndetected(
  accountId: string,
  groups: Map<string, Array<{ amount: number; date: string; viaIban: boolean }>>,
  detected: Set<string>,
  now: string
): void {
  const rows = db.prepare(`
    SELECT id, counterparty_name, pattern_type, occurrence_count FROM recurring_patterns
    WHERE account_id = ? AND is_active = 1 AND pattern_type IN ('subscription', 'recurring')
      AND user_confirmed IS NOT 1
  `).all(accountId) as Array<{ id: string; counterparty_name: string | null; pattern_type: string; occurrence_count: number }>;
  const deactivate = db.prepare('UPDATE recurring_patterns SET is_active = 0, updated_at = ? WHERE id = ?');
  const demote = db.prepare("UPDATE recurring_patterns SET pattern_type = 'recurring', updated_at = ? WHERE id = ?");
  for (const r of rows) {
    if (r.counterparty_name !== null && detected.has(r.counterparty_name)) continue;
    const occurrences = r.counterparty_name === null ? [] : groups.get(r.counterparty_name) ?? [];
    if (r.occurrence_count < MIN_OCCURRENCES || occurrences.length < MIN_OCCURRENCES) deactivate.run(now, r.id);
    else if (r.pattern_type === 'subscription' && !isSubscription(occurrences)) demote.run(now, r.id);
  }
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
      'SELECT id FROM recurring_patterns WHERE account_id = ? AND counterparty_name = ?'
    ).get(accountId, counterparty) as { id: string } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE recurring_patterns SET updated_at = ?, pattern_type = 'annual',
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

    const alreadyPending = db.prepare(
      'SELECT 1 FROM pattern_confirmations WHERE counterparty_name = ? AND typical_month = ? AND status = ?'
    ).get(counterparty, typicalMonth, 'pending');
    if (alreadyPending) continue;

    db.prepare(`
      INSERT INTO pattern_confirmations
        (id, created_at, account_id, counterparty_name, typical_month, typical_amount, currency, status)
      VALUES (?, ?, ?, ?, ?, ?, 'EUR', 'pending')
    `).run(crypto.randomUUID(), now, accountId, counterparty, typicalMonth, typicalAmount);
  }
}
