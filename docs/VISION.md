# Vision

Finance-app is a **single-user, no-auth** personal finance tracker that you run locally (or on your home server).

Core idea: **easy import → automatic categorization → clear reports**, plus an **Analysis Copilot** that can answer questions and propose actions using strong, well-scoped tools over your data.

## Product goals (what “done” looks like)

### 1) Easy import
- User can import a CSV/XLSX export with one click.
- Import is **idempotent**: importing the same file again doesn’t corrupt results.
- App shows a clear import result (rows imported/skipped, overlap detected).

### 2) Automatic categorization
- Deterministic baseline first: default categories + rules/heuristics.
- AI is an optional helper: suggests categories + reasons, but user stays in control.
- User edits are remembered and turned into rules (so the same thing isn’t asked again).

### 3) Clear reports
- Simple dashboard: balances, net flow, runway, monthly overview.
- Reports exclude transfers by default (but can be shown).
- Insights highlight “what changed” and “why”, and link to the underlying transactions.

### 4) Analysis Copilot (agent)
The Copilot is not a chatbot wrapper. It is a **data analysis assistant** with explicit tools:
- Query transactions/aggregates
- Explain deltas/spikes with drill-down
- Suggest rules and cleanup steps (requires user confirmation)
- Run “what-if” simulations (budgeting/runway)

The Copilot should always be:
- Safe by default (no silent destructive changes)
- Grounded in data (show evidence / linked transactions)
- Deterministic where possible; AI only where it adds value

## Non-goals (for now)
- Multi-user / auth
- Mobile-first UI
- Multi-currency
- Bank sync via APIs (import files first)

