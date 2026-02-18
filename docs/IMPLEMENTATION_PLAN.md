# Implementation plan (roadmap)

This is a hobby project: ship iteratively, keep CI green, avoid heavy process.

## Milestones

### M0: Foundations
- Repo hygiene + docs/runbook
- One-command dev start
- Minimal CI

### M1: Import + data model
- Import pipeline (raw → normalized)
- Idempotency + grouping + transfer linking
- Balance snapshots + adjustments

### M2: Categorization
- Default categories + UI editing
- Rules + decisions → rules
- Optional AI suggestions (validated)

### M3: Insights v1
- A small set of genuinely useful insights
- Drill-down to the underlying transactions
- Correctness tests for the insight logic

### M4: Reporting + export
- Monthly summary / reporting views
- CSV export

### M5: Hardening
- Backups/restore story
- Secrets/env handling
- Performance and UX polish

## Working principles
- Deterministic first; AI as an assist.
- “Explainable by default” (reports/insights link to data).
- Single-user, no-auth.

