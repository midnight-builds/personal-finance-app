import { z } from 'zod';
import { publishableText } from './schemas.js';

// Contract for feature proposals submitted by external agents and reviewed by
// the user. Proposals may later be copied into a public issue tracker, hence
// `publishableText` on every free-text field.

// Lifecycle: new → accepted → done, new → done (clear bug fixed directly),
// new/accepted → rejected. `done` and `rejected` are final.
export const FEATURE_PROPOSAL_STATUSES = ['new', 'accepted', 'rejected', 'done'] as const;
export type FeatureProposalStatus = (typeof FEATURE_PROPOSAL_STATUSES)[number];
export type FeatureProposalDecision = Exclude<FeatureProposalStatus, 'new'>;

/** Statuses from which each decision may be made. */
export const FEATURE_PROPOSAL_TRANSITIONS: Record<FeatureProposalDecision, readonly FeatureProposalStatus[]> = {
  accepted: ['new'],
  rejected: ['new', 'accepted'],
  done: ['new', 'accepted'],
};

/** Statuses that still count as open: a matching title is a duplicate. */
export const OPEN_FEATURE_PROPOSAL_STATUSES = ['new', 'accepted'] as const satisfies readonly FeatureProposalStatus[];

/** URL action → resulting status: `POST /feature-proposals/:id/<action>`. */
export const FEATURE_PROPOSAL_ACTIONS = {
  accept: 'accepted',
  reject: 'rejected',
  done: 'done',
} as const satisfies Record<string, FeatureProposalDecision>;
export type FeatureProposalAction = keyof typeof FEATURE_PROPOSAL_ACTIONS;

export const FEATURE_PROPOSAL_KINDS = ['feature', 'bug'] as const;
export type FeatureProposalKind = (typeof FEATURE_PROPOSAL_KINDS)[number];

export const DECISION_NOTE_MAX_LENGTH = 1000;
export const RESOLUTION_MAX_LENGTH = 300;

/** Who submitted a proposal, e.g. "hermes". */
export const proposalSourceSchema = z.string().trim().min(1).max(40);

/** Fields an agent fills in. Shared by the API validator and the MCP tool schema. */
export const featureProposalFields = {
  kind: z
    .enum(FEATURE_PROPOSAL_KINDS)
    .default('feature')
    .describe('"bug" for something that works incorrectly today, "feature" for new behaviour'),
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

/**
 * User's edit of an open proposal: any subset of the agent-filled fields, at
 * least one. `kind` is redeclared without its default so omitting it keeps the
 * stored value.
 */
export const featureProposalUpdateSchema = z
  .object({ ...featureProposalFields, kind: z.enum(FEATURE_PROPOSAL_KINDS) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });
export type FeatureProposalUpdate = z.input<typeof featureProposalUpdateSchema>;

export const featureProposalDecisionSchema = z.object({
  note: z.string().trim().max(DECISION_NOTE_MAX_LENGTH).optional(),
  /** Where the change lives: commit SHA, PR URL or release. Required for `done`. */
  resolution: z.string().trim().min(1).max(RESOLUTION_MAX_LENGTH).optional(),
});

export const featureProposalListQuerySchema = z.object({
  status: z.enum(FEATURE_PROPOSAL_STATUSES).optional(),
});

/** One status change, oldest first in `FeatureProposal.history`. */
export type FeatureProposalEvent = {
  at: string;
  status: FeatureProposalDecision;
  note: string | null;
  resolution: string | null;
};

export type FeatureProposal = z.output<typeof featureProposalInputSchema> & {
  id: string;
  createdAt: string;
  status: FeatureProposalStatus;
  /** Time the user last edited the text, null if never. */
  updatedAt: string | null;
  /** Time of the latest status change. */
  resolvedAt: string | null;
  /** Note of the latest status change. */
  decisionNote: string | null;
  /** Set when `status` is `done`. */
  resolution: string | null;
  history: FeatureProposalEvent[];
};

export type CreateFeatureProposalResponse = { duplicate: boolean; proposal: FeatureProposal };
