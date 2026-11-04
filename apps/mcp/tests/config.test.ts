import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig, parseAllowedClients } from '../src/config.js';

const TOKEN = 'a'.repeat(64);
const files: Record<string, Buffer> = { '/token': Buffer.from(`${TOKEN}\n`) };
const readFile = (p: string) => {
  if (!(p in files)) throw new Error(`ENOENT ${p}`);
  return files[p];
};
const load = (env: Record<string, string>) => loadConfig(env, readFile);
const http = (env: Record<string, string>) => {
  const { transport } = load({ MCP_TRANSPORT: 'http', ...env });
  assert.equal(transport.kind, 'http');
  return transport as Extract<typeof transport, { kind: 'http' }>;
};

test('defaults: stdio, local API, hermes source, no disabled tools', () => {
  const cfg = load({});
  assert.deepEqual(cfg.transport, { kind: 'stdio' });
  assert.equal(cfg.apiUrl, 'http://127.0.0.1:3001');
  assert.equal(cfg.proposalSource, 'hermes');
  assert.equal(cfg.disabledTools.size, 0);
});

test('lists are comma separated and trimmed', () => {
  assert.deepEqual([...load({ MCP_DISABLED_TOOLS: ' propose_feature , get_forecast,' }).disabledTools], [
    'propose_feature',
    'get_forecast',
  ]);
});

test('invalid values are reported as ConfigError', () => {
  for (const env of [
    { FINANCE_API_URL: 'ftp://x' },
    { MCP_TRANSPORT: 'websocket' },
    { MCP_PROPOSAL_SOURCE: 'x'.repeat(41) },
    { MCP_TRANSPORT: 'http', MCP_TOKEN: TOKEN, MCP_PORT: '70000' },
  ]) {
    assert.throws(() => load(env), ConfigError, JSON.stringify(env));
  }
});

test('http: token is required, long enough, and read from a file when given', () => {
  assert.throws(() => http({}), /at least 32/);
  assert.throws(() => http({ MCP_TOKEN: 'short' }), /at least 32/);
  const cfg = http({ MCP_TOKEN_FILE: '/token' });
  assert.equal(cfg.token, TOKEN);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 3030);
  assert.equal(cfg.tls, null);
  assert.equal(cfg.allowedClients, null);
});

test('http: plain HTTP is refused off loopback; cert and key go together', () => {
  assert.throws(() => http({ MCP_TOKEN: TOKEN, MCP_HOST: '0.0.0.0' }), /Refusing plain HTTP/);
  assert.throws(() => http({ MCP_TOKEN: TOKEN, MCP_TLS_CERT: '/c' }), /both/);
});

test('allow-list accepts addresses and CIDR ranges for IPv4 and IPv6', () => {
  const list = parseAllowedClients('10.0.0.5, 192.168.1.0/24, fd00::/8')!;
  assert.equal(list.check('10.0.0.5', 'ipv4'), true);
  assert.equal(list.check('10.0.0.6', 'ipv4'), false);
  assert.equal(list.check('192.168.1.200', 'ipv4'), true);
  assert.equal(list.check('fd12::1', 'ipv6'), true);
  assert.equal(parseAllowedClients(''), null);
  for (const bad of ['hermes-agent', '10.0.0.0/33', '10.0.0.1/x']) {
    assert.throws(() => parseAllowedClients(bad), ConfigError, bad);
  }
});
