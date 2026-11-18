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
import { createApiClient } from '../../mcp/src/apiClient.js';
import { registerTools, selectTools } from '../../mcp/src/tools/index.js';
import { resetDb } from './setup/resetDb.js';

// End to end, as Hermes: MCP client → the real MCP tools → this API over HTTP →
// the in-memory test database. Fictional counterparties only.

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
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      if (res.isError) throw new Error(res.content[0].text);
      return JSON.parse(res.content[0].text);
    },
  };
}

function monthlyCharges(counterparty: string, amount: number, day: number, iban: string | null, months = 3) {
  const now = new Date().toISOString();
  const account = (db.prepare('SELECT id FROM accounts').get() as { id: string } | undefined)?.id ?? crypto.randomUUID();
  db.prepare('INSERT OR IGNORE INTO accounts (id, created_at, name, type) VALUES (?, ?, ?, ?)').run(account, now, 'Käyttötili', 'bank');
  const session = crypto.randomUUID();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format) VALUES (?, ?, ?, ?)').run(session, now, 'Test', 'CSV');
  for (let m = 1; m <= months; m++) {
    db.prepare(
      `INSERT INTO normalized_transactions (id, created_at, import_session_id, account_id, booking_date, amount, currency, counterparty_name, counterparty_iban)
       VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?, ?)`
    ).run(crypto.randomUUID(), now, session, account, `2026-0${m}-${String(day).padStart(2, '0')}`, amount, counterparty, iban);
  }
  return account;
}

const snapshot = (sql: string) => db.prepare(sql).all().map((r) => ({ ...r }));

test('MCP: Hermes lists questions with evidence, answers one under its actor, and changes nothing else', async () => {
  const agent = await connectAgent();
  const account = monthlyCharges('Rahasto Kasvu', -100, 12, 'FI00 1234 5600 0007 85');
  monthlyCharges('Suoratoisto Kuvavirta', -12.99, 3, null);
  detectPatterns(account, '2026-06-30');

  const money = () => snapshot('SELECT * FROM normalized_transactions ORDER BY id');
  const categorization = () => snapshot('SELECT * FROM categorization_decisions ORDER BY rowid');
  const detected = () => snapshot('SELECT * FROM recurring_patterns ORDER BY id');
  const before = { money: money(), categorization: categorization(), detected: detected() };

  const questions = await agent.call('list_recurring_questions');
  assert.deepEqual(questions.map((q: { counterparty: string }) => q.counterparty), ['Rahasto Kasvu', 'Suoratoisto Kuvavirta']);
  const fund = questions[0];
  assert.deepEqual(fund.reasons, ['low_confidence', 'fixed_amount_account_payment']);
  assert.equal(fund.evidence.transactions.length, 3);
  assert.equal(fund.evidence.paymentMethod, 'account_payment');
  assert.ok(!JSON.stringify(questions).includes('FI00'), 'no IBAN field reaches the agent');

  const answered = await agent.call('answer_recurring_question', { patternId: fund.patternId, decision: 'not_recurring' });
  assert.equal(answered.recorded, true);
  assert.equal(answered.pattern.state, 'rejected');
  assert.equal(answered.pattern.decided_by, 'hermes');

  const again = await agent.call('answer_recurring_question', { patternId: fund.patternId, decision: 'not_recurring' });
  assert.equal(again.recorded, false);

  const remaining = await agent.call('list_recurring_questions');
  assert.deepEqual(remaining.map((q: { counterparty: string }) => q.counterparty), ['Suoratoisto Kuvavirta']);

  const log = await agent.call('list_pattern_decisions');
  assert.equal(log.total, 1);
  assert.deepEqual(
    { actor: log.items[0].actor, decision: log.items[0].decision, counterparty: log.items[0].counterparty },
    { actor: 'hermes', decision: 'not_recurring', counterparty: 'Rahasto Kasvu' }
  );

  // Only the decision history grew: transactions, categories and the detected patterns are as they were.
  assert.deepEqual(money(), before.money);
  assert.deepEqual(categorization(), before.categorization);
  assert.deepEqual(detected(), before.detected);
});

test('MCP: an IBAN inside a counterparty name is redacted in questions and decisions', async () => {
  const agent = await connectAgent();
  const account = monthlyCharges('Vuokranantaja FI00 1234 5600 0007 85', -650, 1, null);
  detectPatterns(account, '2026-06-30');

  const [q] = await agent.call('list_recurring_questions');
  assert.equal(q.counterparty, 'Vuokranantaja [REDACTED]');
  await agent.call('answer_recurring_question', { patternId: q.patternId, decision: 'recurring' });
  const log = await agent.call('list_pattern_decisions');
  assert.equal(log.items[0].counterparty, 'Vuokranantaja [REDACTED]');
  assert.ok(!JSON.stringify(log).includes('5600'));
});

test('MCP: the agent can override a decision the user made; the history shows both', async () => {
  const agent = await connectAgent();
  const account = monthlyCharges('Suoratoisto Kuvavirta', -12.99, 3, null);
  detectPatterns(account, '2026-06-30');
  const [q] = await agent.call('list_recurring_questions');
  const res = await app.inject({ method: 'POST', url: `/patterns/${q.patternId}/decision`, payload: { decision: 'subscription' } });
  assert.equal(res.json().pattern.decided_by, 'user');

  const answered = await agent.call('answer_recurring_question', { patternId: q.patternId, decision: 'not_recurring' });
  assert.equal(answered.pattern.state, 'rejected');
  assert.equal(answered.pattern.decided_by, 'hermes');

  const log = await agent.call('list_pattern_decisions');
  assert.deepEqual(
    log.items.map((i: { actor: string; decision: string; superseded: boolean }) => [i.actor, i.decision, i.superseded]),
    [
      ['hermes', 'not_recurring', false],
      ['user', 'subscription', true],
    ]
  );

  const reset = await agent.call('answer_recurring_question', { patternId: q.patternId, decision: 'reset' });
  assert.equal(reset.pattern.state, 'unconfirmed');
});

test('MCP: Hermes rejects a confident pattern it was never asked about, and can change its own answer', async () => {
  const { computeMonthlyForecast } = await import('../src/forecast.js');
  const agent = await connectAgent();
  const account = monthlyCharges('Säästökortti Kasvu', -200, 5, null, 6);
  detectPatterns(account, '2026-06-30');
  assert.deepEqual(await agent.call('list_recurring_questions'), [], 'confident: not asked');
  const fixedNames = () => computeMonthlyForecast(1, '2026-06-30', []).knownFixed.map((i) => i.counterparty);
  assert.deepEqual(fixedNames(), ['Säästökortti Kasvu']);

  // The id as list_recurring returns it.
  const { id } = db.prepare("SELECT id FROM recurring_patterns WHERE counterparty_name = 'Säästökortti Kasvu'").get() as { id: string };
  const rejected = await agent.call('answer_recurring_question', { patternId: id, decision: 'not_recurring' });
  assert.equal(rejected.recorded, true);
  assert.equal(rejected.pattern.state, 'rejected');
  assert.deepEqual(fixedNames(), []);

  const changed = await agent.call('answer_recurring_question', { patternId: id, decision: 'recurring' });
  assert.equal(changed.pattern.state, 'confirmed_recurring');
  assert.equal(changed.pattern.decided_by, 'hermes');
  assert.deepEqual(fixedNames(), ['Säästökortti Kasvu']);
  const log = await agent.call('list_pattern_decisions');
  assert.deepEqual(log.items.map((i: { decision: string; superseded: boolean }) => [i.decision, i.superseded]), [
    ['recurring', false],
    ['not_recurring', true],
  ]);
});

test('MCP: answering an unknown pattern or with an unknown answer is a tool error', async () => {
  const agent = await connectAgent();
  await assert.rejects(agent.call('answer_recurring_question', { patternId: 'missing', decision: 'recurring' }), /404/);
  await assert.rejects(agent.call('answer_recurring_question', { patternId: 'missing', decision: 'maybe' }));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM pattern_decisions').get() as { n: number }).n, 0);
});

test('MCP: the glossary names the app’s terms', async () => {
  const agent = await connectAgent();
  const { terms } = await agent.call('get_glossary');
  const names = terms.map((t: { term: string }) => t.term);
  for (const term of ['Transfer', 'Subscription', 'Recurring question', 'Pattern decision', 'Established pattern']) {
    assert.ok(names.includes(term), term);
  }
  const transfer = terms.find((t: { term: string }) => t.term === 'Transfer');
  assert.match(transfer.summary, /own accounts/);
});
