import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, parseAllowedClients, type HttpConfig } from '../src/config.js';
import { createMcpHttpServer } from '../src/transports/http.js';

// End-to-end over real HTTPS with a certificate from scripts/gen-cert.sh.

const GEN_CERT = fileURLToPath(new URL('../scripts/gen-cert.sh', import.meta.url));

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version']);
    return true;
  } catch {
    return false;
  }
})();

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

let dir = '';
let config: HttpConfig;
const servers: net.Server[] = [];

before(() => {
  if (!hasOpenssl) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tls-test-'));
  execFileSync('bash', [GEN_CERT, dir, 'localhost', '127.0.0.1'], { stdio: 'ignore' });
  const { transport } = loadConfig({
    MCP_TRANSPORT: 'http',
    MCP_HOST: '0.0.0.0',
    MCP_TOKEN_FILE: path.join(dir, 'token'),
    MCP_TLS_CERT: path.join(dir, 'server.crt'),
    MCP_TLS_KEY: path.join(dir, 'server.key'),
  });
  assert.equal(transport.kind, 'http');
  config = transport as HttpConfig;
  assert.match(config.tls!.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

after(() => {
  for (const s of servers) s.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const rejections: string[] = [];

async function listen(overrides: Partial<HttpConfig> = {}) {
  const server = createMcpHttpServer(
    { ...config, ...overrides },
    () => new McpServer({ name: 't', version: '0' }),
    (message) => rejections.push(message)
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

type Request = { port: number; token?: string; trust?: boolean; path?: string; method?: string; body?: string };

function request({ port, token = config.token, trust = true, path: p = '/mcp', method = 'POST', body = INITIALIZE }: Request) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method,
        ca: trust ? config.tls!.cert : undefined,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('client trusting the self-signed certificate can initialize', { skip: !hasOpenssl }, async () => {
  const res = await request({ port: await listen() });
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('"serverInfo"'));
});

test('client without the certificate refuses the connection', { skip: !hasOpenssl }, async () => {
  const port = await listen();
  await assert.rejects(() => request({ port, trust: false }), /self[- ]signed|unable to verify/i);
});

test('rejections: wrong token 401, wrong path 404, GET 405, bad JSON 400, huge body 413', { skip: !hasOpenssl }, async () => {
  const port = await listen();
  assert.equal((await request({ port, token: 'b'.repeat(64) })).status, 401);
  assert.equal((await request({ port, path: '/other' })).status, 404);
  assert.equal((await request({ port, method: 'GET', body: '' })).status, 405);
  assert.equal((await request({ port, body: '{nope' })).status, 400);
  assert.equal((await request({ port, body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
});

test('allow-list: listed client passes, others get 403 even with a valid token', { skip: !hasOpenssl }, async () => {
  assert.equal((await request({ port: await listen({ allowedClients: parseAllowedClients('127.0.0.1') }) })).status, 200);
  assert.equal((await request({ port: await listen({ allowedClients: parseAllowedClients('10.9.9.9') }) })).status, 403);
});

test('rejections are logged with the client address and never the token', { skip: !hasOpenssl }, async () => {
  rejections.length = 0;
  await request({ port: await listen({ allowedClients: parseAllowedClients('10.9.9.9') }) });
  await request({ port: await listen(), token: 'c'.repeat(64) });
  assert.deepEqual(rejections, [
    'Rejected 127.0.0.1: not in MCP_ALLOWED_IPS',
    'Rejected 127.0.0.1: missing or invalid bearer token',
  ]);
  assert.ok(rejections.every((m) => !m.includes(config.token) && !m.includes('c'.repeat(64))));
});
