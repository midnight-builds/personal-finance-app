# Finance-app

Single-user, no-auth personal finance tracker.

> **Status:** personal project, alpha. Built for my own use and shared as-is — no support or stability guarantees.

Goal: **easy import → automatic categorization → clear reports**.

- Product vision: `docs/VISION.md`
- Roadmap: `docs/IMPLEMENTATION_PLAN.md`
- Known gaps / open questions: `docs/OPEN_QUESTIONS.md`

## What's built

- **Import pipeline** — CSV/bank file import with idempotency, grouping, and transfer linking
- **Categorization** — default categories, manual rules, and AI-suggested rules you can approve or reject
- **Pattern detection** — detects annual recurring expenses and flags large one-off transactions for confirmation
- **Forecasting** — 3-month spending forecast engine with a briefing generator and UI panel
- **MCP server** — read-only tools for external agents (e.g. Hermes) plus a feature-proposal queue you review in the UI; see `docs/MCP.md`

## Quick start

```bash
npm ci                  # install dependencies
cp .env.example .env    # then edit .env and set OPENAI_API_KEY
npm run dev             # start API + Web on the demo database (seeded on first run)
```

- Web UI: http://localhost:5174/ (shows a DEMO ribbon)
- API: http://localhost:3101/

Development always runs on fictional demo data; the real database is for the production
services only. See [`docs/ENVIRONMENTS.md`](docs/ENVIRONMENTS.md).

## AI requirement

Requires `OPENAI_API_KEY` (loaded from environment or `.env`). The model defaults to `gpt-4o-mini` and can be overridden with `OPENAI_MODEL`.

Fallback: if AI is unavailable the app still starts as a manual browser/editor — categorization rules and import work, but AI suggestions and forecasting briefings are disabled.

## Notes

### Data / DB
- No default SQLite path: every process sets `DB_PATH`. Production uses
  `~/finance-app-data/finance.db`, development `~/finance-app-data/demo/demo.db`
  (see `docs/ENVIRONMENTS.md`).
- Backup/restore: see `docs/BACKUP_RESTORE.md`
- Demo data: a fictional household (two overlapping exports, transfers, recurring bills),
  `apps/api/src/demo/demoData.ts`. `npm run demo:reset -w apps/api` recreates it with history
  ending today.
- Domain terms (Ledger, duplicate group, transfer, balance): see `GLOSSARY.md`.

### Running on a remote server and using the UI locally
If you run the dev server on a remote machine, use SSH port-forwarding:

```bash
ssh -L 5174:127.0.0.1:5174 user@your-server
```

Then open http://localhost:5174/

### Known limitations
- **`xlsx` (SheetJS) advisories.** Excel import depends on `xlsx`, which has open high-severity advisories (prototype pollution, ReDoS) with no fix published on the npm registry. As a single-user, local, no-auth tool the practical exposure is limited to files you import yourself — **only import bank exports you trust.** Migrating to a maintained reader (e.g. `exceljs`) is on the roadmap.

## How it's built

AI-assisted, end to end, with a disciplined loop: plan → test-driven implementation → review → ship. Agent conventions live in [`AGENTS.md`](AGENTS.md), and CI gates every push on lint, tests, and type-checks.

## Repo scripts
- `npm run dev` – start API + Web (concurrently)
- `npm run ci` – build + test + lint

### Tests and the database

API tests always use an in-memory SQLite database. Every test file must start with
`import './setup/testDb.js';` (enforced by `tests/test-isolation.test.ts`), and
`db.ts` refuses to open a database file from any test process as a backstop.

