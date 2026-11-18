import type { FastifyPluginAsync } from 'fastify';
import {
  ACCOUNT_TYPES,
  accountApplyRequestSchema,
  accountChangeSetListFields,
  accountPlanRequestSchema,
  type AccountOpInput,
} from '@finance-app/shared';
import {
  applyAccountChange,
  applyAccountChangeNow,
  getAccountChangeSet,
  listAccountChangeSets,
  planAccountChange,
} from '../accountChanges.js';
import { listAccounts, updateAccountDetails } from '../accounts.js';
import { db } from '../db.js';
import { actorOf } from '../http/actor.js';
import { DomainError } from '../http/errors.js';
import { queryParser } from '../http/query.js';

const parseListQuery = queryParser(accountChangeSetListFields);

/** PATCH body keys (the web UI's snake_case) that are account change-set fields. */
const CHANGE_SET_KEYS = {
  name: 'name',
  account_subtype: 'type',
  ownership_share: 'ownershipShare',
  currency: 'currency',
  iban: 'iban',
  update_interval_days: 'updateIntervalDays',
} as const;
const DETAIL_KEYS = ['owner_label', 'credit_limit', 'savings_goal'] as const;

/**
 * Accounts (GLOSSARY.md, "Account"). The web UI lists and edits them here;
 * name, type, share, currency, IBAN and update interval change through account
 * change sets with the request's actor (`X-Finance-Actor`), as agents do with
 * plan/apply. Agents never see an IBAN: change sets and plans omit it.
 */
export const accountRoutes: FastifyPluginAsync = async (app) => {
  app.get('/accounts', async () => listAccounts());

  // Creates a manual account at once (plan + apply), for the web UI.
  app.post('/accounts', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const set = applyAccountChangeNow({ ...body, kind: 'create_account' }, actorOf(request));
    return { id: set.accountId, changeSet: set };
  });

  app.patch<{ Params: { id: string } }>('/accounts/:id', async (request) => {
    const { id } = request.params;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) throw DomainError.notFound();
    const subtype = body.account_subtype;
    if (subtype !== undefined && !(ACCOUNT_TYPES as readonly unknown[]).includes(subtype)) {
      throw new DomainError('invalid_account_subtype', 400);
    }

    const op: Record<string, unknown> = { kind: 'update_account', accountId: id };
    for (const [key, field] of Object.entries(CHANGE_SET_KEYS)) {
      if (!(key in body)) continue;
      // An emptied IBAN or interval field removes it.
      op[field] = (key === 'iban' || key === 'update_interval_days') && body[key] === '' ? null : body[key];
    }
    let changeSetId: string | null = null;
    if (Object.keys(op).length > 2) {
      const plan = planAccountChange(op as AccountOpInput);
      if (plan.changes.length > 0) changeSetId = applyAccountChange(op, plan.planToken, actorOf(request)).id;
    }

    const details: Record<string, unknown> = {};
    for (const key of DETAIL_KEYS) if (key in body) details[key] = body[key];
    updateAccountDetails(id, details);
    return { ok: true, changeSetId };
  });

  app.post<{ Params: { id: string } }>('/accounts/:id/archive', async (request) =>
    applyAccountChangeNow({ kind: 'archive_account', accountId: request.params.id }, actorOf(request))
  );

  app.post('/accounts/plan', async (request) => {
    const { op } = accountPlanRequestSchema.parse(request.body ?? {});
    return planAccountChange(op);
  });

  app.post('/accounts/apply', async (request) => {
    const { op, planToken } = accountApplyRequestSchema.parse(request.body ?? {});
    return applyAccountChange(op, planToken, actorOf(request));
  });

  app.get('/accounts/change-sets', async (request) => listAccountChangeSets(parseListQuery(request.query)));

  app.get<{ Params: { id: string } }>('/accounts/change-sets/:id', async (request) =>
    getAccountChangeSet(request.params.id)
  );
};
