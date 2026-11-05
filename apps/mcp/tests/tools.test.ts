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

test('registry: unique names, and only propose_feature may write', () => {
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length);
  for (const tool of ALL_TOOLS) {
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
    if (tool.name !== 'propose_feature') assert.equal(tool.annotations.readOnlyHint, true, tool.name);
  }
});

test('all registered tools are listed with input schemas', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  const search = tools.find((t) => t.name === 'search_transactions');
  assert.ok(search?.inputSchema.properties && 'from' in search.inputSchema.properties);
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
      arg: { from: '2026-01-01', q: 'market', limit: 10, offset: 0, includeTransfers: false, includeDuplicates: false },
    },
  ]);
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
