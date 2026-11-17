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

## TransferLink
Links two transactions that are the two sides of an account-to-account transfer.

## Account
Bank/checking/savings/credit. (No multi-user ownership model for now.)

## Category / CategorizationDecision
Decision history for category assignments.

## CategoryRule
Learned rule: pattern → category.

## BalanceSnapshot / BalanceAdjustment
- Snapshot: imported daily balance.
- Adjustment: user correction that affects reporting balances forward from a date.

