# Environments

Real household data and development never share a database. There is no
default database path: every process says which one it opens (`DB_PATH`), and
the API refuses a path that does not exist (a typo must not start the app on an
empty database). Only the demo seed creates databases (`DB_CREATE=1`).

| Environment | Who | Database | Ports |
|---|---|---|---|
| Production | the household, the MCP agent | `~/finance-app-data/finance.db` (real) | API 3001, web 5173, MCP 3030 |
| Development | developers, coding agents | `~/finance-app-data/demo/demo.db` (fictional) | API 3101, web 5174, no MCP |
| Tests | CI, coding agents | in-memory (`DB_PATH=:memory:`) | — |

## Production

The systemd units set `DB_PATH` explicitly (drop-ins
`/etc/systemd/system/finance-app-{api,backup}.service.d/data.conf`). The web
service runs `vite preview`, which proxies `/api` to 3001. The MCP server reads
`FINANCE_API_URL` (default `http://127.0.0.1:3001`).

The database lives outside the repository, so `git clean`, checkouts and
worktrees can never reach it. Backups: `docs/BACKUP_RESTORE.md`.

## Development

```bash
npm run dev                    # demo API on 3101 + dev web on 5174, seeds the demo on first run
npm run demo:reset -w apps/api # recreate the demo, history ending today
```

- `npm run dev` ignores `DB_PATH`; override the demo location with
  `DEMO_DB_PATH`, the ports with `DEV_API_PORT` / `DEV_WEB_PORT`.
- The dev web server proxies to 3101, never to the production API.
- The demo seed marks the database (`app_settings.dataset = demo`).
  `/data-status` reports `dataset: "demo"`, the web shows a DEMO ribbon, and
  the MCP server refuses every tool call against it.
- The seed only creates new files, and `--replace` / `--if-missing` accept an
  existing file only if it is marked as demo.
- What the demo contains: `apps/api/src/demo/demoData.ts`, terms in `GLOSSARY.md`.

## Looking at real data while debugging

Never open the production file. Copy the latest backup to a temporary
directory, open the copy read-only, delete it afterwards. Real data changes go
through the production API only (e.g. the proposal queue).
