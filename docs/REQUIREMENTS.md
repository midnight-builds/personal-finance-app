# Requirements

This project is **single-user** and runs without authentication.

## Functional

### Import
- Support CSV and XLSX imports (start with Nordea).
- Store raw rows for auditability.
- Normalize into a canonical transaction schema.
- Detect overlapping imports and dedupe/group without deleting data.

### Categorization
- Default categories (seed list).
- User can change a transaction category.
- Rule engine: counterparty/description/amount match → category.
- Optional AI category suggestion using existing categories (validated output).

### Transfers / duplicates
- Detect account-to-account transfers.
- Transfers do not affect net/insights by default; user can show them.
- Duplicate imports are grouped (TransactionGroup) and presented clearly.

### Reporting
- Dashboard: balances, net (30d), runway, monthly overview.
- Insights: recurring/spikes/uncategorized + recommendations.

### Copilot
- Provide analysis workflows (tools) that the Copilot can call.
- Copilot output must be explainable: evidence + links back to transactions.

## Non-functional
- Desktop web UI is sufficient.
- Local-first: everything local except optional OpenAI calls.
- Scales to years of transactions (SQLite ok).

## Privacy
- If AI is used, send only the minimum required fields.
- Never send raw full exports by default.

