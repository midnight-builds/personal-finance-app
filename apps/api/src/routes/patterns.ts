import type { FastifyPluginAsync } from 'fastify';
import { patternCreateRequestSchema, patternDecisionListFields, patternDecisionRequestSchema } from '@finance-app/shared';
import { actorOf } from '../http/actor.js';
import { queryParser } from '../http/query.js';
import { createPattern } from '../patternCreation.js';
import { getForecast } from '../forecast.js';
import {
  activePatterns,
  decidePattern,
  establishedSubscriptions,
  listPatternDecisions,
  recurringQuestions,
} from '../patternDecisions.js';

const parseListQuery = queryParser(patternDecisionListFields);

/**
 * Decisions on recurring patterns (GLOSSARY.md, "Pattern decision"): the open
 * "is this recurring?" questions with evidence, answering one, creating a pattern
 * detection never proposed ("Created pattern"), and the decision history. The actor
 * comes from `X-Finance-Actor`.
 */
export const patternRoutes: FastifyPluginAsync = async (app) => {
  // Decisions applied (patternDecisions.ts): subscriptions counted in the monthly total,
  // every active pattern the user has not rejected (lapsed ones too, marked), and the
  // forecast built on them.
  app.get('/subscriptions', async () => establishedSubscriptions());
  app.get('/recurring', async () => activePatterns().sort((a, b) => b.last_seen.localeCompare(a.last_seen)));
  app.get('/forecast', async () => getForecast());

  app.get('/patterns/questions', async () => recurringQuestions());

  app.post<{ Params: { id: string } }>('/patterns/:id/decision', async (request) => {
    const { decision } = patternDecisionRequestSchema.parse(request.body ?? {});
    return decidePattern(request.params.id, decision, actorOf(request));
  });

  app.post('/patterns', async (request) => {
    const input = patternCreateRequestSchema.parse(request.body ?? {});
    return createPattern(input, actorOf(request));
  });

  app.get('/patterns/decisions', async (request) => {
    const { limit, offset } = parseListQuery(request.query);
    return listPatternDecisions(limit, offset);
  });
};
