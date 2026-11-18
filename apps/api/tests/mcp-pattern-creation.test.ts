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
import { detectPatterns } from '../src/patterns.js';
import { computeMonthlyForecast } from '../src/forecast.js';
import { establishedSubscriptions } from '../src/patternDecisions.js';
import { createApiClient } from '../../mcp/src/apiClient.js';
import { registerTools, selectTools } from '../../mcp/src/tools/index.js';
import { resetDb } from './setup/resetDb.js';

// End to end, as an agent: MCP client → the real MCP tools → this API over HTTP →
// the in-memory test database. The agent's name is whatever its server is
// configured with; this one is fictional, as are all counterparties.

const ACTOR = 'assistant-x';

const app = Fastify();
await app.register(routes);
const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
after(() => app.close());

beforeEach(() => resetDb());

async function connectAgent() {
  const server = new McpServer({ name: 'finance-app', version: 'test' });
  const api = createApiClient(baseUrl, fetch, { actor: ACTOR });
  registerTools(server, selectTools(new Set()), { api, proposalSource: ACTOR });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: ACTOR, version: 'test' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  after(() => client.close());
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      if (res.isError) throw new Error(res.content[0].text);
      return JSON.parse(res.content[0].text);
    },
  };
}

function account() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO accounts (id, created_at, name, type) VALUES (?, ?, ?, ?)').run(id, now, 'Käyttötili', 'bank');
  const session = crypto.randomUUID();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format) VALUES (?, ?, ?, ?)').run(session, now, 'Test', 'CSV');
  return {
    id,
    charge(counterparty: string, amount: number, date: string) {
      const tx = crypto.randomUUID();
      db.prepare(
        `INSERT INTO normalized_transactions (id, created_at, import_session_id, account_id, booking_date, amount, currency, counterparty_name)
         VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?)`
      ).run(tx, now, session, id, date, amount, counterparty);
      return tx;
    },
  };
}

const snapshot = (sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));

test('MCP: the agent creates a pattern from one charge; it is confirmed under its actor and nothing else changes', async () => {
  const agent = await connectAgent();
  const a = account();
  const tx = a.charge('Pilvitallennus Säilö', -4.99, '2026-06-03');
  a.charge('Ruokakauppa Kulma', -23.5, '2026-06-04');
  db.prepare('INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), new Date().toISOString(), a.id, '2026-06-04', 1000, 'EUR');
  detectPatterns(a.id, '2026-06-30');

  const money = () => snapshot('SELECT * FROM normalized_transactions ORDER BY id');
  const categorization = () => snapshot('SELECT * FROM categorization_decisions ORDER BY rowid');
  const balances = () => snapshot('SELECT * FROM balance_snapshots ORDER BY id');
  const before = { money: money(), categorization: categorization(), balances: balances() };

  const res = await agent.call('create_recurring_pattern', {
    accountId: a.id,
    counterparty: 'Pilvitallennus Säilö',
    kind: 'subscription',
    interval: 'monthly',
    expectedAmount: 4.99,
    evidenceTransactionIds: [tx],
  });
  assert.equal(res.created, true);
  assert.equal(res.pattern.origin, 'created');
  assert.equal(res.pattern.created_by, ACTOR);
  assert.equal(res.pattern.decided_by, ACTOR);
  assert.equal(res.pattern.state, 'confirmed_subscription');
  assert.deepEqual(res.pattern.evidence_transaction_ids, [tx], 'ids reach the agent unredacted');

  const item = computeMonthlyForecast(1, '2026-06-30', []).knownFixed.find((i) => i.patternId === res.pattern.id);
  assert.equal(item?.origin, 'created');
  assert.deepEqual(establishedSubscriptions().map((p) => p.id), [res.pattern.id]);

  const log = await agent.call('list_pattern_decisions');
  assert.deepEqual(
    log.items.map((i: { actor: string; decision: string }) => [i.actor, i.decision]),
    [[ACTOR, 'subscription']]
  );

  const again = await agent.call('create_recurring_pattern', {
    accountId: a.id,
    counterparty: 'Pilvitallennus Säilö',
    kind: 'subscription',
    interval: 'monthly',
    expectedAmount: 4.99,
    evidenceTransactionIds: [tx],
  });
  assert.deepEqual([again.created, again.updated], [false, false]);

  // The agent can reject what it created, like any pattern.
  const rejected = await agent.call('answer_recurring_question', { patternId: res.pattern.id, decision: 'not_recurring' });
  assert.equal(rejected.pattern.state, 'rejected');
  assert.deepEqual(establishedSubscriptions(), []);

  assert.deepEqual(money(), before.money);
  assert.deepEqual(categorization(), before.categorization);
  assert.deepEqual(balances(), before.balances);
});

test('MCP: a counterparty with an account number is named as the agent sees it, redacted', async () => {
  const agent = await connectAgent();
  const a = account();
  const tx = a.charge('Vuokranantaja FI00 1234 5600 0007 85', -650, '2026-06-01');
  const res = await agent.call('create_recurring_pattern', {
    accountId: a.id,
    counterparty: 'Vuokranantaja [REDACTED]',
    kind: 'recurring',
    interval: 'monthly',
    expectedAmount: 650,
    evidenceTransactionIds: [tx],
  });
  assert.equal(res.pattern.counterparty_name, 'Vuokranantaja [REDACTED]');
  assert.ok(!JSON.stringify(res).includes('5600'));
  const stored = db.prepare('SELECT counterparty_name FROM recurring_patterns').get() as { counterparty_name: string };
  assert.equal(stored.counterparty_name, 'Vuokranantaja FI00 1234 5600 0007 85', 'stored under the real name');
});

test('MCP: evidence that does not fit is a tool error naming the code, and writes nothing', async () => {
  const agent = await connectAgent();
  const a = account();
  const income = a.charge('Pilvitallennus Säilö', 4.99, '2026-06-03');
  await assert.rejects(
    agent.call('create_recurring_pattern', {
      accountId: a.id,
      counterparty: 'Pilvitallennus Säilö',
      kind: 'subscription',
      interval: 'monthly',
      expectedAmount: 4.99,
      evidenceTransactionIds: [income],
    }),
    /400.*evidence_not_charge/
  );
  await assert.rejects(
    agent.call('create_recurring_pattern', {
      accountId: a.id,
      counterparty: 'Pilvitallennus Säilö',
      kind: 'subscription',
      interval: 'yearly',
      expectedAmount: 4.99,
      evidenceTransactionIds: [income],
    })
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM recurring_patterns').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pattern_decisions').get() as { n: number }).n, 0);
});

test('MCP: a created pattern whose charges stopped is shown lapsed in list_recurring and get_forecast, counted nowhere', async () => {
  const agent = await connectAgent();
  const a = account();
  const tx = a.charge('Kuntosali Liikku', -39.9, '2026-03-04');
  a.charge('Ruokakauppa Kulma', -12.3, '2026-06-01'); // two monthly periods later, no charge

  const res = await agent.call('create_recurring_pattern', {
    accountId: a.id,
    counterparty: 'Kuntosali Liikku',
    kind: 'subscription',
    interval: 'monthly',
    expectedAmount: 39.9,
    evidenceTransactionIds: [tx],
  });
  assert.equal(res.pattern.lapsed, true);
  assert.equal(res.pattern.lapsed_since, '2026-05-10');

  const listed = (await agent.call('list_recurring')) as Array<{ id: string; lapsed: boolean; lapsed_since: string | null }>;
  assert.deepEqual(listed.map((p) => [p.id, p.lapsed, p.lapsed_since]), [[res.pattern.id, true, '2026-05-10']]);

  const forecast = (await agent.call('get_forecast')) as Array<{
    knownFixed: unknown[];
    knownFixedTotal: number;
    lapsedRecurring: Array<{ patternId: string; lapsed: boolean; lapsedSince: string }>;
  }>;
  for (const month of forecast) {
    assert.deepEqual(month.knownFixed, []);
    assert.equal(month.knownFixedTotal, 0);
    assert.deepEqual(month.lapsedRecurring.map((i) => [i.patternId, i.lapsed, i.lapsedSince]), [[res.pattern.id, true, '2026-05-10']]);
  }
});

test('MCP: get_forecast counts a weekly pattern once per expected charge in the month', async () => {
  const agent = await connectAgent();
  const a = account();
  // Weekly on Mondays up to the latest booking, so it has not lapsed.
  const ids = ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22'].map((d) => a.charge('Siivouspalvelu Kiilto', -25, d));
  await agent.call('create_recurring_pattern', {
    accountId: a.id,
    counterparty: 'Siivouspalvelu Kiilto',
    kind: 'recurring',
    interval: 'weekly',
    expectedAmount: 25,
    evidenceTransactionIds: ids,
  });
  const forecast = (await agent.call('get_forecast')) as Array<{
    targetMonth: string;
    knownFixed: Array<{ chargesInMonth: number; amount: number }>;
  }>;
  for (const month of forecast) {
    const [y, m] = month.targetMonth.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let mondays = 0;
    for (let d = 1; d <= days; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 1) mondays++;
    assert.deepEqual(month.knownFixed.map((i) => [i.chargesInMonth, i.amount]), [[mondays, mondays * 25]], month.targetMonth);
  }
});

test('MCP: the agent creates a yearly pattern; it is forecast in its month, its annual question resolved, and it can be rejected', async () => {
  const agent = await connectAgent();
  const a = account();
  // Charged a year before the first forecast month (next month).
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 10));
  const day = `${next.getUTCFullYear() - 1}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-10`;
  const tx = a.charge('Vakuutusyhtiö Turva', -300, day);
  detectPatterns(a.id);
  const pending = () => db.prepare("SELECT COUNT(*) AS n FROM pattern_confirmations WHERE status = 'pending'").get() as { n: number };
  assert.equal(pending().n, 1, 'asked as an annual confirmation');

  const res = await agent.call('create_recurring_pattern', {
    accountId: a.id,
    counterparty: 'Vakuutusyhtiö Turva',
    kind: 'recurring',
    interval: 'yearly',
    expectedAmount: 300,
    evidenceTransactionIds: [tx],
  });
  assert.equal(res.pattern.pattern_type, 'annual');
  assert.equal(res.pattern.typical_month, next.getUTCMonth() + 1);
  assert.equal(res.pattern.state, 'confirmed_recurring');
  assert.equal(res.pattern.lapsed, false);
  assert.equal(pending().n, 0, 'the annual question is resolved');

  type Month = { annualItems: Array<{ patternId: string; origin: string; amount: number }> };
  const forecast = (await agent.call('get_forecast')) as Month[];
  assert.deepEqual(forecast[0].annualItems.map((i) => [i.patternId, i.origin, i.amount]), [[res.pattern.id, 'created', 300]]);
  assert.deepEqual([...forecast[1].annualItems, ...forecast[2].annualItems], []);

  const rejected = await agent.call('answer_recurring_question', { patternId: res.pattern.id, decision: 'not_recurring' });
  assert.equal(rejected.pattern.state, 'rejected');
  assert.deepEqual(((await agent.call('get_forecast')) as Month[])[0].annualItems, []);
  const log = await agent.call('list_pattern_decisions');
  assert.deepEqual(
    log.items.map((i: { actor: string; decision: string; annual: boolean }) => [i.actor, i.decision, i.annual]),
    [[ACTOR, 'not_recurring', true], [ACTOR, 'recurring', true]]
  );
});
