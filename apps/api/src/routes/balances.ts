import type { FastifyPluginAsync } from 'fastify';
import { createBalanceAdjustment, deleteBalanceAdjustment, listBalanceAdjustments } from '../balanceAdjustments.js';
import { applyAccountChangeNow } from '../accountChanges.js';
import { getBalanceSnapshotsForAccount } from '../balanceSnapshots.js';
import { listAccountObservations } from '../balanceObservations.js';
import { netWorth } from '../balanceHistory.js';
import { actorOf } from '../http/actor.js';
import { DomainError } from '../http/errors.js';

// Balance snapshots (the bank's Saldo), balance observations (an actor's dated
// balance, GLOSSARY.md "Balance observation"), the adjustments (saldo-oikaisut)
// that correct the bank's balance, and the current net worth. The web UI writes
// observations here at once (plan + apply) with the request's actor; agents
// plan and apply them as account change sets (POST /accounts/plan|apply).
export const balanceRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { accountId: string } }>('/balance-snapshots/:accountId', async (request) =>
    getBalanceSnapshotsForAccount(request.params.accountId)
  );

  app.get<{ Params: { id: string } }>('/accounts/:id/balance-observations', async (request) =>
    listAccountObservations(request.params.id)
  );
  app.post<{ Params: { id: string } }>('/accounts/:id/balance-observations', async (request) => {
    const { date, amount, note } = (request.body ?? {}) as Record<string, unknown>;
    return applyAccountChangeNow(
      { kind: 'add_balance_observation', accountId: request.params.id, date, amount, ...(note ? { note } : {}) },
      actorOf(request)
    );
  });
  app.patch<{ Params: { id: string } }>('/balance-observations/:id', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const op: Record<string, unknown> = { kind: 'correct_balance_observation', observationId: request.params.id };
    for (const key of ['date', 'amount', 'note'] as const) if (key in body) op[key] = key === 'note' && body.note === '' ? null : body[key];
    return applyAccountChangeNow(op, actorOf(request));
  });
  app.delete<{ Params: { id: string } }>('/balance-observations/:id', async (request) =>
    applyAccountChangeNow({ kind: 'delete_balance_observation', observationId: request.params.id }, actorOf(request))
  );

  app.get('/net-worth', async () => netWorth());

  app.get('/balance-adjustments', async () => listBalanceAdjustments());
  app.post('/balance-adjustments', async (request, reply) => {
    const { accountId, date, amount, reason } = (request.body ?? {}) as any;
    if (!accountId || typeof accountId !== 'string') return reply.code(400).send({ error: 'account_missing' });
    if (!date || typeof date !== 'string') return reply.code(400).send({ error: 'date_missing' });
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum)) return reply.code(400).send({ error: 'amount_invalid' });
    return createBalanceAdjustment({ accountId, date, amount: amountNum, reason: reason ?? null });
  });
  app.delete<{ Params: { id: string } }>('/balance-adjustments/:id', async (request) => {
    if (!deleteBalanceAdjustment(request.params.id)) throw DomainError.notFound();
    return { ok: true };
  });
};
