import type { FastifyPluginAsync } from 'fastify';
import { patternDecisionListFields, patternDecisionRequestSchema } from '@finance-app/shared';
import { actorOf } from '../http/actor.js';
import { queryParser } from '../http/query.js';
import { decidePattern, listPatternDecisions, recurringQuestions } from '../patternDecisions.js';

const parseListQuery = queryParser(patternDecisionListFields);

/**
 * Decisions on recurring patterns (GLOSSARY.md, "Pattern decision"): the open
 * "is this recurring?" questions with evidence, answering one, and the decision
 * history. The actor comes from `X-Finance-Actor`.
 */
export const patternRoutes: FastifyPluginAsync = async (app) => {
  app.get('/patterns/questions', async () => recurringQuestions());

  app.post<{ Params: { id: string } }>('/patterns/:id/decision', async (request) => {
    const { decision } = patternDecisionRequestSchema.parse(request.body ?? {});
    return decidePattern(request.params.id, decision, actorOf(request));
  });

  app.get('/patterns/decisions', async (request) => {
    const { limit, offset } = parseListQuery(request.query);
    return listPatternDecisions(limit, offset);
  });
};
