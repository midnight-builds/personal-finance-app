import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { applyNow, archiveCategory, createCategory, renameCategory } from '../categorization.js';
import { actorOf } from '../http/actor.js';
import { DomainError } from '../http/errors.js';
import { listCategories } from '../rules.js';
import { acceptRuleSuggestion, listPendingRuleSuggestions, rejectRuleSuggestion } from '../ruleSuggestions.js';

const message = (err: unknown) => (err instanceof Error ? err.message : 'unknown');

/**
 * Answers a change-set error in the shape these routes always had:
 * `{ error: <code> }`, with the old codes and statuses. `renames` maps the
 * service's codes to the old ones (e.g. `category_not_found` → 404 `not_found`).
 */
function legacyError(reply: FastifyReply, err: unknown, renames: Record<string, [number, string]> = {}) {
  if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid_request' });
  if (!(err instanceof DomainError)) throw err;
  const [status, code] = renames[err.code] ?? [err.statusCode, err.code];
  return reply.code(status).send({ error: code });
}

const NOT_FOUND: [number, string] = [404, 'not_found'];

/**
 * Categories, a transaction's category and rule suggestions. Each route answers
 * its own errors with `{ error: <code> }` and the same statuses as before.
 * Category changes go through the change-set service (src/categorization.ts),
 * applied directly, and record the actor of the request (`X-Finance-Actor`).
 */
export const categoryRoutes: FastifyPluginAsync = async (app) => {
  app.get('/categories', async () => listCategories());

  app.post('/categories', async (request, reply) => {
    const { name } = (request.body as { name?: unknown } | undefined) ?? {};
    try {
      return reply.send(createCategory(String(name ?? ''), { actor: actorOf(request) }));
    } catch (err) {
      return legacyError(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: { name: string } }>('/categories/:id', async (request, reply) => {
    try {
      renameCategory(request.params.id, String(request.body?.name ?? ''), { actor: actorOf(request) });
      return reply.send({ ok: true });
    } catch (err) {
      return legacyError(reply, err, { category_not_found: NOT_FOUND });
    }
  });

  // Categories are archived, never deleted; the route keeps its old name and shape.
  app.delete<{ Params: { id: string } }>('/categories/:id', async (request, reply) => {
    try {
      const res = archiveCategory(request.params.id, { actor: actorOf(request) });
      return reply.send({ ok: true, reassignedTo: res.reassignedTo });
    } catch (err) {
      return legacyError(reply, err, { category_not_found: NOT_FOUND, category_archived: NOT_FOUND });
    }
  });

  // A one-row manual recategorization; still learns a rule from the row for the UI.
  app.post<{ Params: { id: string }; Body: { categoryId: string } }>(
    '/transactions/:id/category',
    async (request, reply) => {
      const { id } = request.params;
      const { categoryId } = request.body || {};
      if (!categoryId) return reply.code(400).send({ error: 'category_missing' });
      try {
        applyNow({ kind: 'recategorize', transactionIds: [id], categoryId }, actorOf(request), { learnRule: true });
        return reply.send({ ok: true });
      } catch (err) {
        return legacyError(reply, err, { category_not_found: NOT_FOUND, unknown_transactions: NOT_FOUND });
      }
    }
  );

  app.get('/rule-suggestions', async () => listPendingRuleSuggestions());

  app.post<{ Params: { id: string } }>('/rule-suggestions/:id/accept', async (request, reply) => {
    try {
      acceptRuleSuggestion(request.params.id, { actor: actorOf(request) });
      return reply.send({ ok: true });
    } catch (err) {
      const msg = message(err);
      const code = msg === 'not_found' ? 404 : msg === 'not_pending' || msg === 'category_archived' ? 409 : 500;
      return reply.code(code).send({ error: msg });
    }
  });

  app.post<{ Params: { id: string } }>('/rule-suggestions/:id/reject', async (request, reply) => {
    try {
      rejectRuleSuggestion(request.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      const msg = message(err);
      return reply.code(msg === 'not_found' ? 404 : 500).send({ error: msg });
    }
  });
};
