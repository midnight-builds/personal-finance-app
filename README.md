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

## Quick start

```bash
npm ci                  # install dependencies
cp .env.example .env    # then edit .env and set OPENAI_API_KEY
npm run dev             # start API + Web
```

- Web UI: http://localhost:5173/
- API: http://localhost:3001/

## AI requirement

Requires `OPENAI_API_KEY` (loaded from environment or `.env`). The model defaults to `gpt-4o-mini` and can be overridden with `OPENAI_MODEL`.

Fallback: if AI is unavailable the app still starts as a manual browser/editor — categorization rules and import work, but AI suggestions and forecasting briefings are disabled.

## Notes

### Data / DB
- Default SQLite path: `apps/api/data/finance.db` (configurable via `DB_PATH`).
- Backup/restore: see `docs/BACKUP_RESTORE.md`

### Running on a remote server and using the UI locally
If you run the dev server on a remote machine, use SSH port-forwarding:

```bash
ssh -L 5173:127.0.0.1:5173 -L 3001:127.0.0.1:3001 user@your-server
```

Then open http://localhost:5173/

### Known limitations
- **`xlsx` (SheetJS) advisories.** Excel import depends on `xlsx`, which has open high-severity advisories (prototype pollution, ReDoS) with no fix published on the npm registry. As a single-user, local, no-auth tool the practical exposure is limited to files you import yourself — **only import bank exports you trust.** Migrating to a maintained reader (e.g. `exceljs`) is on the roadmap.

## How it's built

AI-assisted, end to end, with a disciplined loop: plan → test-driven implementation → review → ship. Agent conventions live in [`AGENTS.md`](AGENTS.md), and CI gates every push on lint, tests, and type-checks.

## Repo scripts
- `npm run dev` – start API + Web (concurrently)
- `npm run ci` – build + test + lint

