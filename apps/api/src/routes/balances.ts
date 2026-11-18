import type { FastifyPluginAsync } from 'fastify';
import { createBalanceAdjustment, deleteBalanceAdjustment, listBalanceAdjustments } from '../balanceAdjustments.js';
import { createManualBalanceSnapshot, getBalanceSnapshotsForAccount } from '../balanceSnapshots.js';
import { DomainError } from '../http/errors.js';

// Balance snapshots (the bank's Saldo, or the user's own first balance) and the
// adjustments (saldo-oikaisut) that correct them.
export const balanceRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { accountId: string } }>('/balance-snapshots/:accountId', async (request) =>
    getBalanceSnapshotsForAccount(request.params.accountId)
  );
  app.post('/balance-snapshots', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    return createManualBalanceSnapshot({ accountId: body.accountId, date: body.date, balance: body.balance });
  });

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
