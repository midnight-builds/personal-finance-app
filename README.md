# Finance-app

Personal finance tracker (API + Web) built to be run primarily on **your-server**.

## Quick start (one command)

```bash
npm ci
npm run dev
```

- Web UI: http://localhost:5173/
- API: http://localhost:3001/

## Notes

### Data / DB
- Default SQLite path: `apps/api/data/finance.db` (configurable via `DB_PATH`).

### Optional AI features
- AI endpoints/features require `OPENAI_API_KEY`.
- If `OPENAI_API_KEY` is missing, the app should still run; AI calls will be skipped/return a clear error.

### Running on your-server and using the UI locally
If you run the dev server on your-server, use port-forwarding:

```bash
ssh -L 5173:127.0.0.1:5173 -L 3001:127.0.0.1:3001 user@your-server
```

Then open http://localhost:5173/

## Repo scripts

- `npm run dev` – start API + Web (concurrently)
- `npm run ci` – build + test + lint (same intent as CI)

