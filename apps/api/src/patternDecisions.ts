// Recurring patterns as the rest of the app sees them: what detection found
// (`recurring_patterns`, patterns.ts) combined with what the user or an agent
// decided about it (`pattern_decisions`). Detection never writes decisions, and
// everything that counts patterns (forecast, subscription total, briefing) reads
// them through here, so a decision cannot be lost or bypassed by re-detection.
import type { PatternDecision, PatternState } from '@finance-app/shared';
import { db } from './db.js';
import { DomainError } from './http/errors.js';
import { CONFIDENT, patternChargesOf, type ConfidenceFactors, type Occurrence } from './patterns.js';

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
  decision: PatternDecision | null;
  decided_by: string | null;
  decided_at: string | null;
};

/** A stored pattern with its decision applied. Snake case, like the rows `/recurring` always returned. */
export type PatternView = Omit<PatternRow, 'confidence_factors' | 'amount_fixed' | 'decision' | 'user_confirmed'> & {
  /** What detection found; `pattern_type` is this unless a decision says otherwise. */
  detected_type: string;
  confidence_factors: ConfidenceFactors | null;
  amount_fixed: boolean | null;
  state: PatternState;
  /** 1 = confirmed by the user or an agent (or an annual confirmation), 0 = rejected, null = not decided. */
  user_confirmed: 1 | 0 | null;
  /**
   * Counts as a fixed cost (and, as a subscription, in the subscription total): confirmed,
   * or unconfirmed with confidence ≥ CONFIDENT. Null for annual patterns, which follow
   * their own confirmation (pattern_confirmations).
   */
  established: boolean | null;
};

const MONTHLY_TYPES = new Set(['subscription', 'recurring']);

const PATTERN_SELECT = `
  SELECT p.*, d.decision, d.actor AS decided_by, d.created_at AS decided_at
  FROM recurring_patterns p
  LEFT JOIN pattern_decisions d ON d.id = (
    SELECT MAX(x.id) FROM pattern_decisions x
    WHERE x.account_id = p.account_id AND x.counterparty_name = p.counterparty_name)`;

const STATE_OF: Record<PatternDecision, PatternState> = {
  recurring: 'confirmed_recurring',
  subscription: 'confirmed_subscription',
  not_recurring: 'rejected',
};

function view(row: PatternRow): PatternView {
  const { confidence_factors, amount_fixed, user_confirmed, ...rest } = row;
  const monthly = MONTHLY_TYPES.has(row.pattern_type);
  // Decisions are about monthly/weekly patterns. Should the row turn annual, its own
  // confirmation rules apply; the decision applies again if it turns monthly again.
  const decision = monthly ? row.decision : null;
  const state: PatternState = decision ? STATE_OF[decision] : 'unconfirmed';
  // A decision on a monthly/weekly pattern names its type; annual patterns keep theirs.
  const type = monthly && (decision === 'recurring' || decision === 'subscription') ? decision : row.pattern_type;
  const { decision: _decision, ...fields } = rest;
  return {
    ...fields,
    decided_by: decision ? row.decided_by : null,
    decided_at: decision ? row.decided_at : null,
    pattern_type: type,
    detected_type: row.pattern_type,
    confidence_factors: confidence_factors ? (JSON.parse(confidence_factors) as ConfidenceFactors) : null,
    amount_fixed: amount_fixed === null ? null : amount_fixed === 1,
    state,
    user_confirmed: state === 'rejected' ? 0 : state !== 'unconfirmed' || user_confirmed === 1 ? 1 : null,
    established: !monthly
      ? null
      : state === 'rejected'
        ? false
        : state !== 'unconfirmed' || (row.confidence ?? 0) >= CONFIDENT,
  };
}

/**
 * Active patterns with their decisions applied, rejected ones left out: the user said
 * they are not recurring. Ordered by typical amount, largest first.
 */
export function activePatterns(): PatternView[] {
  const rows = db
    .prepare(`${PATTERN_SELECT} WHERE p.is_active = 1 ORDER BY p.typical_amount DESC, p.id`)
    .all() as PatternRow[];
  return rows.map(view).filter((p) => p.state !== 'rejected');
}

/** Monthly and weekly patterns (subscriptions and recurring), active and not rejected. */
export function monthlyPatterns(): PatternView[] {
  return activePatterns().filter((p) => MONTHLY_TYPES.has(p.pattern_type));
}

/** Subscriptions counted in the monthly subscription total: confirmed, or confident enough. */
export function establishedSubscriptions(): PatternView[] {
  return monthlyPatterns().filter((p) => p.pattern_type === 'subscription' && p.established);
}

// ── "Onko tämä toistuva?" questions ─────────────────────────────────

/**
 * Why an undecided pattern is worth asking about. A low confidence means the rhythm is
 * not proven; a fixed amount means the kind is unknown even when the rhythm is: paid to
 * an IBAN it may be savings, rent or a person, by card it may be savings or a
 * subscription. A varying amount on a steady rhythm (a bill) is clear enough not to ask.
 */
export type QuestionReason = 'low_confidence' | 'fixed_amount_account_payment' | 'fixed_amount_card';

function questionReasons(p: PatternView): QuestionReason[] {
  if (p.state !== 'unconfirmed' || !MONTHLY_TYPES.has(p.pattern_type)) return [];
  const reasons: QuestionReason[] = [];
  if ((p.confidence ?? 0) < CONFIDENT) reasons.push('low_confidence');
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
  /** Counted in the forecast and totals already while unanswered (confidence ≥ CONFIDENT). */
  established: boolean;
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
    established: p.established === true,
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

/** The actor the web UI is recorded as (docs/adr/0001-actor-without-authentication.md). */
const USER_ACTOR = 'user';

/**
 * Records `actor`'s decision on a monthly or weekly pattern. A decision is appended to
 * the history and never changed; re-stating the latest one appends nothing. It writes
 * nothing else: transactions, categories and the detected pattern stay as they are.
 * The user's own decision is changed only by the user: an agent gets 409 user_decision.
 */
export function decidePattern(patternId: string, decision: PatternDecision, actor: string): DecisionResult {
  const row = db.prepare(`${PATTERN_SELECT} WHERE p.id = ?`).get(patternId) as PatternRow | undefined;
  if (!row) throw DomainError.notFound();
  if (!MONTHLY_TYPES.has(row.pattern_type) || row.counterparty_name === null) {
    // Annual patterns are confirmed through pattern_confirmations.
    throw new DomainError('not_monthly_pattern', 409);
  }
  if (row.decision === decision) return { pattern: view(row), recorded: false };
  if (row.decision !== null && row.decided_by === USER_ACTOR && actor !== USER_ACTOR) {
    throw new DomainError('user_decision', 409, { decision: row.decision, decidedAt: row.decided_at });
  }
  db.prepare(
    `INSERT INTO pattern_decisions (created_at, account_id, counterparty_name, pattern_id, decision, actor)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(new Date().toISOString(), row.account_id, row.counterparty_name, row.id, decision, actor);
  const updated = db.prepare(`${PATTERN_SELECT} WHERE p.id = ?`).get(patternId) as PatternRow;
  return { pattern: view(updated), recorded: true };
}

export type PatternDecisionEntry = {
  id: number;
  createdAt: string;
  patternId: string;
  accountId: string;
  counterparty: string;
  decision: PatternDecision;
  actor: string;
  /** Whether a newer decision on the same pattern replaced this one. */
  superseded: boolean;
};

/** Every decision ever made, newest first, from every actor. */
export function listPatternDecisions(limit: number, offset: number) {
  const { total } = db.prepare('SELECT COUNT(*) AS total FROM pattern_decisions').get() as { total: number };
  const rows = db
    .prepare(
      `SELECT d.id, d.created_at, d.pattern_id, d.account_id, d.counterparty_name, d.decision, d.actor,
              EXISTS (SELECT 1 FROM pattern_decisions n
                      WHERE n.account_id = d.account_id AND n.counterparty_name = d.counterparty_name
                        AND n.id > d.id) AS superseded
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
    superseded: r.superseded === 1,
  }));
  return { total, limit, offset, items };
}
