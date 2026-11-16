import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApiError, type ApiClient } from '../src/apiClient.js';
import { ALL_TOOLS, TOOL_NAMES, registerTools, selectTools } from '../src/tools/index.js';

type Call = { method: 'get' | 'post'; path: string; arg?: unknown };

/**
 * Connects a real MCP client to a server backed by a fake API that records
 * calls. The runner's own `/data-status` lookups are answered but not recorded.
 */
async function connect(responses: Record<string, unknown> = {}, disabled: string[] = []) {
  const calls: Call[] = [];
  const respond = async (path: string) => {
    const r = responses[path];
    if (r instanceof Error) throw r;
    return r ?? {};
  };
  const api: ApiClient = {
    get: (path, query) => (path !== '/data-status' && calls.push({ method: 'get', path, arg: query }), respond(path)),
    post: (path, body) => (calls.push({ method: 'post', path, arg: body }), respond(path)),
  };
  const server = new McpServer({ name: 'test', version: '0' });
  registerTools(server, selectTools(new Set(disabled)), { api, proposalSource: 'hermes' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls };
}

const textOf = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0].text;

const validProposal = {
  title: 'Budget alerts',
  problem: 'Overspending noticed late',
  evidence: 'Food spend above average in recent months',
  proposal: 'Monthly budget per category with warnings',
  acceptanceCriteria: ['Warning at 80%'],
};

// The tools that may write, each acknowledged here on purpose (docs/MCP.md):
// a feature proposal, and a planned categorization change set.
const WRITING_TOOLS = ['propose_feature', 'apply_categorization'];

test('registry: unique names, and only the acknowledged tools may write', () => {
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
  for (const tool of ALL_TOOLS) {
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
    assert.equal(tool.annotations.readOnlyHint, !WRITING_TOOLS.includes(tool.name), tool.name);
  }
  assert.deepEqual(
    ALL_TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort(),
    [...WRITING_TOOLS].sort()
  );
  for (const name of WRITING_TOOLS) {
    assert.equal(ALL_TOOLS.find((t) => t.name === name)?.annotations.idempotentHint, true, name);
  }
});

test('all registered tools are listed with input schemas', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  const search = tools.find((t) => t.name === 'search_transactions');
  assert.ok(search?.inputSchema.properties && 'from' in search.inputSchema.properties);

  // The agent sees every operation kind of the shared union in the schema.
  const plan = tools.find((t) => t.name === 'plan_categorization');
  type Variant = { properties: { kind: { const: string } } };
  const op = plan?.inputSchema.properties?.op as { oneOf?: Variant[]; anyOf?: Variant[] };
  const variants = op.oneOf ?? op.anyOf ?? [];
  assert.deepEqual(variants.map((v) => v.properties.kind.const).sort(), [
    'archive_category',
    'create_category',
    'create_rule',
    'disable_rule',
    'merge_categories',
    'recategorize',
    'rename_category',
    'undo',
  ]);
  assert.deepEqual(plan?.inputSchema.required, ['op']);
});

test('disabled tools are not exposed; unknown names fail loudly', async () => {
  const { client } = await connect({}, ['propose_feature']);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.equal(names.includes('propose_feature'), false);
  assert.throws(() => selectTools(new Set(['propose_feature', 'no_such_tool'])), /no_such_tool/);
});

test('search_transactions forwards validated filters with defaults to the API', async () => {
  const { client, calls } = await connect({ '/transactions/search': { total: 0, items: [] } });
  await client.callTool({ name: 'search_transactions', arguments: { from: '2026-01-01', q: 'market', limit: 10 } });
  assert.deepEqual(calls, [
    {
      method: 'get',
      path: '/transactions/search',
      arg: { from: '2026-01-01', q: 'market', limit: 10, offset: 0, includeTransfers: false },
    },
  ]);
});

test('get_balance_history forwards the range with the default interval and adds freshness', async () => {
  const status = { lastImportAt: '2026-11-02T09:30:00.000Z', dataAsOf: '2026-10-31' };
  const history = { from: '2026-01-01', to: '2026-10-31', interval: 'month', accounts: [], untrackedAssetClasses: [], points: [] };
  const { client, calls } = await connect({ '/data-status': status, '/balances/history': history });
  const res = (await client.callTool({ name: 'get_balance_history', arguments: { from: '2026-01-01' } })) as {
    content: Array<{ text: string }>;
  };
  assert.deepEqual(calls, [{ method: 'get', path: '/balances/history', arg: { from: '2026-01-01', interval: 'month' } }]);
  assert.deepEqual(JSON.parse(res.content[0].text), history);
  assert.equal(JSON.parse(res.content[1].text).meta.dataAsOf, '2026-10-31');

  const bad = await client.callTool({ name: 'get_balance_history', arguments: { interval: 'year' } });
  assert.equal(bad.isError, true);
});

test('invalid input is rejected before the API is called', async () => {
  const { client, calls } = await connect();
  for (const args of [{ from: '2026-02-30' }, { limit: 10_000 }]) {
    const res = await client.callTool({ name: 'search_transactions', arguments: args });
    assert.equal(res.isError, true, JSON.stringify(args));
  }
  const iban = await client.callTool({
    name: 'propose_feature',
    arguments: { ...validProposal, evidence: 'transfers from FI21 1234 5600 0007 85' },
  });
  assert.equal(iban.isError, true);
  assert.equal(calls.length, 0);
});

test('propose_feature posts to the review queue with the configured source', async () => {
  const { client, calls } = await connect({ '/feature-proposals': { duplicate: false, proposal: { id: 'p1' } } });
  const res = await client.callTool({ name: 'propose_feature', arguments: validProposal });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls, [
    { method: 'post', path: '/feature-proposals', arg: { kind: 'feature', ...validProposal, source: 'hermes' } },
  ]);
});

test('an API serving demo data gets no reads and no writes', async () => {
  const { client, calls } = await connect({ '/data-status': { dataset: 'demo' } });
  for (const [name, args] of [['get_summary', {}], ['propose_feature', validProposal]] as const) {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, name);
    assert.match(textOf(res), /demo database/);
  }
  assert.deepEqual(calls, []);
});

test('propose_feature accepts bug reports; list_feature_proposals can filter by done', async () => {
  const { client, calls } = await connect({ '/feature-proposals': [] });
  await client.callTool({ name: 'propose_feature', arguments: { ...validProposal, kind: 'bug' } });
  await client.callTool({ name: 'list_feature_proposals', arguments: { status: 'done' } });
  assert.deepEqual(
    calls.map((c) => [c.method, (c.arg as { kind?: string; status?: string }).kind ?? (c.arg as { status?: string }).status]),
    [
      ['post', 'bug'],
      ['get', 'done'],
    ]
  );
});

test('responses are redacted: iban keys dropped, account numbers in text masked', async () => {
  const { client } = await connect({
    '/accounts': [{ id: 'a1', name: 'Main', iban: 'FI2112345600000785' }],
    '/transactions/search': { total: 1, items: [{ counterpartyName: 'DE89 3704 0044 0532 0130 00', amount: -5 }] },
  });
  const accounts = textOf(await client.callTool({ name: 'list_accounts', arguments: {} }));
  assert.equal(/iban|FI21/i.test(accounts), false);
  assert.ok(accounts.includes('Main'));

  const search = textOf(await client.callTool({ name: 'search_transactions', arguments: {} }));
  assert.equal(search.includes('3704'), false);
  assert.ok(search.includes('[REDACTED]'));
});

test('API failures surface as redacted tool errors', async () => {
  const { client } = await connect({
    '/summary': new ApiError(500, { error: 'boom', detail: 'account FI2112345600000785' }),
  });
  const res = await client.callTool({ name: 'get_summary', arguments: {} });
  assert.equal(res.isError, true);
  assert.ok(textOf(res).includes('Finance API error 500'));
  assert.equal(textOf(res).includes('FI21'), false);
});

test('data tools add a meta freshness block; the data block is unchanged', async () => {
  const status = { lastImportAt: '2026-11-02T09:30:00.000Z', dataAsOf: '2026-10-31' };
  const { client } = await connect({
    '/data-status': status,
    '/summary': { totalBalance: 1 },
    '/forecast': [{ targetMonth: '2026-12' }, { targetMonth: '2027-01' }],
    '/categories': [{ id: 'c1' }],
    '/feature-proposals': [],
  });
  const blocks = async (name: string) =>
    ((await client.callTool({ name, arguments: {} })) as { content: Array<{ text: string }> }).content.map((c) =>
      JSON.parse(c.text)
    );

  const [summary, { meta }] = await blocks('get_summary');
  assert.deepEqual(summary, { totalBalance: 1 });
  assert.equal(meta.lastImportAt, status.lastImportAt);
  assert.equal(meta.dataAsOf, status.dataAsOf);
  assert.ok(/^\d{4}-\d\d-\d\dT.*Z$/.test(meta.generatedAt));

  const forecast = await blocks('get_forecast');
  assert.equal(forecast[1].meta.forecastStartMonth, '2026-12');

  assert.equal((await blocks('list_categories')).length, 1);
  assert.equal((await blocks('list_feature_proposals')).length, 1);
});

test('a failing freshness lookup does not fail the tool', async () => {
  const { client } = await connect({ '/data-status': new ApiError(500, {}), '/summary': { totalBalance: 1 } });
  const res = (await client.callTool({ name: 'get_summary', arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(res.isError, undefined);
  const { meta } = JSON.parse(res.content[1].text);
  assert.equal(meta.lastImportAt, null);
  assert.equal(meta.dataAsOf, null);
});

test('get_latest_briefing: same shape with or without a briefing; other failures stay errors', async () => {
  const call = async (response: unknown) => {
    const { client } = await connect({ '/briefing/latest': response });
    return client.callTool({ name: 'get_latest_briefing', arguments: {} });
  };

  const ok = await call({ id: 'b1', findings: [] });
  assert.deepEqual(JSON.parse(textOf(ok)), { status: 'ok', briefing: { id: 'b1', findings: [] } });

  const none = await call(new ApiError(404, { error: 'not_found' }));
  assert.equal(none.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(none)), { status: 'not_generated', briefing: null });

  const missingRoute = await call(new ApiError(404, { error: 'Not Found', message: 'Route GET:/briefing/latest not found' }));
  assert.equal(missingRoute.isError, true);
  assert.equal((await call(new ApiError(500, { error: 'boom' }))).isError, true);
});

const TOKEN = 'ab'.repeat(32);
const recategorize = { kind: 'recategorize', transactionIds: ['tx-1', 'tx-2'], categoryId: 'cat-fun', reason: 'board games' };

test('plan_categorization posts the validated operation; nothing else is called', async () => {
  const plan = { kind: 'recategorize', rows: [], planToken: TOKEN };
  const { client, calls } = await connect({ '/categorization/plan': plan });
  const res = (await client.callTool({ name: 'plan_categorization', arguments: { op: recategorize } })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls, [{ method: 'post', path: '/categorization/plan', arg: { op: recategorize } }]);
  assert.deepEqual(JSON.parse(res.content[0].text), plan);
  assert.equal(res.content.length, 1, 'no freshness block');
});

test('apply_categorization posts the operation with its plan token', async () => {
  const { client, calls } = await connect({ '/categorization/apply': { id: 'set-1', actor: 'hermes' } });
  const res = await client.callTool({ name: 'apply_categorization', arguments: { op: recategorize, planToken: TOKEN } });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls, [{ method: 'post', path: '/categorization/apply', arg: { op: recategorize, planToken: TOKEN } }]);
});

test('categorization tools reject invalid operations before the API is called', async () => {
  const { client, calls } = await connect();
  const tooMany = Array.from({ length: 501 }, (_, i) => `tx-${i}`);
  for (const [name, args] of [
    ['plan_categorization', { op: { kind: 'delete_everything' } }],
    ['plan_categorization', { op: { kind: 'recategorize', transactionIds: tooMany, categoryId: 'c' } }],
    ['plan_categorization', { op: { kind: 'create_rule', pattern: 'ab', matchField: 'counterparty', categoryId: 'c' } }],
    ['apply_categorization', { op: recategorize, planToken: 'not-a-token' }],
    ['apply_categorization', { op: recategorize }],
    ['get_category_change', {}],
    ['list_category_changes', { limit: 1000 }],
  ] as const) {
    const res = await client.callTool({ name, arguments: args });
    assert.equal(res.isError, true, `${name} ${JSON.stringify(args).slice(0, 80)}`);
  }
  assert.equal(calls.length, 0);
});

test('a stale plan comes back as a tool error with the API code', async () => {
  const { client } = await connect({
    '/categorization/apply': new ApiError(409, { error: 'plan_stale', details: { hint: 'plan again' } }),
  });
  const res = await client.callTool({ name: 'apply_categorization', arguments: { op: recategorize, planToken: TOKEN } });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /Finance API error 409/);
  assert.match(textOf(res), /"error":"plan_stale"/);
});

test('change sets and rules are read with their query defaults', async () => {
  const { client, calls } = await connect({
    '/categorization/change-sets': { total: 0, items: [] },
    '/categorization/change-sets/set%2F1': { id: 'set/1' },
    '/categorization/rules': [],
  });
  await client.callTool({ name: 'list_category_changes', arguments: {} });
  await client.callTool({ name: 'list_category_changes', arguments: { limit: 5, offset: 10 } });
  await client.callTool({ name: 'get_category_change', arguments: { id: 'set/1' } });
  await client.callTool({ name: 'list_category_rules', arguments: {} });
  await client.callTool({ name: 'list_category_rules', arguments: { includeDisabled: true } });
  assert.deepEqual(calls, [
    { method: 'get', path: '/categorization/change-sets', arg: { limit: 20, offset: 0 } },
    { method: 'get', path: '/categorization/change-sets', arg: { limit: 5, offset: 10 } },
    { method: 'get', path: '/categorization/change-sets/set%2F1', arg: undefined },
    { method: 'get', path: '/categorization/rules', arg: { includeDisabled: false } },
    { method: 'get', path: '/categorization/rules', arg: { includeDisabled: true } },
  ]);
});

test('the plan token and ids survive redaction', async () => {
  // Hex that reads like an IBAN (two letters, then many digits) once was masked.
  const token = 'ab1234567890123456' + 'c'.repeat(46);
  const { client } = await connect({ '/categorization/plan': { planToken: token } });
  const res = await client.callTool({ name: 'plan_categorization', arguments: { op: recategorize } });
  assert.equal(JSON.parse(textOf(res)).planToken, token);
});
