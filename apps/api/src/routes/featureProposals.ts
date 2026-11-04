import type { FastifyPluginAsync } from 'fastify';
import {
  FEATURE_PROPOSAL_ACTIONS,
  featureProposalDecisionSchema,
  featureProposalListQuerySchema,
} from '@finance-app/shared';
import { createFeatureProposal, listFeatureProposals, resolveFeatureProposal } from '../featureProposals.js';
import { queryParser } from '../http/query.js';

const parseListQuery = queryParser(featureProposalListQuerySchema.shape);

export const featureProposalRoutes: FastifyPluginAsync = async (app) => {
  app.get('/feature-proposals', async (request) => {
    const { status } = parseListQuery(request.query);
    return listFeatureProposals(status);
  });

  app.post('/feature-proposals', async (request, reply) => {
    const result = createFeatureProposal(request.body);
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  for (const [action, decision] of Object.entries(FEATURE_PROPOSAL_ACTIONS)) {
    app.post<{ Params: { id: string } }>(`/feature-proposals/:id/${action}`, async (request) => {
      const { note, resolution } = featureProposalDecisionSchema.parse(request.body ?? {});
      return resolveFeatureProposal(request.params.id, decision, note, resolution);
    });
  }
};
