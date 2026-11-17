# MCP server (external agents)

`apps/mcp` exposes the finance app to external AI agents (e.g. Hermes) over the
[Model Context Protocol](https://modelcontextprotocol.io). It is a thin client
over the REST API and never opens the database.

## Tools

| Tool | Effect |
|------|--------|
| `search_transactions` | Filtered, paginated transactions (`GET /transactions/search`) |
| `get_summary`, `get_monthly_overview`, `get_insights`, `get_latest_briefing`, `get_forecast` | Read reports |
| `get_balance_history` | Balances and net worth per day/week/month with coverage (`GET /balances/history`) |
| `list_categories`, `list_accounts`, `list_recurring` | Read reference data (`list_categories` includes each category's `role`) |
| `list_category_rules` | Categorization rules in match order (`GET /categorization/rules`) |
| `plan_categorization` | Works out a categorization change without writing (`POST /categorization/plan`) |
| `apply_categorization` | Applies a planned change with its plan token (`POST /categorization/apply`) |
| `list_category_changes`, `get_category_change` | Change log of categorization: who changed what, and undo state (`GET /categorization/change-sets[/:id]`) |
| `list_feature_proposals` | Earlier proposals and bug reports with their status, notes, resolution and history; `changedSince` (largest `changedAt` seen) returns only what changed, so polling is cheap |
| `propose_feature` | Adds a feature proposal or bug report (`kind`) to the local review queue |

Two tools write: `propose_feature` adds to the review queue, and
`apply_categorization` changes categorization. Every other tool is read-only, and
no tool deletes anything.

### Category management

The agent manages categories as the user does in the web UI, without asking the
user to confirm (decided with the user; `docs/CATEGORIES.md`). Every change is
planned first (`plan_categorization`, writes nothing), then applied with the
plan's token (`apply_categorization`). Applying refuses with `409 plan_stale` when
the data has changed since the plan, and the same token applied twice returns the
same change set. Undo is the `undo` operation through the same two tools; there is
no separate undo tool, so an undo is also planned and reviewable first.

- **Attribution.** The MCP server sends `X-Finance-Actor` (`MCP_ACTOR`) on every
  request, so each change set and decision records the agent as its actor next to
  the user's own (`user`). `list_category_changes` shows both.
- **Money is out of reach.** The operations change only categories, rules and
  categorization decisions: never amounts, dates, accounts, counterparties,
  balances, transfers or imports. Nothing is deleted (categories are archived,
  rules disabled), and a rule never overrides a manual decision.
- API errors come back as tool errors `Finance API error <status>: {"error": <code>, "details": ...}`,
  with the codes listed in `docs/CATEGORIES.md` (REST).
- To keep an agent read-only for categories, hide `apply_categorization` with
  `MCP_DISABLED_TOOLS`.

### Responses

Tools backed by imported bank data (all except `list_categories`, the category
management tools and the proposal tools) return a second content block `{ "meta": { generatedAt, lastImportAt, dataAsOf } }`
from `GET /data-status`; `get_forecast` adds `forecastStartMonth`. The first block
is the API response unchanged. If the status lookup fails, the timestamps are `null`
and the tool still succeeds. Category management tools return the API response
alone: they show categorization state, not imported bank data, and a plan is
checked against current state by its token anyway.

Every response is passed through `redactDeep` (`packages/shared`): keys containing
`iban` are dropped and IBANs, old Finnish account numbers and Finnish personal ids
inside text are replaced with `[REDACTED]`. A string that is wholly a UUID or a
64-character hex digest (ids, plan tokens) is left alone, so the agent can send it
back. `search_transactions` excludes transfers by default. Each transaction is
stored once, also when overlapping exports are imported, so counts are real
transactions.

> **Limits on what the agent can write hold only through MCP.** The finance API has
> no auth, and the web UI (port 5173) proxies `/api` to it. If the agent must not be
> able to write more than its tools allow, keep the API on loopback
> (`HOST=127.0.0.1`, the default) **and** block the agent's host from the UI port
> (firewall), or bind the UI to loopback too.

### Adding a tool

1. Define it with `defineTool` in a module under `apps/mcp/src/tools/` (schema,
   annotations, `run`). Reuse request schemas from `@finance-app/shared` so the API
   and the tool validate the same way.
2. Add the module's array to `ALL_TOOLS` in `apps/mcp/src/tools/index.ts`.
3. Extend the tests in `apps/mcp/tests/tools.test.ts` (the registry test asserts
   annotations, so a new writing tool must be acknowledged there explicitly).

## Feature proposals and bug reports

`propose_feature` → `POST /feature-proposals` → `feature_proposals` table, status `new`.
`kind` is `feature` (default) or `bug`. The user reviews them in the **Ehdotukset**
tab. An accepted proposal can be copied as issue Markdown; publishing is always manual.

Lifecycle (`POST /feature-proposals/:id/<action>`, body `{ note?, resolution? }`):

| Action | To | From |
|--------|----|------|
| `accept` | `accepted` — approved, not built yet | `new` |
| `done` | `done` — implemented; `resolution` (commit/PR) required | `new`, `accepted` |
| `reject` | `rejected` — will not be done | `new`, `accepted` |

`done` and `rejected` are final; any other transition returns `409 invalid_transition`.
Every change is appended to `feature_proposal_events` and returned as `history`
(`at`, `status`, `note`, `resolution`). This is the agent's feedback channel:
`list_feature_proposals` tells it what was fixed, where, and why something was declined.

To follow the queue without re-reading it, the agent keeps the largest `changedAt`
it has seen and calls `list_feature_proposals` with `changedSince` set to it. Only
proposals created, edited or decided after that time come back; an empty list
means nothing changed. There is no push notification (webhook or MCP resource
subscription): a push would only reach a client that keeps a stream open, and the
cheap poll covers the need.

The schema lives in `packages/shared/src/featureProposals.ts` and is used by both
the API and the MCP tool:
- fields `kind`, `title`, `problem`, `evidence`, `proposal`, `acceptanceCriteria[]`, length-limited
- text containing an account number or personal id is rejected
- the same title as an open (`new` or `accepted`) proposal returns the existing one (`duplicate: true`)

## Configuration

All options are environment variables, validated at startup (`apps/mcp/src/config.ts`);
an invalid value stops the server with a message.

| Variable | Default | Meaning |
|----------|---------|---------|
| `FINANCE_API_URL` | `http://127.0.0.1:3001` | Finance API base URL |
| `MCP_TRANSPORT` | `stdio` | `stdio` (agent spawns the process) or `http` |
| `MCP_DISABLED_TOOLS` | — | Comma-separated tool names to hide, e.g. `propose_feature`. Unknown names are an error |
| `MCP_PROPOSAL_SOURCE` | `hermes` | Stored as a proposal's `source` |
| `MCP_ACTOR` | `MCP_PROPOSAL_SOURCE` | Sent as `X-Finance-Actor`; recorded as the actor of every change. `a-z`, `0-9`, `_`, `-`, 1–40 characters (startup fails otherwise, also when the default from `MCP_PROPOSAL_SOURCE` does not fit) |
| `MCP_HOST` / `MCP_PORT` | `127.0.0.1` / `3030` | http: listen address |
| `MCP_TOKEN_FILE` / `MCP_TOKEN` | — | http: bearer token, ≥ 32 chars. Prefer the file |
| `MCP_TLS_CERT` / `MCP_TLS_KEY` | — | http: HTTPS certificate and key. **Required unless `MCP_HOST` is loopback** |
| `MCP_ALLOWED_IPS` | — | http: client allow-list, addresses and CIDR ranges (`10.0.0.5,192.168.1.0/24`). Empty = token only |

HTTP request checks, in order: path `/mcp` (404), client address (403), token (401),
method `POST` (405), body ≤ 1 MiB (413) and valid JSON (400). The endpoint is
stateless; there are no sessions or server-initiated streams.

Allow-list and token rejections are logged with the client address (never the
token). If the agent gets `403` behind a router, the log shows the address the
server actually sees, e.g. the router's when it NATs between subnets.

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
   allow-list, the enabled tools and the actor (`journalctl -u finance-app-mcp`).

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
