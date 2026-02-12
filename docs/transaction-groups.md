# Transaction groups & dedupe (design note)

## Goal
We want a stable way to:
- mark multiple normalized transactions as the same real-world transaction (import duplicates)
- have one deterministic "canonical" transaction id per group (for reporting, decisions, UI)

This is intentionally lightweight: SQLite + a couple of tables/columns.

## Current schema
- normalized_transactions.transaction_group_id (nullable)
- transaction_groups:
  - id
  - created_at
  - canonical_transaction_id (nullable)

## Current behavior (import-time dedupe)
During import we try to detect duplicates among newly inserted normalized_transactions.
When a duplicate pair is detected:
1) Pick a groupId:
   - prefer candidate's existing transaction_group_id
   - else current tx's transaction_group_id
   - else create a new id
2) Update both transactions to use the same transaction_group_id.
3) Ensure transaction_groups has a row for that groupId (INSERT OR IGNORE).
4) Pick a deterministic canonical transaction:
   - ORDER BY created_at ASC, id ASC LIMIT 1
   - store it as transaction_groups.canonical_transaction_id

This keeps grouping deterministic even if imports are repeated.

## Why canonical matters
- categorization decisions: store decisions against canonical tx to avoid drift
- UI: show one transaction row and let user expand duplicates
- reporting: ensure sums don’t double-count duplicates

## Known gaps / next steps
- Consider enforcing canonical id as a FK to normalized_transactions(id).
  - SQLite doesn’t enforce cross-table constraints unless explicitly defined; currently it’s best effort.
- Backfill canonical for existing groups where canonical_transaction_id IS NULL (maintenance task).
- Improve dedupe matching:
  - include currency, counterparty IBAN normalization, description normalization
  - allow multiple duplicates per group (currently pairwise, but should converge)
- Add API endpoints:
  - list groups, list members, set canonical explicitly
  - merge/split groups

## Invariants we should keep
- Every transaction_group_id referenced by a tx should have a row in transaction_groups.
- Canonical selection should be deterministic and stable.
- Grouping should be idempotent for repeated imports.
