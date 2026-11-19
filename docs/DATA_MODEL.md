# Data model

Single-user, no-auth. Data is stored locally in SQLite.

## ImportSession
Represents one import action.

## RawTransaction
Original row preserved as JSON for auditability.

## NormalizedTransaction
Canonical transaction record:
- booking_date
- amount (+/-)
- counterparty
- description
- account
- link to RawTransaction

Stored once: a re-imported row that matches an existing transaction (same
account, booking date, amount, counterparty) is not stored (see `GLOSSARY.md`,
"Duplicate"). There are no duplicate groups.

A pending row (no booking_date) stays the same row when it is booked: the
booking promotes it in place. Its lifecycle (`pending` / `booked` / `void`,
when it was first and last listed, the pending raw row) is kept beside it in
`pending_transactions`, so this table keeps its shape (see `GLOSSARY.md`,
"Pending row").

## TransferLink
Links two transactions that are the two sides of an account-to-account transfer.
A transfer to a manual account has one side only and is not a link: the Ledger
derives it from the manual account's IBAN (GLOSSARY.md, "Transfer to a manual
account"; `docs/adr/0002-transfers-to-manual-accounts.md`).

## Account
Type (`account_subtype`: checking, savings, credit_card, loan, investment,
property, other_asset, other_liability), `tracking` (`imported` | `manual`),
`ownership_share` (0–100, net worth only), `currency`, optional
`update_interval_days`, `iban` (an imported account's own; a manual account's
recognises transfers to it, never shown to agents), `archived_at` (manual
accounts only). Changed through account change sets (`change_sets.domain =
'accounts'`). No multi-user ownership model.

## Category / CategorizationDecision
Decision history for category assignments.

## CategoryRule
Learned rule: pattern → category.

## BalanceSnapshot / BalanceAdjustment
- Snapshot: imported daily balance.
- Adjustment: user correction that affects reporting balances forward from a date.

