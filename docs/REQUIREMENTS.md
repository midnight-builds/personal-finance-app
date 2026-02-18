# Requirements

This project is **single-user** and runs without authentication.

## Core promise
Easy import → automatic categorization → clear reports, powered by an **AI Analysis Copilot**.

## Functional

### Import
- Support CSV and XLSX imports (start with Nordea).
- Store raw rows for auditability.
- Normalize into a canonical transaction schema.
- Detect overlapping imports and dedupe/group without deleting data.

### Categorization (AI-required)
- Default categories (seed list) exist.
- User can change a transaction category.
- AI can suggest categories + reasons using existing categories.
- Rule engine stores user decisions as rules so future categorization improves.

**Fallback behavior:** If AI is unavailable (missing key / API down), the app still runs but categorization becomes mostly manual + rules.

### Transfers / duplicates
- Detect account-to-account transfers.
- Transfers do not affect net/insights by default; user can show them.
- Duplicate imports are grouped (TransactionGroup) and presented clearly.

### Reporting
- Dashboard: balances, net (30d), runway, monthly overview.
- Insights: recurring/spikes/uncategorized + recommendations.

### Copilot (AI-required)
- Copilot can answer questions about your finances using explicit tools (queries/aggregations).
- Copilot outputs must be explainable: evidence + links back to transactions.

**Fallback behavior:** Without AI, Copilot UI becomes read-only/help text (no analysis runs).

## Non-functional
- Desktop web UI is sufficient.
- Local-first: everything local except OpenAI calls.
- Scales to years of transactions (SQLite ok).

## Privacy
- If AI is used, send only minimum required fields.
- Never send raw full exports by default.

