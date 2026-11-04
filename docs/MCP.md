# MCP server (external agents)

`apps/mcp` exposes the finance app to external AI agents (e.g. Hermes) over the
[Model Context Protocol](https://modelcontextprotocol.io). It is a thin client
over the REST API and never opens the database.

## Tools

| Tool | Effect |
|------|--------|
| `search_transactions` | Filtered, paginated transactions (`GET /transactions/search`) |
| `get_summary`, `get_monthly_overview`, `get_insights`, `get_latest_briefing`, `get_forecast` | Read reports |
| `list_categories`, `list_accounts`, `list_recurring` | Read reference data |
| `list_feature_proposals` | Earlier proposals and the user's decision notes |
| `propose_feature` | Adds a proposal to the local review queue |

Everything except `propose_feature` is read-only; no tool changes or deletes data.

Every response is passed through `redactDeep` (`packages/shared`): keys containing
`iban` are dropped and IBANs, old Finnish account numbers and Finnish personal ids
inside text are replaced with `[REDACTED]`. `search_transactions` excludes transfers
and collapses duplicate rows from overlapping imports by default.

> **The read-only guarantee holds only through MCP.** The finance API has no auth,
> and the web UI (port 5173) proxies `/api` to it. If the agent must not be able to
> write, keep the API on loopback (`HOST=127.0.0.1`, the default) **and** block the
> agent's host from the UI port (firewall), or bind the UI to loopback too.

### Adding a tool

1. Define it with `defineTool` in a module under `apps/mcp/src/tools/` (schema,
   annotations, `run`). Reuse request schemas from `@finance-app/shared` so the API
   and the tool validate the same way.
2. Add the module's array to `ALL_TOOLS` in `apps/mcp/src/tools/index.ts`.
3. Extend the tests in `apps/mcp/tests/tools.test.ts` (the registry test asserts
   annotations, so a new writing tool must be acknowledged there explicitly).

## Feature proposals

`propose_feature` → `POST /feature-proposals` → `feature_proposals` table, status `new`.
The user reviews proposals in the **Ehdotukset** tab and accepts or rejects them
(the optional note is visible to the agent via `list_feature_proposals`). An
accepted proposal can be copied as issue Markdown; publishing is always manual.

The schema lives in `packages/shared/src/featureProposals.ts` and is used by both
the API and the MCP tool:
- fields `title`, `problem`, `evidence`, `proposal`, `acceptanceCriteria[]`, length-limited
- text containing an account number or personal id is rejected
- the same title as an open proposal returns the existing one (`duplicate: true`)
- decisions are final: resolving an already resolved proposal returns `409`

## Configuration

All options are environment variables, validated at startup (`apps/mcp/src/config.ts`);
an invalid value stops the server with a message.

| Variable | Default | Meaning |
|----------|---------|---------|
| `FINANCE_API_URL` | `http://127.0.0.1:3001` | Finance API base URL |
| `MCP_TRANSPORT` | `stdio` | `stdio` (agent spawns the process) or `http` |
| `MCP_DISABLED_TOOLS` | — | Comma-separated tool names to hide, e.g. `propose_feature`. Unknown names are an error |
| `MCP_PROPOSAL_SOURCE` | `hermes` | Stored as a proposal's `source` |
| `MCP_HOST` / `MCP_PORT` | `127.0.0.1` / `3030` | http: listen address |
| `MCP_TOKEN_FILE` / `MCP_TOKEN` | — | http: bearer token, ≥ 32 chars. Prefer the file |
| `MCP_TLS_CERT` / `MCP_TLS_KEY` | — | http: HTTPS certificate and key. **Required unless `MCP_HOST` is loopback** |
| `MCP_ALLOWED_IPS` | — | http: client allow-list, addresses and CIDR ranges (`10.0.0.5,192.168.1.0/24`). Empty = token only |

HTTP request checks, in order: path `/mcp` (404), client address (403), token (401),
method `POST` (405), body ≤ 1 MiB (413) and valid JSON (400). The endpoint is
stateless; there are no sessions or server-initiated streams.

## Running

```bash
npm run build            # builds packages/shared first, then the apps
```

### Agent on the same machine (stdio)

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  finance:
    command: node
    args: ["/path/to/finance-app/apps/mcp/dist/index.js"]
    env:
      FINANCE_API_URL: "http://127.0.0.1:3001"
```

### Agent on another host (HTTPS + token)

1. On the finance server, create certificate, key and token. List every host name
   and IP the agent uses to connect; they go into the certificate's SAN:

   ```bash
   apps/mcp/scripts/gen-cert.sh ~/.config/finance-mcp <hostname> <lan-ip>
   ```

   The key and token are written with mode `0600`. Rerunning keeps the token.

2. Put the options in an environment file, e.g. `~/.config/finance-mcp/mcp.env`:

   ```ini
   MCP_TRANSPORT=http
   MCP_HOST=0.0.0.0
   MCP_TOKEN_FILE=/home/<user>/.config/finance-mcp/token
   MCP_TLS_CERT=/home/<user>/.config/finance-mcp/server.crt
   MCP_TLS_KEY=/home/<user>/.config/finance-mcp/server.key
   # MCP_ALLOWED_IPS=<agent-ip>
   ```

3. Run it as a service (adjust user and paths):

   ```ini
   # /etc/systemd/system/finance-app-mcp.service
   [Unit]
   Description=Finance App MCP server
   After=network.target finance-app-api.service

   [Service]
   Type=simple
   User=<user>
   WorkingDirectory=/path/to/finance-app/apps/mcp
   EnvironmentFile=/home/<user>/.config/finance-mcp/mcp.env
   ExecStart=/usr/bin/node dist/index.js
   Restart=on-failure
   RestartSec=5
   NoNewPrivileges=true
   PrivateTmp=true
   ProtectSystem=strict
   ProtectHome=read-only

   [Install]
   WantedBy=multi-user.target
   ```

   On startup the log shows the URL, the certificate's SHA-256 fingerprint, the
   allow-list and the enabled tools (`journalctl -u finance-app-mcp`).

4. Copy **only** `server.crt` and the token to the agent host (never `server.key`)
   and compare the fingerprint with the server log:

   ```bash
   openssl s_client -connect <server>:3030 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256
   ```

5. Trust the certificate on the agent host. Python agents (Hermes) use the
   `certifi` bundle; append the certificate to a copy of it and point
   `SSL_CERT_FILE` at the copy. Replacing the bundle with only this certificate
   would break every other HTTPS call the agent makes.

   ```bash
   cat "$(python3 -m certifi)" finance-mcp.crt > ~/.hermes/ca-bundle.pem
   export SSL_CERT_FILE=~/.hermes/ca-bundle.pem
   ```

6. Agent configuration:

   ```yaml
   mcp_servers:
     finance:
       url: "https://<server>:3030/mcp"
       headers:
         Authorization: "Bearer <token>"
   ```

The certificate is valid for 825 days. Before it expires, rerun `gen-cert.sh`
(the token is kept), restart the service and recopy `server.crt`.

Check the Hermes documentation for the exact `mcp_servers` keys of your version.
