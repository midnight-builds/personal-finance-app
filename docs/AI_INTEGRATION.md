# AI integration

AI is a **core requirement** of finance-app.

## Principles
- Keep a deterministic core (SQLite + queries) and use AI for reasoning, explanations, and suggestions.
- AI output must be **validated** and grounded in data (show evidence / linked transactions).
- Prefer the newest/highest-quality models for Copilot analysis; use smaller/faster models for lightweight tasks when safe.

## Primary use cases

### 1) Categorization suggestions
- Input: minimal fields (counterparty, description, amount, currency) + existing categories.
- Output: validated JSON with one of:
  - existing category id + reason
  - a small set of options + reasons

### 2) Analysis Copilot
Copilot calls explicit tools, e.g.
- query transactions (filters by time/category/counterparty)
- compute aggregates (monthly/category)
- detect spikes/deltas and propose explanations
- propose category rules or cleanup steps (user confirms)

## Fallback behavior
If `OPENAI_API_KEY` is missing or the API fails:
- App still runs and you can browse/edit data.
- AI endpoints return a clear error.
- Copilot features are disabled/read-only.

