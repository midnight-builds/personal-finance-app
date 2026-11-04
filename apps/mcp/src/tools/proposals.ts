import { featureProposalFields, featureProposalListQuerySchema } from '@finance-app/shared';
import { APPEND_ONLY, READ_ONLY, defineTool, type ToolDefinition } from './types.js';

// Feature proposals and bug reports: agents suggest, the user decides. Nothing
// here builds anything; `list_feature_proposals` is the agent's feedback channel.

export const proposalTools: ToolDefinition[] = [
  defineTool({
    name: 'list_feature_proposals',
    title: 'List feature proposals',
    description:
      'Feature proposals and bug reports already submitted, with their outcome. Check this before ' +
      'proposing to avoid duplicates, and to learn what has been handled. status: "new" = not reviewed yet, ' +
      '"accepted" = approved but not built yet, "done" = implemented (resolution names the commit ' +
      'or PR), "rejected" = will not be done (decisionNote says why). history lists every status ' +
      'change with time and note. A proposal that is new or accepted counts as open.',
    inputSchema: featureProposalListQuerySchema.shape,
    annotations: READ_ONLY,
    run: (args, { api }) => api.get('/feature-proposals', args),
  }),
  defineTool({
    name: 'propose_feature',
    title: 'Propose a feature or report a bug',
    description:
      'Suggest a new feature (kind "feature") or report something that works incorrectly (kind "bug"). ' +
      'It goes into a review queue; clear bugs are fixed directly, features are built only if the user ' +
      'approves. This does NOT implement anything; follow the outcome with list_feature_proposals. ' +
      'Proposals may be published to a PUBLIC issue tracker, so describe patterns generically: ' +
      'no names, account numbers, exact balances or exact amounts (use ranges or relative terms ' +
      'like "about 30% above average"). Text containing account numbers is rejected. ' +
      'Submitting the same title as an open (new or accepted) proposal returns the existing one.',
    inputSchema: featureProposalFields,
    annotations: APPEND_ONLY,
    run: (args, { api, proposalSource }) => api.post('/feature-proposals', { ...args, source: proposalSource }),
  }),
];
