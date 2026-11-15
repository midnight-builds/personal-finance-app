import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { db } from '../src/db.js';
import { routes } from '../src/routes/index.js';
import { appendDecision } from '../src/rules.js';
import { createApiClient } from '../../mcp/src/apiClient.js';
import { registerTools, selectTools } from '../../mcp/src/tools/index.js';
import { resetDb } from './setup/resetDb.js';

// End to end: an agent's MCP client → the real MCP tools and API client →
// this API over HTTP → the in-memory test database. The MCP server is
// configured with actor "hermes", as in production.

const app = Fastify();
await app.register(routes);
const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
after(() => app.close());

beforeEach(() => resetDb());

async function connectAgent() {
  const server = new McpServer({ name: 'finance-app', version: 'test' });
  const api = createApiClient(baseUrl, fetch, { actor: 'hermes' });
  registerTools(server, selectTools(new Set()), { api, proposalSource: 'hermes' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hermes', version: 'test' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  after(() => client.close());
  return {
    /** Calls a tool; returns its first content block parsed, or throws with the tool error text. */
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      if (res.isError) throw new Error(res.content[0].text);
      return JSON.parse(res.content[0].text);
    },
  };
}

const roleId = (role: string) => (db.prepare('SELECT id FROM categories WHERE role = ?').get(role) as { id: string }).id;
const latest = (txId: string) => ({
  ...(db
    .prepare(
      'SELECT category_id AS categoryId, source, actor FROM categorization_decisions WHERE transaction_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
    )
    .get(txId) as { categoryId: string; source: string; actor: string | null }),
});

function mkTx(counterparty: string, amount: number) {
  const now = new Date().toISOString();
  const account = crypto.randomUUID();
  const session = crypto.randomUUID();
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, type) VALUES (?, ?, ?, ?)').run(account, now, 'Testitili', 'bank');
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format) VALUES (?, ?, ?, ?)').run(session, now, 'Test', 'CSV');
  db.prepare(
    `INSERT INTO normalized_transactions (id, created_at, import_session_id, account_id, booking_date, amount, currency, counterparty_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, now, session, account, '2026-11-01', amount, 'EUR', counterparty);
  appendDecision({ transactionId: id, categoryId: roleId('fallback'), source: 'rule' });
  return id;
}

test('MCP: plan, apply, change log shows actor hermes, undo through plan and apply; money untouched', async () => {
  const agent = await connectAgent();
  const tx = mkTx('Lautapelikahvila Noppa', -24.5);
  const money = () =>
    db
      .prepare('SELECT amount, booking_date, account_id, counterparty_name FROM normalized_transactions')
      .all()
      .map((r) => ({ ...r }));
  const moneyBefore = money();

  const categories = (await agent.call('list_categories')) as Array<{ id: string; name: string; role: string | null }>;
  assert.ok(categories.some((c) => c.role === 'fallback'), 'roles are listed');
  const fun = categories.find((c) => c.name === 'Viihde ja harrastukset')!.id;

  // Plan: nothing written.
  const op = { kind: 'recategorize', transactionIds: [tx], categoryId: fun, reason: 'peli-ilta' };
  const plan = await agent.call('plan_categorization', { op });
  assert.deepEqual(plan.rows, [{ transactionId: tx, fromCategoryId: roleId('fallback'), toCategoryId: fun }]);
  assert.equal(latest(tx).categoryId, roleId('fallback'));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM change_sets').get() as { n: number }).n, 0);

  // Apply: recorded as hermes; a retry with the same token is the same set.
  const set = await agent.call('apply_categorization', { op, planToken: plan.planToken });
  assert.deepEqual([set.kind, set.actor, set.reason, set.status], ['recategorize', 'hermes', 'peli-ilta', 'applied']);
  assert.deepEqual(latest(tx), { categoryId: fun, source: 'user', actor: 'hermes' });
  assert.equal((await agent.call('apply_categorization', { op, planToken: plan.planToken })).id, set.id);

  const log = await agent.call('list_category_changes');
  assert.deepEqual(
    log.items.map((s: { id: string; actor: string; kind: string }) => [s.id, s.actor, s.kind]),
    [[set.id, 'hermes', 'recategorize']]
  );
  assert.equal((await agent.call('get_category_change', { id: set.id })).rowsTotal, 1);

  // Undo is an operation like any other: plan, then apply.
  const undoOp = { kind: 'undo', changeSetId: set.id, reason: 'väärä kategoria' };
  const undoPlan = await agent.call('plan_categorization', { op: undoOp });
  assert.deepEqual(undoPlan.rows, [{ transactionId: tx, fromCategoryId: fun, toCategoryId: roleId('fallback') }]);
  const undo = await agent.call('apply_categorization', { op: undoOp, planToken: undoPlan.planToken });
  assert.equal(undo.undoOfId, set.id);
  assert.equal(latest(tx).categoryId, roleId('fallback'));

  const afterUndo = await agent.call('list_category_changes');
  assert.deepEqual(
    afterUndo.items.map((s: { kind: string; actor: string; status: string }) => [s.kind, s.actor, s.status]),
    [
      ['undo', 'hermes', 'applied'],
      ['recategorize', 'hermes', 'undone'],
    ]
  );
  assert.deepEqual(money(), moneyBefore);
});

test('MCP: a plan gone stale is refused with plan_stale; rules are listed and can be created', async () => {
  const agent = await connectAgent();
  const tx = mkTx('Elokuvateatteri Kuvaruutu', -12);
  const categories = (await agent.call('list_categories')) as Array<{ id: string; name: string }>;
  const fun = categories.find((c) => c.name === 'Viihde ja harrastukset')!.id;
  const op = { kind: 'create_rule', pattern: 'Kuvaruutu', matchField: 'counterparty', categoryId: fun };
  const plan = await agent.call('plan_categorization', { op });
  assert.equal(plan.rowsTotal, 1);

  // The user picks a category in the web UI (no actor header) before the agent applies.
  const pick = await app.inject({ method: 'POST', url: `/transactions/${tx}/category`, payload: { categoryId: roleId('refund') } });
  assert.equal(pick.statusCode, 200);
  await assert.rejects(agent.call('apply_categorization', { op, planToken: plan.planToken }), /409.*"error":"plan_stale"/);

  // Planned again, the manual decision is an exception: a rule never overrides it.
  const again = await agent.call('plan_categorization', { op });
  assert.equal(again.rowsTotal, 0);
  assert.deepEqual(again.exceptions, [{ transactionId: tx, reason: 'manual_decision' }]);
  const set = await agent.call('apply_categorization', { op, planToken: again.planToken });
  assert.equal(set.actor, 'hermes');
  assert.equal(latest(tx).categoryId, roleId('refund'));

  const rules = (await agent.call('list_category_rules')) as Array<{ id: string; pattern: string; actor: string | null }>;
  assert.deepEqual(
    rules.filter((r) => r.pattern === 'kuvaruutu').map((r) => r.actor),
    ['hermes']
  );
});
