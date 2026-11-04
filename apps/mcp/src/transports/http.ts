import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { HttpConfig } from '../config.js';

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

function sendError(res: http.ServerResponse, status: number, code: string, headers: http.OutgoingHttpHeaders = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify({ error: code }));
}

function tokenMatches(header: string | undefined, token: string) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function clientAllowed(allowed: net.BlockList | null, remote: string | undefined) {
  if (!allowed) return true;
  if (!remote) return false;
  // Dual-stack sockets report IPv4 clients as ::ffff:a.b.c.d.
  const address = remote.startsWith('::ffff:') && net.isIPv4(remote.slice(7)) ? remote.slice(7) : remote;
  return allowed.check(address, net.isIPv4(address) ? 'ipv4' : 'ipv6');
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

/**
 * Stateless Streamable HTTP endpoint at POST /mcp.
 * Checks, in order: path, client address (optional allow-list), bearer token, method.
 * Uses HTTPS when the config carries a certificate.
 */
export function createMcpHttpServer(
  config: Pick<HttpConfig, 'token' | 'tls' | 'allowedClients'>,
  buildServer: () => McpServer
) {
  const handler: http.RequestListener = async (req, res) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== MCP_PATH) return sendError(res, 404, 'not_found');
    if (!clientAllowed(config.allowedClients, req.socket.remoteAddress)) return sendError(res, 403, 'forbidden');
    if (!tokenMatches(req.headers.authorization, config.token)) {
      return sendError(res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
    }
    // Stateless server: no server-initiated streams or sessions.
    if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed', { allow: 'POST' });

    try {
      const body = await readJson(req);
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof HttpError) return sendError(res, err.status, err.code);
      console.error('MCP request failed:', err);
      sendError(res, 500, 'internal_error');
    }
  };

  return config.tls
    ? https.createServer({ cert: config.tls.cert, key: config.tls.key, minVersion: 'TLSv1.2' }, handler)
    : http.createServer(handler);
}
