import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db.js';
import { actorOf } from '../http/actor.js';
import { createCategory, deleteCategory, listCategories, renameCategory, upsertDecision } from '../rules.js';
import { acceptRuleSuggestion, listPendingRuleSuggestions, rejectRuleSuggestion } from '../ruleSuggestions.js';

const message = (err: unknown) => (err instanceof Error ? err.message : 'unknown');

/**
 * Categories, a transaction's category and rule suggestions. Moved from
 * index.ts as they were: each route answers its own errors with
 * `{ error: <code> }` and the same statuses as before. Changes record the
 * actor of the request (`X-Finance-Actor`).
 */
export const categoryRoutes: FastifyPluginAsync = async (app) => {
  app.get('/categories', async () => listCategories());

  app.post('/categories', async (request, reply) => {
    const { name } = (request.body as { name?: unknown } | undefined) ?? {};
    try {
      return reply.send(createCategory(String(name ?? '')));
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.patch<{ Params: { id: string }; Body: { name: string } }>('/categories/:id', async (request, reply) => {
    try {
      renameCategory(request.params.id, request.body?.name);
      return reply.send({ ok: true });
    } catch (err) {
      const msg = message(err);
      const status = ['name_exists', 'name_required', 'category_archived'].includes(msg) ? 400 : 404;
      return reply.code(status).send({ error: msg });
    }
  });

  // Categories are archived, never deleted; the route keeps its old name and shape.
  app.delete<{ Params: { id: string } }>('/categories/:id', async (request, reply) => {
    try {
      const res = deleteCategory(request.params.id, { actor: actorOf(request) });
      return reply.send({ ok: true, reassignedTo: res.reassignedTo });
    } catch (err) {
      const msg = message(err);
      const status = ['category_has_role', 'invalid_move_target'].includes(msg) ? 400 : 404;
      return reply.code(status).send({ error: msg });
    }
  });

  app.post<{ Params: { id: string }; Body: { categoryId: string } }>(
    '/transactions/:id/category',
    async (request, reply) => {
      const { id } = request.params;
      const { categoryId } = request.body || {};
      if (!categoryId) return reply.code(400).send({ error: 'category_missing' });
      const category = db.prepare('SELECT archived_at FROM categories WHERE id = ?').get(categoryId) as
        | { archived_at: string | null }
        | undefined;
      if (category?.archived_at) return reply.code(400).send({ error: 'category_archived' });
      const tx = db
        .prepare('SELECT counterparty_name, description FROM normalized_transactions WHERE id = ?')
        .get(id) as { counterparty_name: string | null; description: string | null } | undefined;
      upsertDecision({
        transactionId: id,
        categoryId,
        source: 'user',
        counterparty: tx?.counterparty_name ?? null,
        description: tx?.description ?? null,
        actor: actorOf(request),
      });
      return reply.send({ ok: true });
    }
  );

  app.get('/rule-suggestions', async () => listPendingRuleSuggestions());

  app.post<{ Params: { id: string } }>('/rule-suggestions/:id/accept', async (request, reply) => {
    try {
      acceptRuleSuggestion(request.params.id, { actor: actorOf(request) });
      return reply.send({ ok: true });
    } catch (err) {
      const msg = message(err);
      const code = msg === 'not_found' ? 404 : msg === 'not_pending' ? 409 : 500;
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
