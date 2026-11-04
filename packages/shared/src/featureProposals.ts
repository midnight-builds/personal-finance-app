import { z } from 'zod';
import { publishableText } from './schemas.js';

// Contract for feature proposals submitted by external agents and reviewed by
// the user. Proposals may later be copied into a public issue tracker, hence
// `publishableText` on every free-text field.

export const FEATURE_PROPOSAL_STATUSES = ['new', 'accepted', 'rejected'] as const;
export type FeatureProposalStatus = (typeof FEATURE_PROPOSAL_STATUSES)[number];
export type FeatureProposalDecision = Exclude<FeatureProposalStatus, 'new'>;

/** URL action → resulting status: `POST /feature-proposals/:id/<action>`. */
export const FEATURE_PROPOSAL_ACTIONS = {
  accept: 'accepted',
  reject: 'rejected',
} as const satisfies Record<string, FeatureProposalDecision>;
export type FeatureProposalAction = keyof typeof FEATURE_PROPOSAL_ACTIONS;

export const DECISION_NOTE_MAX_LENGTH = 1000;

/** Who submitted a proposal, e.g. "hermes". */
export const proposalSourceSchema = z.string().trim().min(1).max(40);

/** Fields an agent fills in. Shared by the API validator and the MCP tool schema. */
export const featureProposalFields = {
  title: publishableText(120).describe('Short imperative title'),
  problem: publishableText(2000).describe('What the user cannot do, or notices too late, today'),
  evidence: publishableText(2000).describe(
    'What in the data or usage led to this proposal. Anonymized: no names, account numbers or exact amounts'
  ),
  proposal: publishableText(4000).describe("What the feature would do, from the user's point of view"),
  acceptanceCriteria: z
    .array(publishableText(300))
    .min(1)
    .max(10)
    .describe('Testable statements that are true when the feature is done'),
};

export const featureProposalInputSchema = z.object({
  ...featureProposalFields,
  source: proposalSourceSchema.default('agent'),
});
export type FeatureProposalInput = z.input<typeof featureProposalInputSchema>;

export const featureProposalDecisionSchema = z.object({
  note: z.string().trim().max(DECISION_NOTE_MAX_LENGTH).optional(),
});

export const featureProposalListQuerySchema = z.object({
  status: z.enum(FEATURE_PROPOSAL_STATUSES).optional(),
});

export type FeatureProposal = z.output<typeof featureProposalInputSchema> & {
  id: string;
  createdAt: string;
  status: FeatureProposalStatus;
  resolvedAt: string | null;
  decisionNote: string | null;
};

export type CreateFeatureProposalResponse = { duplicate: boolean; proposal: FeatureProposal };
