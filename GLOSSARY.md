# Glossary

Domain terms as the code and conversations use them. One meaning per word.

**Ledger** — the module (`apps/api/src/ledger.ts`) that decides which
transactions count and what an account's balance is. Reports, insights,
forecasts and AI tools ask the Ledger instead of querying
`normalized_transactions` themselves.

**Countable transaction** — a transaction the Ledger includes by default:
booked (not pending) and not a transfer between own accounts.

**Duplicate** — a row of an import that the account already has: same
booking date, amount and counterparty (a missing counterparty matches a
missing one) as a stored row from an *earlier* import. A transaction is
stored once, so a duplicate is not stored at all (neither raw nor
normalized); the import counts it as `duplicateCount`. Paired one-to-one: a
file with three identical rows where two are stored brings one new row, and
two identical purchases in one file are two purchases, never duplicates.
(Databases from before this rule held the copies in duplicate groups; the
API collapses them into the earliest imported row once at start,
`apps/api/src/migrations/collapseDuplicates.ts`.)

**Transfer** — money moving between two own accounts, linked as a pair. Left
out of spending and income by default.

**Card repayment** — the one transfer a credit card (an account without an
IBAN) takes part in: a payment from checking into the card. Extra repayments
carry the issuer's IBAN; the monthly bill, paid as an e-invoice, often does
not. A payee that an IBAN-carrying repayment went to is the card's issuer, so
payments to it without an IBAN count as repayments too and beat other
payments of the same amount.

**Category (of a transaction)** — the category of its most recent
categorization decision, whether a rule, AI or the user made it. Decisions are
history: a new one is appended and earlier ones are kept (never replaced), so
anything that counts transactions must read only the latest decision.
Re-stating the latest decision (same category, same source) appends nothing.

**Actor** — who made a change: the user (web UI) or a named agent such as
Hermes (MCP). Named by the client, not authenticated. Changes from before
actors existed belong to `system`.
_Avoid_: user (for agents), author

**Source (of a decision)** — how a decision was reached: manual, rule or AI.
Independent of the actor: a rule's decision during Hermes's import has actor
Hermes and source rule.

**Manual decision** — a decision an actor made by choosing the category
directly. No rule overrides it; only a newer decision does.

**Category role** — the special job a category does whatever it is named:
`fallback` (where uncategorized and archived categories' transactions go),
`income`, `refund`. A category with a role cannot be archived.
_Avoid_: built-in name, "Muut" as an identifier

**Archived category** — a category taken out of use: hidden from pickers, its
transactions moved to another category by new decisions, its rules disabled.
Its past decisions stay as they were. Categories are never deleted.
_Avoid_: deleted category

**Disabled rule** — a rule that no longer matches; kept for history.

**Change set** — one applied change to categorization (recategorizing rows,
creating, renaming, archiving or merging a category, creating or disabling a
rule), recorded with its actor and reason, and undoable as a whole.

**Plan** — a change set worked out without writing anything: what would move
where, and what is left out as an exception. Applying needs the plan's token,
which goes stale when the data the plan rests on changes.
_Avoid_: preview (for categorization), proposal

**Undo** — reverting a change set with new decisions; rows changed again since
the set are left alone and reported.

**Import preview** — what importing a file would do, computed before anything
is written: the guessed target account, and for the chosen target the rows
that are duplicates (would be skipped), transfers, gaps and balance breaks. Its
counts come from a dry run.

**Dry run** — the real import pipeline run inside a transaction that is
always rolled back, so its counts equal what the import then does and nothing
(not even the event log) is kept.

**Target account** — the account an import goes into: chosen by the user, or
inferred from the export's own IBAN. An export without one (a credit card)
needs the user's choice.

**Balance break** — a day where the previous day's running balance (Saldo)
plus the day's amounts does not give the day's last Saldo: rows are missing
from the export in between.

**Balance (of an account, on a day)** — the latest balance snapshot on or
before that day, plus balance adjustments dated on or before the snapshot.
Unknown (null), not zero, when there is no snapshot yet.

**Known balance period** — from an account's first balance snapshot to the
last day its imported data covers (latest snapshot or booking). Outside it the
account's balance is unknown, and so is a day with bookings after the snapshot
the balance rests on (rows with a blank Saldo): a balance series never carries
a stale balance or one past or before the data.

**Net worth (on a day)** — known balances of bank accounts minus credit card
debt, over the accounts whose balance is known that day (`balanceHistory.ts`).
Complete only when every account is known; investments are not tracked and
never included. Transfers between own accounts leave it unchanged.

**Balance adjustment** — a manual correction to an account's balance, e.g. a
cash withdrawal missing from the export.

**Recurring pattern** — a counterparty an account pays again and again,
detected from its countable expenses in the last 180 days (`patterns.ts`).
Monthly or weekly patterns need at least three charges with a steady interval
and amount; two charges are one interval and prove nothing. The forecast
counts every active monthly/weekly pattern as a fixed cost. Stored as
`recurring_patterns`; `pattern_type` is `recurring`, `subscription` or
`annual`.

**Subscription** — a recurring pattern told apart by its charges, not by who
the merchant is: the same amount every time, booked on about the same day
each month (3 days early to 5 days late), with no other charge to the
counterparty in between. A counterparty paid only to an IBAN (a person, an
e-invoice biller) is never one. Fixed monthly savings paid by card look the
same and are counted as subscriptions too.

**Recurring (pattern type)** — a monthly or weekly pattern that is not a
subscription: varying amount or day, or paid to an IBAN.

**Annual pattern** — a charge about once a year (330–400 days apart), or one
the user confirmed as annual.

**Confirmation candidate** — a single large expense (≥ 80 €) with no pattern,
offered to the user to confirm as annual (`pattern_confirmations`).

**Pattern rules version** — `PATTERN_RULES_VERSION` in `patterns.ts`. Bumping it
re-detects every account's patterns on the next API start, so stored patterns
follow changed rules without waiting for an import.

**Day** — a calendar day `YYYY-MM-DD`. "Today" is today in Helsinki
(Europe/Helsinki), never the server's UTC date.

**Demo data** — the fictional household in `apps/api/src/demo/demoData.ts`,
used by tests and by `npm run seed:demo` for a separate demo database. Never
mixed with real data.
