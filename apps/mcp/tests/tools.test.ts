import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ApiError, type ApiClient } from '../src/apiClient.js';
import { ALL_TOOLS, TOOL_NAMES, registerTools, selectTools } from '../src/tools/index.js';

type Call = { method: 'get' | 'post'; path: string; arg?: unknown };

/** Connects a real MCP client to a server backed by a fake API that records calls. */
async function connect(responses: Record<string, unknown> = {}, disabled: string[] = []) {
  const calls: Call[] = [];
  const respond = async (path: string) => {
    const r = responses[path];
    if (r instanceof Error) throw r;
    return r ?? {};
  };
  const api: ApiClient = {
    get: (path, query) => (calls.push({ method: 'get', path, arg: query }), respond(path)),
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
