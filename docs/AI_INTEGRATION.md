# AI integration

AI is optional. The app must remain useful without it.

## Primary use (now)
- Category suggestion when rules/heuristics are unsure.

Contract:
- Input: minimal fields (counterparty, description, amount, currency) + existing categories.
- Output: validated JSON with mode + existing category ids only (or options).

## Copilot (later)
- The Copilot calls deterministic tools (queries/aggregations) and uses AI for:
  - summarization
  - prioritization
  - rule proposals

Copilot must always link answers back to data (transaction ids / drill-down).

