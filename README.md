# Finance-app

Single-user, no-auth personal finance tracker.

Goal: **easy import → automatic categorization → clear reports**, plus an **Analysis Copilot** that can analyze your data using strong tools (not just chat).

- Product vision: `docs/VISION.md`
- Roadmap: `docs/IMPLEMENTATION_PLAN.md`

## Quick start (one command)

```bash
npm ci
npm run dev
```

- Web UI: http://localhost:5173/
- API: http://localhost:3001/

## What you can do (today)
- Import Nordea CSV/XLSX
- See transactions + transfers (transfers hidden by default)
- Basic monthly/net/runway summary
- Balance snapshots + balance adjustments
- Insights v1 (incremental)

## Notes

### Data / DB
- Default SQLite path: `apps/api/data/finance.db` (configurable via `DB_PATH`).

### Optional AI features
- AI features require `OPENAI_API_KEY`.
- If `OPENAI_API_KEY` is missing, the app still runs; AI calls return a clear error.

### Running on codexsrv and using the UI locally
If you run the dev server on codexsrv, use port-forwarding:

```bash
ssh -L 5173:127.0.0.1:5173 -L 3001:127.0.0.1:3001 codexuser@codexsrv
```

Then open http://localhost:5173/

## Repo scripts
- `npm run dev` – start API + Web (concurrently)
- `npm run ci` – build + test + lint

