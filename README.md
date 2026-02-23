# Finance-app

Single-user, no-auth personal finance tracker.

Goal: **easy import → automatic categorization → clear reports**, powered by an **AI Analysis Copilot**.

- Product vision: `docs/VISION.md`
- Roadmap: `docs/IMPLEMENTATION_PLAN.md`

## Quick start (one command)

```bash
npm ci
cp .env.example .env
# edit .env and set OPENAI_API_KEY
npm run dev
```

- Web UI: http://localhost:5173/
- API: http://localhost:3001/

## AI requirement
This project assumes AI is available (via `OPENAI_API_KEY`, loaded from the environment or a local `.env`).

Fallback behavior: if AI is unavailable, the app still starts and acts as a mostly static browser/manual editor, but Copilot and AI suggestions are disabled.

## Notes

### Data / DB
- Default SQLite path: `apps/api/data/finance.db` (configurable via `DB_PATH`).

### Running on your-server and using the UI locally
If you run the dev server on your-server, use port-forwarding:

```bash
ssh -L 5173:127.0.0.1:5173 -L 3001:127.0.0.1:3001 user@your-server
```

Then open http://localhost:5173/

## Repo scripts
- `npm run dev` – start API + Web (concurrently)
- `npm run ci` – build + test + lint

