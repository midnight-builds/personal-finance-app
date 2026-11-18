import { z } from 'zod';

// Contract for decisions on recurring patterns (GLOSSARY.md, "Pattern decision"):
// POST /patterns/:id/decision and the decision log. Shared by the API and the
// MCP tools, so both validate answers the same way.

/**
 * What the user or an agent says a monthly or weekly pattern is; `reset` takes a
 * decision back (the pattern is unconfirmed again). Any actor may make any of them.
 */
export const PATTERN_DECISIONS = ['recurring', 'subscription', 'not_recurring', 'reset'] as const;
export type PatternDecision = (typeof PATTERN_DECISIONS)[number];

/** A pattern's decision state: none yet, or the latest decision. */
export const PATTERN_STATES = ['unconfirmed', 'confirmed_recurring', 'confirmed_subscription', 'rejected'] as const;
export type PatternState = (typeof PATTERN_STATES)[number];

export const PATTERN_DECISION_LIST_MAX_LIMIT = 100;

export const patternDecisionFields = {
  decision: z
    .enum(PATTERN_DECISIONS)
    .describe(
      'recurring = a recurring cost that is not a subscription (a bill, savings, a payment to a person); ' +
        'subscription = a subscription; not_recurring = not a recurring cost (it leaves the forecast and totals); ' +
        'reset = take the decision back: unconfirmed again, counted by its confidence'
    ),
};
export const patternDecisionRequestSchema = z.object(patternDecisionFields);

export const patternDecisionListFields = {
  limit: z.number().int().min(1).max(PATTERN_DECISION_LIST_MAX_LIMIT).default(50),
  offset: z.number().int().min(0).default(0),
};

// ── Created patterns ────────────────────────────────────────────────
// POST /patterns: an actor adds a monthly or weekly pattern that detection never
// proposed (GLOSSARY.md, "Created pattern"). It is confirmed at once, by that actor.

/** Where a stored pattern comes from: found by detection, or created by an actor. */
export const PATTERN_ORIGINS = ['detected', 'created'] as const;
export type PatternOrigin = (typeof PATTERN_ORIGINS)[number];

export const CREATED_PATTERN_KINDS = ['recurring', 'subscription'] as const;
/** Annual patterns follow their own confirmation (pattern_confirmations) and cannot be created. */
export const CREATED_PATTERN_INTERVALS = ['weekly', 'monthly'] as const;
export type CreatedPatternInterval = (typeof CREATED_PATTERN_INTERVALS)[number];
export const PATTERN_CREATE_MAX_EVIDENCE = 24;

export const patternCreateFields = {
  accountId: z.string().trim().min(1).max(100).describe('Account id (list_accounts, or accountId of a transaction)'),
  counterparty: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('Counterparty exactly as on the evidence transactions (search_transactions shows it)'),
  kind: z
    .enum(CREATED_PATTERN_KINDS)
    .describe(
      'subscription = a subscription; recurring = a recurring cost that is not a subscription (a bill, savings, a payment to a person)'
    ),
  interval: z
    .enum(CREATED_PATTERN_INTERVALS)
    .describe('How often it is charged: weekly or monthly. Annual payments cannot be created here'),
  expectedAmount: z
    .number()
    .positive()
    .max(1_000_000)
    .describe('Expected amount of one charge in EUR, positive (a charge of -12.99 is 12.99)'),
  evidenceTransactionIds: z
    .array(z.string().trim().min(1).max(100))
    .min(1)
    .max(PATTERN_CREATE_MAX_EVIDENCE)
    .describe(
      'Ids of existing charges of this pattern (search_transactions): booked expenses of this account and ' +
        'counterparty, not transfers, each within 20 % of expectedAmount, at least 5 days apart (weekly) or ' +
        '20 days apart (monthly). One is enough, e.g. a newly started contract'
    ),
};
export const patternCreateRequestSchema = z.object(patternCreateFields);
export type PatternCreateRequest = z.infer<typeof patternCreateRequestSchema>;
