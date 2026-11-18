// Generated from GLOSSARY.md by scripts/sync-glossary.ts. Do not edit by hand:
// run `npm run glossary --workspace apps/mcp`. tests/glossary.test.ts fails on drift.
import type { GlossaryTerm } from './parse.js';

export const GLOSSARY_TERMS: readonly GlossaryTerm[] = [
  {
    "term": "Ledger",
    "summary": "the module (`apps/api/src/ledger.ts`) that decides which transactions count and what an account's balance is.",
    "definition": "the module (`apps/api/src/ledger.ts`) that decides which transactions count and what an account's balance is. Reports, insights, forecasts and AI tools ask the Ledger instead of querying `normalized_transactions` themselves.",
    "avoid": null
  },
  {
    "term": "Countable transaction",
    "summary": "a transaction the Ledger includes by default: booked (not pending) and not a transfer between own accounts.",
    "definition": "a transaction the Ledger includes by default: booked (not pending) and not a transfer between own accounts.",
    "avoid": null
  },
  {
    "term": "Duplicate",
    "summary": "a row of an import that the account already has: same booking date, amount and counterparty (a missing counterparty matches a missing one) as a stored row from an *earlier* import.",
    "definition": "a row of an import that the account already has: same booking date, amount and counterparty (a missing counterparty matches a missing one) as a stored row from an *earlier* import. A transaction is stored once, so a duplicate is not stored at all (neither raw nor normalized); the import counts it as `duplicateCount`. Paired one-to-one: a file with three identical rows where two are stored brings one new row, and two identical purchases in one file are two purchases, never duplicates. (Databases from before this rule held the copies in duplicate groups; the API collapses them into the earliest imported row once at start, `apps/api/src/migrations/collapseDuplicates.ts`.)",
    "avoid": null
  },
  {
    "term": "Pending row",
    "summary": "a row the bank lists as reserved, not booked (Nordea `Kirjauspäivä` = \"Varaus\"): no booking date, so the Ledger never counts it.",
    "definition": "a row the bank lists as reserved, not booked (Nordea `Kirjauspäivä` = \"Varaus\"): no booking date, so the Ledger never counts it. It is one transaction from reservation to booking, with its life in `pending_transactions` (`apps/api/src/migrations/pendingTransactions.ts`): - *seen again* — a later export lists the same reservation (same account, amount and counterparty, last listed within 35 days): not stored again (`pendingSeenCount`). So is an older export imported again that still lists a reservation a newer export has booked; - *booked* — a later export has its booking (same account, amount and counterparty, booked from 3 days before the export that first listed it to 35 days after the newest that did): the pending row is promoted in place, keeping its id, decisions and links; its raw link moves to the booked raw row and the pending raw row is kept (`bookedPendingCount`). Rules categorize it again from the booked text unless its category is manual. Bookings pair one-to-one, in day order, with the oldest reservation first; - *void* — a newer export of its period lists it neither pending nor booked (a cancelled authorisation, or a booking with another amount): kept, but no list, report or categorization sees it (`voidedPendingCount`). Listed pending again by a newer export, it is pending again. An export's day is its latest booked day (an export does not say when it was made); a file of reservations only takes the account's latest booked day. \"Newer export of its period\": its latest booked day is on or after that of the newest export that listed the reservation, and its booked rows reach back 3 days before the export that first listed it. A shorter or older export changes nothing.",
    "avoid": null
  },
  {
    "term": "Transfer",
    "summary": "money moving between two own accounts, linked as a pair.",
    "definition": "money moving between two own accounts, linked as a pair. Left out of spending and income by default.",
    "avoid": null
  },
  {
    "term": "Card repayment",
    "summary": "the one transfer a credit card (an account without an IBAN) takes part in: a payment from checking into the card.",
    "definition": "the one transfer a credit card (an account without an IBAN) takes part in: a payment from checking into the card. Extra repayments carry the issuer's IBAN; the monthly bill, paid as an e-invoice, often does not. A payee that an IBAN-carrying repayment went to is the card's issuer, so payments to it without an IBAN count as repayments too and beat other payments of the same amount — when the card names the credit as it named that repayment, ignoring the day some cards put in it (\"Suoritus 20.10\"). When these rules change, stored rows they now pair are linked once at API start.",
    "avoid": null
  },
  {
    "term": "Category (of a transaction)",
    "summary": "the category of its most recent categorization decision, whether a rule, AI or the user made it.",
    "definition": "the category of its most recent categorization decision, whether a rule, AI or the user made it. Decisions are history: a new one is appended and earlier ones are kept (never replaced), so anything that counts transactions must read only the latest decision. Re-stating the latest decision (same category, same source) appends nothing.",
    "avoid": null
  },
  {
    "term": "Actor",
    "summary": "who made a change: the user (web UI) or a named agent such as Hermes (MCP).",
    "definition": "who made a change: the user (web UI) or a named agent such as Hermes (MCP). Named by the client, not authenticated. Changes from before actors existed belong to `system`.",
    "avoid": "user (for agents), author"
  },
  {
    "term": "Source (of a decision)",
    "summary": "how a decision was reached: manual, rule or AI.",
    "definition": "how a decision was reached: manual, rule or AI. Independent of the actor: a rule's decision during Hermes's import has actor Hermes and source rule.",
    "avoid": null
  },
  {
    "term": "Manual decision",
    "summary": "a decision an actor made by choosing the category directly.",
    "definition": "a decision an actor made by choosing the category directly. No rule overrides it; only a newer decision does.",
    "avoid": null
  },
  {
    "term": "Category role",
    "summary": "the special job a category does whatever it is named: `fallback` (where uncategorized and archived categories' transactions go), `income`, `refund`.",
    "definition": "the special job a category does whatever it is named: `fallback` (where uncategorized and archived categories' transactions go), `income`, `refund`. A category with a role cannot be archived.",
    "avoid": "built-in name, \"Muut\" as an identifier"
  },
  {
    "term": "Archived category",
    "summary": "a category taken out of use: hidden from pickers, its transactions moved to another category by new decisions, its rules disabled.",
    "definition": "a category taken out of use: hidden from pickers, its transactions moved to another category by new decisions, its rules disabled. Its past decisions stay as they were. Categories are never deleted.",
    "avoid": "deleted category"
  },
  {
    "term": "Disabled rule",
    "summary": "a rule that no longer matches; kept for history.",
    "definition": "a rule that no longer matches; kept for history.",
    "avoid": null
  },
  {
    "term": "Change set",
    "summary": "one applied change to categorization (recategorizing rows, creating, renaming, archiving or merging a category, creating or disabling a rule), recorded with its actor and reason, and undoable as a whole.",
    "definition": "one applied change to categorization (recategorizing rows, creating, renaming, archiving or merging a category, creating or disabling a rule), recorded with its actor and reason, and undoable as a whole.",
    "avoid": null
  },
  {
    "term": "Plan",
    "summary": "a change set worked out without writing anything: what would move where, and what is left out as an exception.",
    "definition": "a change set worked out without writing anything: what would move where, and what is left out as an exception. Applying needs the plan's token, which goes stale when the data the plan rests on changes.",
    "avoid": "preview (for categorization), proposal"
  },
  {
    "term": "Undo",
    "summary": "reverting a change set with new decisions; rows changed again since the set are left alone and reported.",
    "definition": "reverting a change set with new decisions; rows changed again since the set are left alone and reported.",
    "avoid": null
  },
  {
    "term": "Import preview",
    "summary": "what importing a file would do, computed before anything is written: the guessed target account, and for the chosen target the rows that are duplicates (would be skipped), transfers, gaps and balance breaks.",
    "definition": "what importing a file would do, computed before anything is written: the guessed target account, and for the chosen target the rows that are duplicates (would be skipped), transfers, gaps and balance breaks. Its counts come from a dry run.",
    "avoid": null
  },
  {
    "term": "Dry run",
    "summary": "the real import pipeline run inside a transaction that is always rolled back, so its counts equal what the import then does and nothing (not even the event log) is kept.",
    "definition": "the real import pipeline run inside a transaction that is always rolled back, so its counts equal what the import then does and nothing (not even the event log) is kept.",
    "avoid": null
  },
  {
    "term": "Target account",
    "summary": "the account an import goes into: chosen by the user, or inferred from the export's own IBAN.",
    "definition": "the account an import goes into: chosen by the user, or inferred from the export's own IBAN. An export without one (a credit card) needs the user's choice.",
    "avoid": null
  },
  {
    "term": "Balance break",
    "summary": "a day where the previous day's running balance (Saldo) plus the day's amounts does not give the day's last Saldo: rows are missing from the export in between.",
    "definition": "a day where the previous day's running balance (Saldo) plus the day's amounts does not give the day's last Saldo: rows are missing from the export in between.",
    "avoid": null
  },
  {
    "term": "Balance (of an account, on a day)",
    "summary": "the latest balance snapshot on or before that day, plus balance adjustments dated on or before the snapshot.",
    "definition": "the latest balance snapshot on or before that day, plus balance adjustments dated on or before the snapshot. Unknown (null), not zero, when there is no snapshot yet.",
    "avoid": null
  },
  {
    "term": "Known balance period",
    "summary": "from an account's first balance snapshot to the last day its imported data covers (latest snapshot or booking).",
    "definition": "from an account's first balance snapshot to the last day its imported data covers (latest snapshot or booking). Outside it the account's balance is unknown, and so is a day with bookings after the snapshot the balance rests on (rows with a blank Saldo): a balance series never carries a stale balance or one past or before the data.",
    "avoid": null
  },
  {
    "term": "Net worth (on a day)",
    "summary": "known balances of bank accounts minus credit card debt, over the accounts whose balance is known that day (`balanceHistory.ts`).",
    "definition": "known balances of bank accounts minus credit card debt, over the accounts whose balance is known that day (`balanceHistory.ts`). Complete only when every account is known; investments are not tracked and never included. Transfers between own accounts leave it unchanged.",
    "avoid": null
  },
  {
    "term": "Balance adjustment",
    "summary": "a manual correction to an account's balance, e.g. a cash withdrawal missing from the export.",
    "definition": "a manual correction to an account's balance, e.g. a cash withdrawal missing from the export.",
    "avoid": null
  },
  {
    "term": "Recurring pattern",
    "summary": "a counterparty an account pays again and again, detected from its countable expenses in the 180 days up to the account's latest booking (`patterns.ts`), so an account whose exports lag behind does not look as if its charges had stopped.",
    "definition": "a counterparty an account pays again and again, detected from its countable expenses in the 180 days up to the account's latest booking (`patterns.ts`), so an account whose exports lag behind does not look as if its charges had stopped. Monthly or weekly patterns need at least three charges with a steady interval and amount; two charges are one interval and prove nothing. The forecast counts established ones as fixed costs and lists uncertain and lapsed ones apart; a weekly one counts each of its charges that falls in the forecast month (4 or 5: every day a whole number of weeks from its latest charge), a monthly one one charge. Stored as `recurring_patterns`; `pattern_type` is `recurring`, `subscription` or `annual`, with a pattern decision applied (`patternDecisions.ts`). `origin` says whether detection found it (`detected`) or an actor created it (`created`).",
    "avoid": null
  },
  {
    "term": "Subscription",
    "summary": "a recurring pattern told apart by its charges, not by who the merchant is: the same amount every time, booked on about the same day each month (3 days early to 5 days late), with no other charge to the counterparty in between.",
    "definition": "a recurring pattern told apart by its charges, not by who the merchant is: the same amount every time, booked on about the same day each month (3 days early to 5 days late), with no other charge to the counterparty in between. A counterparty paid only to an IBAN (a person, an e-invoice biller) is never one unless the user says so. Fixed monthly savings paid by card look the same; the user or an agent can reject or reclassify one with a pattern decision. The monthly subscription total and the subscription-creep finding count established subscriptions that have not lapsed, a weekly one at 52/12 charges a month (`monthly_amount`).",
    "avoid": null
  },
  {
    "term": "Recurring (pattern type)",
    "summary": "a monthly or weekly pattern that is not a subscription: varying amount or day, or paid to an IBAN.",
    "definition": "a monthly or weekly pattern that is not a subscription: varying amount or day, or paid to an IBAN.",
    "avoid": null
  },
  {
    "term": "Confidence (of a pattern)",
    "summary": "how strongly a monthly or weekly pattern's charges show a steady rhythm, 0–1, scored at detection (`scorePattern`): 0.4 × charges + 0.3 × interval + 0.3 × amount, where charges = min(1, (n − 2) / 3) for n charges, interval = max(0, 1 − cv / 0.5) of the days between charges and amount = max(0, 1 − cv / 0.15) of the amounts (cv: standard deviation over mean).",
    "definition": "how strongly a monthly or weekly pattern's charges show a steady rhythm, 0–1, scored at detection (`scorePattern`): 0.4 × charges + 0.3 × interval + 0.3 × amount, where charges = min(1, (n − 2) / 3) for n charges, interval = max(0, 1 − cv / 0.5) of the days between charges and amount = max(0, 1 − cv / 0.15) of the amounts (cv: standard deviation over mean). Three charges never reach 0.75; four steady ones do. The factors are returned with it.",
    "avoid": null
  },
  {
    "term": "Established pattern",
    "summary": "a monthly or weekly pattern that counts as a fixed cost (and, if a subscription, in the subscription total): confirmed by a pattern decision, or unconfirmed with confidence at least 0.75 (`CONFIDENT`).",
    "definition": "a monthly or weekly pattern that counts as a fixed cost (and, if a subscription, in the subscription total): confirmed by a pattern decision, or unconfirmed with confidence at least 0.75 (`CONFIDENT`). A lapsed pattern stays established but counts nowhere while it is lapsed.",
    "avoid": null
  },
  {
    "term": "Lapsed pattern",
    "summary": "a monthly or weekly pattern, detected or created, whose counterparty has not charged the account for two periods: the account's latest booking (not today, so a lagging export lapses nothing) is at least two periods plus a grace for late booking after the latest charge — 2 × 31 + 5 = 67 days monthly, 2 × 7 + 3 = 17 weekly (a detected interval longer than the nominal period counts instead).",
    "definition": "a monthly or weekly pattern, detected or created, whose counterparty has not charged the account for two periods: the account's latest booking (not today, so a lagging export lapses nothing) is at least two periods plus a grace for late booking after the latest charge — 2 × 31 + 5 = 67 days monthly, 2 × 7 + 3 = 17 weekly (a detected interval longer than the nominal period counts instead). A charge is any countable expense from the counterparty that is not a transfer, whatever its amount, so a new price never lapses a live pattern. A lapsed pattern is kept, active and with its decision history, and listed with `lapsed: true` and `lapsed_since` (the day it lapsed) in `/recurring` and in the forecast's `lapsedRecurring`, but counted in no forecast total, not in the subscription total or the subscription-creep finding, not asked about and not announced as new. Detection sets it on every run (`markLapsed` in `patterns.ts`), creation too: a charge again clears it, so the pattern counts again. It can still be decided or rejected. Annual patterns do not lapse.",
    "avoid": null
  },
  {
    "term": "Uncertain pattern",
    "summary": "an unconfirmed monthly or weekly pattern below 0.75.",
    "definition": "an unconfirmed monthly or weekly pattern below 0.75. The forecast lists it in `uncertainRecurring`, outside `knownFixed` and `projectedTotal`.",
    "avoid": null
  },
  {
    "term": "Pattern decision",
    "summary": "what the user or an agent (its actor) says a monthly or weekly pattern is: `recurring`, `subscription` or `not_recurring`, or `reset` to take a decision back.",
    "definition": "what the user or an agent (its actor) says a monthly or weekly pattern is: `recurring`, `subscription` or `not_recurring`, or `reset` to take a decision back. Its state is then `confirmed_recurring`, `confirmed_subscription` or `rejected`; without one, or after a reset, it is `unconfirmed`. Decisions are history in `pattern_decisions`, keyed by account and counterparty (the same merchant on another account is another pattern): a new one is appended, the latest counts, and re-stating it appends nothing. Every actor is equally trusted: an agent may replace the user's decision and the other way round, and the history keeps who decided what. Detection never writes decisions, so they survive every re-detection. A decision sets the pattern's type; a rejected pattern is left out of the forecast, totals, briefing and `/recurring`, and never asked about again. A decided pattern is deactivated only when its charges stop, and its decision applies again if they resume. Decisions apply to monthly and weekly patterns only; a row that turns annual follows the annual rules.",
    "avoid": "user_confirmed (the legacy flag of confirmed annual patterns)"
  },
  {
    "term": "Created pattern",
    "summary": "a monthly or weekly pattern an actor added that detection never proposed (`origin` `created`, `created_by`; `POST /patterns`, `patternCreation.ts`), e.g. a contract that started last month.",
    "definition": "a monthly or weekly pattern an actor added that detection never proposed (`origin` `created`, `created_by`; `POST /patterns`, `patternCreation.ts`), e.g. a contract that started last month. One charge is enough: the actor cites existing charges, each a booked expense of that account and counterparty, not a transfer, within 20 % of the expected amount and at least 5 (weekly) or 20 (monthly) days from the next. It is confirmed at once with a pattern decision by the same actor and counts like any confirmed pattern, at the expected amount. Its charges are the counterparty's countable expenses within 20 % of the expected amount from the first cited one on, one per period, so later ones attach to it. One pattern per account and counterparty: an inactive one is taken over (same id), an active detected one is decided instead (`409 pattern_exists`), and creating an active created one again re-states it (a new price or kind; the same values write nothing). While its latest decision is not `reset`, detection never deactivates, retypes or re-prices it and never adds a second row; when detection finds the same pattern it stays the created one, and only its charge count, latest charge and confidence are updated. So it stays active after its charges stop, until someone rejects it, but two periods without a charge make it a lapsed pattern, counted nowhere. Rejecting it works as for any pattern. `reset` withdraws it: nobody vouches for it, so it is left out of the forecast, totals, questions and `/recurring` unless its own charges make it established (confidence at least 0.75), and detection treats it as its own: finding it, it becomes a detected pattern (`created_by` stays as history); once its charges stop, it is deactivated. Weekly and monthly only: annual patterns follow their own confirmation.",
    "avoid": "manual pattern (it is not about manual decisions)"
  },
  {
    "term": "Recurring question",
    "summary": "\"Onko tämä toistuva?\": an uncertain pattern (no decision, confidence below 0.75) offered to the user with its charges as evidence.",
    "definition": "\"Onko tämä toistuva?\": an uncertain pattern (no decision, confidence below 0.75) offered to the user with its charges as evidence. An established pattern needs no confirmation and is not asked, and a decided or rejected one never is; any active monthly or weekly pattern can still be decided, asked or not. A fixed amount is shown as a hint of what it may be (paid to an IBAN every time: savings, rent or a person; otherwise savings or a subscription). A bill of varying amount reaches 0.75 in four or five months with a spread of a few percent; a wider one may need the user's answer. The briefing shows the three largest and hides a question once answered. Answered with a pattern decision (`GET /patterns/questions`, `POST /patterns/:id/decision`).",
    "avoid": null
  },
  {
    "term": "Annual pattern",
    "summary": "a charge about once a year (330–400 days apart), or one the user confirmed as annual.",
    "definition": "a charge about once a year (330–400 days apart), or one the user confirmed as annual.",
    "avoid": null
  },
  {
    "term": "Confirmation candidate",
    "summary": "a single large expense (≥ 80 €) with no pattern, offered to the user to confirm as annual (`pattern_confirmations`).",
    "definition": "a single large expense (≥ 80 €) with no pattern, offered to the user to confirm as annual (`pattern_confirmations`).",
    "avoid": null
  },
  {
    "term": "Pattern rules version",
    "summary": "`PATTERN_RULES_VERSION` in `patterns.ts`.",
    "definition": "`PATTERN_RULES_VERSION` in `patterns.ts`. Bumping it re-detects every account's patterns on the next API start, so stored patterns follow changed rules without waiting for an import.",
    "avoid": null
  },
  {
    "term": "Day",
    "summary": "a calendar day `YYYY-MM-DD`.",
    "definition": "a calendar day `YYYY-MM-DD`. \"Today\" is today in Helsinki (Europe/Helsinki), never the server's UTC date.",
    "avoid": null
  },
  {
    "term": "Demo data",
    "summary": "the fictional household in `apps/api/src/demo/demoData.ts`, used by tests and by `npm run seed:demo` for a separate demo database.",
    "definition": "the fictional household in `apps/api/src/demo/demoData.ts`, used by tests and by `npm run seed:demo` for a separate demo database. Never mixed with real data.",
    "avoid": null
  }
];
