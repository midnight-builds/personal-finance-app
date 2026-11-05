# Glossary

Domain terms as the code and conversations use them. One meaning per word.

**Ledger** — the module (`apps/api/src/ledger.ts`) that decides which
transactions count and what an account's balance is. Reports, insights,
forecasts and AI tools ask the Ledger instead of querying
`normalized_transactions` themselves.

**Countable transaction** — a transaction the Ledger includes by default:
booked (not pending), the canonical row of its duplicate group, and not a
transfer between own accounts.

**Duplicate group** — normalized transactions from *different* imports that
describe the same bank event (same account, day, amount, counterparty).
Paired one-to-one: two identical purchases on the same day are two
purchases, not duplicates. Nothing is deleted; the group just marks them.

**Canonical row** — the earliest imported row of a duplicate group; the one
that counts.

**Transfer** — money moving between two own accounts, linked as a pair. Left
out of spending and income by default. If one copy of a duplicate group is
linked, every copy is a transfer.

**Category (of a transaction)** — the category of its most recent
categorization decision, whether a rule, AI or the user made it. Decisions are
history: a new one is appended and earlier ones are kept (never replaced), so
anything that counts transactions must read only the latest decision.
Re-stating the latest decision (same category, same source) appends nothing.
Deleting a category appends a move to "Muut ja epäselvät" for its current
transactions; older decisions that named it are repointed there too.

**Balance (of an account, on a day)** — the latest balance snapshot on or
before that day, plus balance adjustments dated on or before the snapshot.
Unknown (null), not zero, when there is no snapshot yet.

**Balance adjustment** — a manual correction to an account's balance, e.g. a
cash withdrawal missing from the export.

**Day** — a calendar day `YYYY-MM-DD`. "Today" is today in Helsinki
(Europe/Helsinki), never the server's UTC date.

**Demo data** — the fictional household in `apps/api/src/demo/demoData.ts`,
used by tests and by `npm run seed:demo` for a separate demo database. Never
mixed with real data.
