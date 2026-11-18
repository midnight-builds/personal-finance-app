// Recurring patterns as the rest of the app sees them: what detection found
// (`recurring_patterns`, patterns.ts) combined with what the user or an agent
// decided about it (`pattern_decisions`). Detection never writes decisions, and
// everything that counts patterns (forecast, subscription total, briefing) reads
// them through here, so a decision cannot be lost or bypassed by re-detection.
import type { PatternDecision, PatternOrigin, PatternState } from '@finance-app/shared';
import { db } from './db.js';
import { DomainError } from './http/errors.js';
import { CONFIDENT, chargesPerMonth, patternChargesOf, type ConfidenceFactors, type Occurrence } from './patterns.js';

type PatternRow = {
  id: string;
  created_at: string;
  updated_at: string;
  account_id: string;
  counterparty_name: string | null;
  pattern_type: string;
  interval_days: number | null;
  typical_amount: number | null;
  currency: string;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  is_active: number;
  typical_month: number | null;
  user_confirmed: number | null;
  confidence: number | null;
  confidence_factors: string | null;
  amount_fixed: number | null;
  payment_method: string | null;
  savings: number | null;
  decision: PatternDecision | null;
  decided_by: string | null;
  decided_at: string | null;
  origin: PatternOrigin;
  created_by: string | null;
  evidence_transaction_ids: string | null;
  lapsed_since: string | null;
};

/** A stored pattern with its decision applied. Snake case, like the rows `/recurring` always returned. */
export type PatternView = Omit<
  PatternRow,
  'confidence_factors' | 'amount_fixed' | 'decision' | 'user_confirmed' | 'evidence_transaction_ids' | 'savings'
> & {
  /** Created patterns: the charges the actor cited when creating it; null for detected ones. */
  evidence_transaction_ids: string[] | null;
  /** What detection found; `pattern_type` is this unless a decision says otherwise. */
  detected_type: string;
  confidence_factors: ConfidenceFactors | null;
  amount_fixed: boolean | null;
  /** Saved or invested rather than spent (GLOSSARY.md, "Savings pattern"): never a subscription by detection. */
  savings: boolean;
  state: PatternState;
  /** 1 = confirmed by the user or an agent (or an annual confirmation), 0 = rejected, null = not decided. */
  user_confirmed: 1 | 0 | null;
  /**
   * Counts as a fixed cost (and, as a subscription, in the subscription total): confirmed,
   * or unconfirmed with confidence ≥ CONFIDENT and not savings. Null for annual patterns, which follow
   * their own confirmation (pattern_confirmations).
   */
  established: boolean | null;
  /**
   * Two periods passed without a charge, counted on the account's latest booking
   * (GLOSSARY.md, "Lapsed pattern"): it counts nowhere until a charge comes again.
   * `lapsed_since` is the day it lapsed. Annual patterns lapse with yearly periods.
   */
  lapsed: boolean;
  /**
   * One month of a monthly/weekly pattern at its typical amount: a weekly one 52/12
   * charges. What the subscription total adds up; null for annual patterns.
   */
  monthly_amount: number | null;
};

const MONTHLY_TYPES = new Set(['subscription', 'recurring']);

const PATTERN_SELECT = `
  SELECT p.*, d.decision, d.actor AS decided_by, d.created_at AS decided_at
  FROM recurring_patterns p
  LEFT JOIN pattern_decisions d ON d.id = (
    SELECT MAX(x.id) FROM pattern_decisions x
    WHERE x.account_id = p.account_id AND x.counterparty_name = p.counterparty_name
      AND x.annual = (p.pattern_type = 'annual'))`;

const STATE_OF: Record<Exclude<PatternDecision, 'reset'>, PatternState> = {
  recurring: 'confirmed_recurring',
  subscription: 'confirmed_subscription',
  not_recurring: 'rejected',
};

function view(row: PatternRow): PatternView {
  const { confidence_factors, amount_fixed, user_confirmed, evidence_transaction_ids, savings, ...rest } = row;
  const monthly = MONTHLY_TYPES.has(row.pattern_type);
  // A decision is about the pattern as it was when decided, annual or monthly/weekly:
  // `PATTERN_SELECT` joins the latest of the row's kind. Should a row turn from one to
  // the other, a decision of its new kind applies, if any; the old one applies again if
  // it turns back. `reset` takes the previous decision back.
  const decision = row.decision !== 'reset' ? row.decision : null;
  const state: PatternState = decision ? STATE_OF[decision] : 'unconfirmed';
  // A decision on a monthly/weekly pattern names its type; annual patterns keep theirs.
  const type = monthly && (decision === 'recurring' || decision === 'subscription') ? decision : row.pattern_type;
  const { decision: _decision, ...fields } = rest;
  return {
    ...fields,
    lapsed: row.lapsed_since !== null,
    lapsed_since: row.lapsed_since,
    monthly_amount: monthly ? Math.round((row.typical_amount ?? 0) * chargesPerMonth(row.interval_days) * 100) / 100 : null,
    decided_by: decision ? row.decided_by : null,
    decided_at: decision ? row.decided_at : null,
    pattern_type: type,
    detected_type: row.pattern_type,
    confidence_factors: confidence_factors ? (JSON.parse(confidence_factors) as ConfidenceFactors) : null,
    evidence_transaction_ids: evidence_transaction_ids ? (JSON.parse(evidence_transaction_ids) as string[]) : null,
    amount_fixed: amount_fixed === null ? null : amount_fixed === 1,
    savings: savings === 1,
    state,
    user_confirmed: state === 'rejected' ? 0 : state !== 'unconfirmed' || user_confirmed === 1 ? 1 : null,
    established: !monthly
      ? null
      : state === 'rejected'
        ? false
        : state !== 'unconfirmed' || ((row.confidence ?? 0) >= CONFIDENT && savings !== 1),
  };
}

/** The stored pattern `id` with its decision applied, if there is one. */
export function patternById(id: string): PatternView | undefined {
  const row = db.prepare(`${PATTERN_SELECT} WHERE p.id = ?`).get(id) as PatternRow | undefined;
  return row && view(row);
}

/**
 * Whether a pattern counts at all. A rejected one does not: the user or an agent said
 * it is not recurring. Nor does a created pattern whose decision was reset (withdrawn)
 * while its own charges do not make it established: detection never proposed it and
 * nobody vouches for it any more, so it is neither counted nor asked about.
 */
function counts(p: PatternView): boolean {
  if (p.state === 'rejected') return false;
  return !(p.origin === 'created' && p.state === 'unconfirmed' && !p.established);
}

/**
 * Active patterns with their decisions applied, those that do not count (`counts`)
 * left out. Ordered by typical amount, largest first.
 */
export function activePatterns(): PatternView[] {
  const rows = db
    .prepare(`${PATTERN_SELECT} WHERE p.is_active = 1 ORDER BY p.typical_amount DESC, p.id`)
    .all() as PatternRow[];
  return rows.map(view).filter(counts);
}

/** Monthly and weekly patterns (subscriptions and recurring), active and not rejected. */
export function monthlyPatterns(): PatternView[] {
  return activePatterns().filter((p) => MONTHLY_TYPES.has(p.pattern_type));
}

/** Annual patterns (detected, confirmed or created yearly), active and not rejected or withdrawn. */
export function annualPatterns(): PatternView[] {
  return activePatterns().filter((p) => p.pattern_type === 'annual');
}

/** Subscriptions counted in the monthly subscription total: confirmed, or confident enough, and not lapsed. */
export function establishedSubscriptions(): PatternView[] {
  return monthlyPatterns().filter((p) => p.pattern_type === 'subscription' && p.established && !p.lapsed);
}

// ── "Onko tämä toistuva?" questions ─────────────────────────────────

/**
 * Why an undecided pattern is asked about. Only an uncertain one is: confidence below
 * CONFIDENT (`low_confidence`), or savings (`savings`), which only a decision
 * establishes. An established pattern needs no confirmation, though the user or an agent
 * may still decide it. A fixed amount is added as a hint of what it may be: paid to an
 * IBAN every time, savings, rent or a person; otherwise savings or a subscription.
 */
export type QuestionReason = 'low_confidence' | 'savings' | 'fixed_amount_account_payment' | 'fixed_amount_card';

function questionReasons(p: PatternView): QuestionReason[] {
  // A lapsed pattern is not asked about: its charges stopped.
  if (p.state !== 'unconfirmed' || !MONTHLY_TYPES.has(p.pattern_type) || p.established || p.lapsed) return [];
  const reasons: QuestionReason[] = [];
  if ((p.confidence ?? 0) < CONFIDENT) reasons.push('low_confidence');
  if (p.savings) reasons.push('savings');
  if (p.amount_fixed) {
    reasons.push(p.payment_method === 'account_payment' ? 'fixed_amount_account_payment' : 'fixed_amount_card');
  }
  return reasons;
}

export type RecurringQuestion = {
  patternId: string;
  accountId: string;
  counterparty: string;
  /** subscription or recurring: what detection found, the likely answer. */
  suggestedAnswer: 'subscription' | 'recurring';
  reasons: QuestionReason[];
  confidence: number | null;
  confidenceFactors: ConfidenceFactors | null;
  typicalAmount: number | null;
  intervalDays: number | null;
  currency: string;
  evidence: {
    chargeCount: number;
    firstDate: string | null;
    lastDate: string | null;
    /** Signed, as in search_transactions: expenses are negative. */
    smallestAmount: number | null;
    largestAmount: number | null;
    amountFixed: boolean | null;
    paymentMethod: string | null;
    transactions: Array<{ id: string; date: string; amount: number }>;
  };
};

type OpenQuestion = { pattern: PatternView; reasons: QuestionReason[] };

function openQuestions(): OpenQuestion[] {
  return monthlyPatterns().flatMap((pattern) => {
    const reasons = questionReasons(pattern);
    return reasons.length && pattern.counterparty_name !== null ? [{ pattern, reasons }] : [];
  });
}

/** Ids of the patterns with an open question, without gathering evidence. */
export function openQuestionIds(): Set<string> {
  return new Set(openQuestions().map((q) => q.pattern.id));
}

function question({ pattern: p, reasons }: OpenQuestion, charges: Occurrence[]): RecurringQuestion {
  const amounts = charges.map((c) => c.amount);
  return {
    patternId: p.id,
    accountId: p.account_id,
    counterparty: p.counterparty_name!,
    suggestedAnswer: p.detected_type === 'subscription' ? 'subscription' : 'recurring',
    reasons,
    confidence: p.confidence,
    confidenceFactors: p.confidence_factors,
    typicalAmount: p.typical_amount,
    intervalDays: p.interval_days,
    currency: p.currency,
    evidence: {
      chargeCount: charges.length,
      firstDate: charges[0]?.date.slice(0, 10) ?? null,
      lastDate: charges.at(-1)?.date.slice(0, 10) ?? null,
      // Expenses are negative: the largest charge is the smallest number.
      smallestAmount: amounts.length ? Math.max(...amounts) : null,
      largestAmount: amounts.length ? Math.min(...amounts) : null,
      amountFixed: p.amount_fixed,
      paymentMethod: p.payment_method,
      transactions: charges.map((c) => ({ id: c.id, date: c.date.slice(0, 10), amount: c.amount })),
    },
  };
}

/** Open "is this recurring?" questions with their evidence, largest typical amount first. */
export function recurringQuestions(): RecurringQuestion[] {
  const byAccount = new Map<string, Map<string, Occurrence[]>>();
  return openQuestions().map((q) => {
    const account = q.pattern.account_id;
    if (!byAccount.has(account)) byAccount.set(account, patternChargesOf(account));
    return question(q, byAccount.get(account)!.get(q.pattern.counterparty_name!) ?? []);
  });
}

// ── Decisions ───────────────────────────────────────────────────────

export type DecisionResult = { pattern: PatternView; recorded: boolean };

/**
 * Records `actor`'s decision on a pattern, monthly, weekly or annual; it is marked
 * with the pattern's kind and applies while the pattern is of that kind (`view`). A
 * decision is appended to the history and never changed; re-stating the latest one
 * appends nothing. It writes nothing else: transactions, categories and the detected
 * pattern stay as they are. Every actor is equally trusted
 * (docs/adr/0001-actor-without-authentication.md): any of them may replace any
 * decision, and the history keeps who decided what.
 */
export function decidePattern(patternId: string, decision: PatternDecision, actor: string): DecisionResult {
  const row = db.prepare(`${PATTERN_SELECT} WHERE p.id = ?`).get(patternId) as PatternRow | undefined;
  if (!row) throw DomainError.notFound();
  // Decisions are keyed by counterparty; detection never stores a pattern without one.
  if (row.counterparty_name === null) throw new DomainError('no_counterparty', 409);
  if ((row.decision ?? 'reset') === decision) return { pattern: view(row), recorded: false };
  insertDecision(row.account_id, row.counterparty_name, row.id, row.pattern_type === 'annual', decision, actor);
  return { pattern: patternById(patternId)!, recorded: true };
}

/** Appends a decision on the pattern `patternId`, of its kind: annual or monthly/weekly. */
export function insertDecision(
  accountId: string,
  counterparty: string,
  patternId: string,
  annual: boolean,
  decision: PatternDecision,
  actor: string,
  at: string = new Date().toISOString()
): void {
  db.prepare(
    `INSERT INTO pattern_decisions (created_at, account_id, counterparty_name, pattern_id, decision, actor, annual)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(at, accountId, counterparty, patternId, decision, actor, annual ? 1 : 0);
}

export type PatternDecisionEntry = {
  id: number;
  createdAt: string;
  patternId: string;
  accountId: string;
  counterparty: string;
  decision: PatternDecision;
  actor: string;
  /** Made on an annual pattern; it applies only while the pattern is annual. */
  annual: boolean;
  /** Whether a newer decision on the same pattern (of the same kind) replaced this one. */
  superseded: boolean;
};

/** Every decision ever made, newest first, from every actor. */
export function listPatternDecisions(limit: number, offset: number) {
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM pattern_decisions').get() as { total: number };
  const rows = db
    .prepare(
      `SELECT d.id, d.created_at, d.pattern_id, d.account_id, d.counterparty_name, d.decision, d.actor, d.annual,
              EXISTS (SELECT 1 FROM pattern_decisions n
                      WHERE n.account_id = d.account_id AND n.counterparty_name = d.counterparty_name
                        AND n.annual = d.annual AND n.id > d.id) AS superseded
       FROM pattern_decisions d ORDER BY d.id DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Array<{
    id: number;
    created_at: string;
    pattern_id: string;
    account_id: string;
    counterparty_name: string;
    decision: PatternDecision;
    actor: string;
    annual: number;
    superseded: number;
  }>;
  const items: PatternDecisionEntry[] = rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    patternId: r.pattern_id,
    accountId: r.account_id,
    counterparty: r.counterparty_name,
    decision: r.decision,
    actor: r.actor,
    annual: r.annual === 1,
    superseded: r.superseded === 1,
  }));
  return { total, limit, offset, items };
}
