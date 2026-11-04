import { featureProposalFields, featureProposalListQuerySchema } from '@finance-app/shared';
import { APPEND_ONLY, READ_ONLY, defineTool, type ToolDefinition } from './types.js';

// Feature proposals: agents suggest, the user decides. Nothing here builds anything.

export const proposalTools: ToolDefinition[] = [
  defineTool({
    name: 'list_feature_proposals',
    title: 'List feature proposals',
    description:
      'Feature proposals already submitted to the finance app. Check this before proposing ' +
      "to avoid duplicates; resolved proposals include the user's decision note.",
    inputSchema: featureProposalListQuerySchema.shape,
    annotations: READ_ONLY,
    run: (args, { api }) => api.get('/feature-proposals', args),
  }),
  defineTool({
    name: 'propose_feature',
    title: 'Propose a new feature',
    description:
      'Suggest a new feature for the finance app. The proposal goes into a review queue; ' +
      'the user decides whether it is built. This does NOT implement anything. ' +
      'Proposals may be published to a PUBLIC issue tracker, so describe patterns generically: ' +
      'no names, account numbers, exact balances or exact amounts (use ranges or relative terms ' +
      'like "about 30% above average"). Text containing account numbers is rejected. ' +
      'Submitting the same title as an open proposal returns the existing one.',
    inputSchema: featureProposalFields,
    annotations: APPEND_ONLY,
    run: (args, { api, proposalSource }) => api.post('/feature-proposals', { ...args, source: proposalSource }),
  }),
];
