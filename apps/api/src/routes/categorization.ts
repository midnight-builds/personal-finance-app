import type { FastifyPluginAsync } from 'fastify';
import {
  categorizationApplyRequestSchema,
  categorizationPlanRequestSchema,
  categoryRuleListFields,
  changeSetListFields,
} from '@finance-app/shared';
import { apply, getChangeSet, listChangeSets, plan } from '../categorization.js';
import { actorOf } from '../http/actor.js';
import { queryParser } from '../http/query.js';
import { listRules } from '../rules.js';

const parseListQuery = queryParser(changeSetListFields);
const parseRuleQuery = queryParser(categoryRuleListFields);

/**
 * Change sets (docs/CATEGORIES.md): plan an operation, apply it with the plan's
 * token, list and read applied sets. Undo is the `undo` operation. The actor
 * comes from `X-Finance-Actor`. Rules are listed here too, so an agent can find
 * the rule a `disable_rule` names.
 */
export const categorizationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/categorization/rules', async (request) => listRules(parseRuleQuery(request.query)));

  app.post('/categorization/plan', async (request) => {
    const { op } = categorizationPlanRequestSchema.parse(request.body ?? {});
    return plan(op, actorOf(request));
  });

  app.post('/categorization/apply', async (request) => {
    const { op, planToken } = categorizationApplyRequestSchema.parse(request.body ?? {});
    return apply(op, planToken, actorOf(request));
  });

  app.get('/categorization/change-sets', async (request) => listChangeSets(parseListQuery(request.query)));

  app.get<{ Params: { id: string } }>('/categorization/change-sets/:id', async (request) =>
    getChangeSet(request.params.id)
  );
};
