#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApiClient } from './apiClient.js';
import { loadConfig, type Config, type HttpConfig } from './config.js';
import { registerTools, selectTools } from './tools/index.js';
import { createMcpHttpServer } from './transports/http.js';

// Entry point. Transports:
//   stdio (default)           — the agent spawns this process locally
//   http (MCP_TRANSPORT=http) — Streamable HTTP(S) for agents on another host
// stdout is the stdio protocol channel, so all logging goes to stderr.

const SERVER_INFO = { name: 'finance-app', version: '0.1.0' };

function startHttp(config: HttpConfig, buildServer: () => McpServer, apiUrl: string) {
  const { host, port, tls, allowedClients } = config;
  const server = createMcpHttpServer(config, buildServer);
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `Port ${port} on ${host} is already in use; set MCP_PORT to a free port`
        : `MCP HTTP server error: ${err.message}`
    );
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.error(`finance-app MCP on ${tls ? 'https' : 'http'}://${host}:${port}/mcp → ${apiUrl}`);
    if (tls) console.error(`TLS certificate SHA-256 fingerprint: ${tls.fingerprint256}`);
    console.error(`Client allow-list: ${allowedClients ? allowedClients.rules.join(', ') : 'none (token only)'}`);
  });
}

async function main(config: Config) {
  const tools = selectTools(config.disabledTools);
  const ctx = { api: createApiClient(config.apiUrl), proposalSource: config.proposalSource };
  const buildServer = () => {
    const server = new McpServer(SERVER_INFO);
    registerTools(server, tools, ctx);
    return server;
  };
  console.error(`Tools: ${tools.map((t) => t.name).join(', ')}`);

  if (config.transport.kind === 'http') {
    startHttp(config.transport, buildServer, config.apiUrl);
  } else {
    await buildServer().connect(new StdioServerTransport());
    console.error(`finance-app MCP (stdio) → ${config.apiUrl}`);
  }
}

try {
  await main(loadConfig(process.env));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
