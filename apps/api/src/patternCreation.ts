// Recurring patterns an actor creates that detection never proposed (GLOSSARY.md,
// "Created pattern"), e.g. a contract that started last month: one charge is enough.
// The pattern is confirmed at once with a pattern decision by the same actor, who is
// as trusted as the user (docs/adr/0001-actor-without-authentication.md). Creating
// writes the pattern row and that decision, nothing else: transactions, categories
// and balances stay as they are.
import crypto from 'crypto';
import { redactSensitiveIds, type CreatedPatternInterval, type PatternCreateRequest } from '@finance-app/shared';
import { db } from './db.js';
import { DomainError } from './http/errors.js';
import { ledgerEntries } from './ledger.js';
import { CREATED_AMOUNT_TOLERANCE, MIN_DAYS_APART, fitsExpectedAmount, isSavingsCharge, refreshLapse, scorePattern } from './patterns.js';
import { insertDecision, patternById, type PatternView } from './patternDecisions.js';
import { supersedeConfirmations } from './patternConfirmations.js';

const INTERVAL_DAYS: Record<CreatedPatternInterval, number> = { weekly: 7, monthly: 30, yearly: 365 };

const invalid = (code: string, details: unknown) => new DomainError(code, 400, details);

/**
 * Whether the stored counterparty is the one the actor named: as stored, or as an
 * agent sees it through MCP (account numbers inside the name redacted).
 */
const sameCounterparty = (stored: string | null, named: string) =>
  stored !== null && (stored.trim() === named || redactSensitiveIds(stored).trim() === named);

type Evidence = {
  id: string; bookedAt: string; amount: number; currency: string; counterparty: string; viaIban: boolean; savings: boolean;
};

/** The cited charges, checked one by one; throws a 400 naming the offending ids. Oldest first. */
function checkEvidence(input: PatternCreateRequest): Evidence[] {
  const ids = input.evidenceTransactionIds;
  const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (repeated.length) throw invalid('evidence_duplicate', { transactionIds: repeated });

  const stored = new Map(
    (
      db
        .prepare(
          `SELECT id, account_id, booking_date FROM normalized_transactions
           WHERE id IN (${ids.map(() => '?').join(', ')})`
        )
        .all(...ids) as Array<{ id: string; account_id: string; booking_date: string | null }>
    ).map((r) => [r.id, r])
  );
  const failing = (code: string, test: (id: string) => boolean) => {
    const bad = ids.filter(test);
    if (bad.length) throw invalid(code, { transactionIds: bad });
  };
  failing('evidence_not_found', (id) => !stored.has(id));
  failing('evidence_other_account', (id) => stored.get(id)!.account_id !== input.accountId);
  failing('evidence_not_booked', (id) => stored.get(id)!.booking_date === null);

  // As the Ledger sees them: booked, with transfers marked.
  const wanted = new Set(ids);
  const entries = ledgerEntries({ accounts: [input.accountId], includeTransfers: true }).filter((e) => wanted.has(e.id));
  const byId = new Map(entries.map((e) => [e.id, e]));
  // A voided reservation has no booking date either; anything else missing is not countable.
  failing('evidence_not_booked', (id) => !byId.has(id));
  failing('evidence_transfer', (id) => byId.get(id)!.isTransfer);
  failing('evidence_not_charge', (id) => byId.get(id)!.amount >= 0);
  failing('evidence_other_counterparty', (id) => !sameCounterparty(byId.get(id)!.counterparty, input.counterparty));
  // Two stored names may look the same once redacted: the charges must share one.
  const first = byId.get(ids[0])!.counterparty;
  failing('evidence_other_counterparty', (id) => byId.get(id)!.counterparty !== first);
  const currencies = new Set(entries.map((e) => e.currency));
  if (currencies.size > 1) throw invalid('evidence_currency_mismatch', { currencies: [...currencies] });

  const mismatched = ids.filter((id) => !fitsExpectedAmount(byId.get(id)!.amount, input.expectedAmount, input.interval));
  if (mismatched.length) {
    throw invalid('evidence_amount_mismatch', {
      transactionIds: mismatched,
      expectedAmount: input.expectedAmount,
      tolerance: CREATED_AMOUNT_TOLERANCE[input.interval],
    });
  }

  // `entries` is in booking order.
  const minDays = MIN_DAYS_APART[input.interval];
  for (let i = 1; i < entries.length; i++) {
    const days = (Date.parse(entries[i].date) - Date.parse(entries[i - 1].date)) / 86400_000;
    if (days < minDays) {
      throw invalid('evidence_interval_mismatch', {
        transactionIds: [entries[i - 1].id, entries[i].id],
        minDaysApart: minDays,
      });
    }
  }
  return entries.map((e) => ({
    id: e.id,
    bookedAt: e.bookedAt,
    amount: e.amount,
    currency: e.currency,
    counterparty: e.counterparty!,
    viaIban: e.counterpartyIban !== null,
    savings: isSavingsCharge(e.counterparty, e.description),
  }));
}


export type CreateResult = {
  pattern: PatternView;
  /** A new pattern, or an account's inactive one taken over. */
  created: boolean;
  /** An active created pattern re-stated with other values (e.g. a new price). */
  updated: boolean;
};

const CONFIRMED_AS = { recurring: 'confirmed_recurring', subscription: 'confirmed_subscription' } as const;

/**
 * Creates `actor`'s weekly, monthly or yearly (annual) pattern from the charges it cites
 * and confirms it with a pattern decision of `input.kind`, in one transaction; pending
 * annual confirmations of the account and counterparty are superseded. There is one
 * pattern per account and counterparty:
 *
 * - none yet: a new row with origin `created`;
 * - an inactive one (its charges stopped, or detected on too little evidence): that row
 *   is taken over, keeping its id;
 * - an active created one: re-stated. With the same kind, interval and amount while it
 *   is confirmed as that kind, nothing is written (`created` and `updated` false);
 *   otherwise its values and evidence are replaced (a new price, say) and, unless it
 *   is already confirmed as `kind`, the decision is appended;
 * - an active detected one, monthly, weekly or annual (also one confirmed through an
 *   annual confirmation): `409 pattern_exists` with its id, to be decided instead
 *   (`POST /patterns/:id/decision`).
 */
export function createPattern(input: PatternCreateRequest, actor: string): CreateResult {
  if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(input.accountId)) {
    throw new DomainError('account_not_found', 404);
  }
  const evidence = checkEvidence(input);
  // The name as stored, also when the actor named it redacted.
  const counterparty = evidence[0].counterparty;
  const intervalDays = INTERVAL_DAYS[input.interval];
  // A yearly pattern is an annual one, forecast in the month of its latest charge
  // (detection sets typical_month the same way); its kind lives in its decision.
  const yearly = input.interval === 'yearly';
  const patternType = yearly ? 'annual' : input.kind;

  const existing = db
    .prepare('SELECT id FROM recurring_patterns WHERE account_id = ? AND counterparty_name = ?')
    .get(input.accountId, counterparty) as { id: string } | undefined;
  const current = existing && patternById(existing.id)!;
  const restated = Boolean(current?.is_active);
  if (current && restated) {
    if (current.origin !== 'created') {
      throw new DomainError('pattern_exists', 409, { patternId: current.id, origin: current.origin, state: current.state });
    }
    const unchanged =
      current.state === CONFIRMED_AS[input.kind] &&
      current.detected_type === patternType &&
      current.interval_days === intervalDays &&
      current.typical_amount === input.expectedAmount;
    if (unchanged) return { pattern: current, created: false, updated: false };
  }

  const now = new Date().toISOString();
  const score = scorePattern(evidence.map((e) => ({ amount: e.amount, date: e.bookedAt, viaIban: e.viaIban, savings: e.savings })));
  const values = {
    updated_at: now,
    pattern_type: patternType,
    interval_days: intervalDays,
    typical_amount: input.expectedAmount,
    currency: evidence[0].currency,
    first_seen: evidence[0].bookedAt,
    last_seen: evidence.at(-1)!.bookedAt,
    occurrence_count: evidence.length,
    is_active: 1,
    typical_month: yearly ? Number(evidence.at(-1)!.bookedAt.slice(5, 7)) : null,
    user_confirmed: null,
    confidence: score.confidence,
    confidence_factors: JSON.stringify(score.factors),
    amount_fixed: score.amountFixed ? 1 : 0,
    payment_method: score.paymentMethod,
    savings: score.savings ? 1 : 0,
    origin: 'created',
    created_by: actor,
    evidence_transaction_ids: JSON.stringify(evidence.map((e) => e.id)),
  };
  const columns = Object.keys(values);
  const id = existing?.id ?? crypto.randomUUID();
  // A new or taken-over pattern always gets its decision, also when an earlier one on
  // the counterparty said the same: the history then shows who created it. A
  // re-stated one only when its decision changes (re-stating appends nothing), or when
  // it turns annual or back: decisions are of their kind (patternDecisions.ts).
  const decide =
    !restated || current!.state !== CONFIRMED_AS[input.kind] || (current!.detected_type === 'annual') !== yearly;

  db.exec('BEGIN');
  try {
    if (existing) {
      db.prepare(`UPDATE recurring_patterns SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
        ...Object.values(values),
        id
      );
    } else {
      db.prepare(
        `INSERT INTO recurring_patterns (id, created_at, account_id, counterparty_name, ${columns.join(', ')})
         VALUES (?, ?, ?, ?, ${columns.map(() => '?').join(', ')})`
      ).run(id, now, input.accountId, counterparty, ...Object.values(values));
    }
    if (decide) insertDecision(input.accountId, counterparty, id, yearly, input.kind, actor, now);
    // The counterparty has its pattern now: a pending annual question about it is answered.
    supersedeConfirmations(input.accountId, counterparty, now);
    // Cited charges may be old: the pattern may have lapsed already (GLOSSARY.md, "Lapsed pattern").
    refreshLapse(input.accountId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { pattern: patternById(id)!, created: !restated, updated: restated };
}
