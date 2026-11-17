import { z } from 'zod';

// Contract for decisions on recurring patterns (GLOSSARY.md, "Pattern decision"):
// POST /patterns/:id/decision and the decision log. Shared by the API and the
// MCP tools, so both validate answers the same way.

/** What the user (or an agent) says a monthly or weekly pattern is. */
export const PATTERN_DECISIONS = ['recurring', 'subscription', 'not_recurring'] as const;
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
        'subscription = a subscription; not_recurring = not a recurring cost (it leaves the forecast and totals)'
    ),
};
export const patternDecisionRequestSchema = z.object(patternDecisionFields);

export const patternDecisionListFields = {
  limit: z.number().int().min(1).max(PATTERN_DECISION_LIST_MAX_LIMIT).default(50),
  offset: z.number().int().min(0).default(0),
};
