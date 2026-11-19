# Balance observations are balance snapshots

A dated balance an actor states for an account (GLOSSARY.md, "Balance observation"; proposals f8f9d34e and d6a9b6e4) is stored as a row of `balance_snapshots` with `source = 'manual'`, with the actor, an optional note and the time of its last correction. It is not a table of its own.

The app already had one rule for an account's balance on a day: the latest snapshot on or before it, plus adjustments (ledger.ts), and an earlier "manual balance" was already a `manual` snapshot. A separate observations table would have been a second source every balance view (Ledger, balance history, net worth, summary, briefing, import preview) has to merge, with a second answer to "which wins on the same day" and a real chance of adding an imported account's bank balance and an observation together. As snapshots, one rule covers both: the later one wins, two are never added, and nothing is estimated between them. Existing manual snapshots became observations with no migration (actor `system`). The unique index on account and day gives one balance per account and day for both sources.

The bank's snapshots stay read-only: they are corrected with balance adjustments, never rewritten. Observations are written only through account change sets (add, correct, delete, undo), so each has an actor and an undo, and a deleted one survives in its change set. An import that brings the bank's balance for a day replaces an observation of that day, as it replaced a manual balance before; the bank's balance is the better source, and the change set's undo reports the observation missing.

Because a stored observation is a signed amount in the account's currency, an account that has observations cannot change its currency or move across the asset/liability line: either would silently reinterpret every stored amount (a loan entered under the wrong type would turn into an asset). The user deletes or corrects them first.

Tracking stays fixed after creation (imported or manual): no need for a change came up, and either direction would mix one-sided transfers with transactions on the same account.
