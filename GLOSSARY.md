# Glossary

Domain terms as the code and conversations use them. One meaning per word.

**Ledger** — the module (`apps/api/src/ledger.ts`) that decides which
transactions count and what an account's balance is. Reports, insights,
forecasts and AI tools ask the Ledger instead of querying
`normalized_transactions` themselves.

**Countable transaction** — a transaction the Ledger includes by default:
booked (not pending) and not a transfer between own accounts. A transfer to a
manual account is countable: it is cash flow.

**Account** — a bank account, card, loan or asset the household tracks. Its
*type* (`account_subtype`) is one of checking, savings, credit_card, loan,
investment, property, other_asset, other_liability; credit_card, loan and
other_liability are liabilities, whose debt is stated as a positive amount and
stored as a negative balance (`balanceFromDebt`). Its *tracking* says where its
data comes from. It also has an *ownership share* (0–100 %, default 100: the
household's part, for net worth only, never for cash flow), a *currency*
(default EUR; stored, never converted) and an optional *update interval* (days
between balance updates, for staleness). Created, changed, archived and undone
through account change sets (`accountChanges.ts`), with an actor; so are its
balance observations. The cash types (checking, savings, credit_card,
`CASH_TYPES`) are the only ones the runway counts.
_Avoid_: asset item, alias (for the account; its name is what agents see)

**Tracking (of an account)** — `imported`: its transactions and balance come
from bank exports (every account an import creates), with balance observations
as anchors where the export has no balance; `manual`: nothing is imported into it
(an import naming it is refused, `409 account_manual`), and its balance is only
its balance observations. Cash views (summary, runway, briefing, import preview)
cover imported accounts only; net worth and balance history cover both. Set when
the account is created, never changed afterwards: an imported account's
transactions and bank balances would be left on a manual account (which has no
transactions and recognises payments to it as one-sided transfers), and a manual
account turned imported would make those transfers count twice once its own
side is imported. Only a manual account can be archived: hidden (out of net
worth and balance history too), it stops recognising transfers, and keeps its
name, IBAN, observations and history; unarchiving brings it back (undoing its
creation archives it).

**Transfer to a manual account** — a payment between an imported account and a
manual account, recognised by the manual account's IBAN as the payment's
counterparty IBAN (never by name: one person may be paid on several accounts).
It has one side only: the manual account has no transactions. The Ledger derives
it on every read (`ownTransfer`), so setting, changing or removing the IBAN
re-evaluates stored transactions and new imports alike, and the account change
set lists the transactions whose reporting it changes. It is not a transfer: it
counts in cash flow (net, monthly overview, runway, forecast) because the money
left the imported accounts. Its *kind* follows the manual account's type:
savings and investment are *saving*, loan and other_liability *loan repayment*
— neither is consumption, so insights and the briefing's spending findings leave
them out (`consumptionOnly`) and the summary and monthly overview show them
apart (`monthlySaving`, `monthlyLoanRepayment`; `saving`, `loanRepayment`).
Other types (a manual checking account, card, property, other asset) are
*other*: reported like any payment, since what the money bought there is not
seen. A linked transfer stays a transfer: import pairs rows as it always has, and
a pair link wins over a manual account's IBAN.
See `docs/adr/0002-transfers-to-manual-accounts.md`.
_Avoid_: allocation, alias transfer

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

**Pending row** — a row the bank lists as reserved, not booked
(Nordea `Kirjauspäivä` = "Varaus"): no booking date, so the Ledger never
counts it. It is one transaction from reservation to booking, with its life in
`pending_transactions` (`apps/api/src/migrations/pendingTransactions.ts`):

- *seen again* — a later export lists the same reservation (same account,
  amount and counterparty, last listed within 35 days): not stored again
  (`pendingSeenCount`). So is an older export imported again that still lists
  a reservation a newer export has booked;
- *booked* — a later export has its booking (same account, amount and
  counterparty, booked from 3 days before the export that first listed it to
  35 days after the newest that did): the pending row is promoted in place,
  keeping its id, decisions and links; its raw link moves to the booked raw
  row and the pending raw row is kept (`bookedPendingCount`). Rules
  categorize it again from the booked text unless its category is manual. Bookings pair
  one-to-one, in day order, with the oldest reservation first;
- *void* — a newer export of its period lists it neither pending nor booked
  (a cancelled authorisation, or a booking with another amount): kept, but
  no list, report or categorization sees it (`voidedPendingCount`). Listed
  pending again by a newer export, it is pending again.

An export's day is its latest booked day (an export does not say when it was
made); a file of reservations only takes the account's latest booked day.
"Newer export of its period": its latest booked day is on or after
that of the newest export that listed the reservation, and its booked rows
reach back 3 days before the export that first listed it. A shorter or older
export changes nothing.

**Transfer** — money moving between two own accounts, linked as a pair. Left
out of spending and income by default.

**Card repayment** — the one transfer a credit card (an account without an
IBAN) takes part in: a payment from checking into the card. Extra repayments
carry the issuer's IBAN; the monthly bill, paid as an e-invoice, often does
not. A payee that an IBAN-carrying repayment went to is the card's issuer, so
payments to it without an IBAN count as repayments too and beat other
payments of the same amount — when the card names the credit as it named that
repayment, ignoring the day some cards put in it ("Suoritus 20.10"). When these
rules change, stored rows they now pair are linked once at API start.

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
rule) or to an account (creating a manual account, changing an account,
archiving a manual one, adding, correcting or deleting a balance observation), recorded with its actor and reason, and undoable as a
whole. Each domain lists, reads and undoes only its own sets (`changeSets.ts`).

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
before that day (the bank's or a balance observation, whichever is later; two
are never added), plus balance adjustments dated on or before the snapshot.
Unknown (null), not zero, when there is no snapshot yet. Nothing is estimated
between two snapshots: the balance is a step function.

**Balance observation** — a dated balance an actor states for an account (the
user in the web UI, an agent through MCP): account, day, amount, optional note on
its source (e.g. a card statement), actor and time. For a manual account it is
the only balance; for an imported one an anchor where the export has no balance
(a credit card) or a closing balance of an old statement. Stored as a balance
snapshot with `source: manual`, so every balance view reads it like the bank's
(`docs/adr/0003-balance-observations-are-snapshots.md`); the bank's own snapshots
are never edited, only corrected with balance adjustments. Debt (credit_card,
loan, other_liability) is entered as a positive amount and stored as a negative
balance (`balanceFromDebt`). One per account and day, not in the future, never in
cash flow, never a transaction. Added, corrected and deleted through account
change sets, each undoable; a deleted one is kept in its change set. Once an
account has one, its currency and its side of the asset/liability line are
fixed (`account_has_observations`), since every stored amount rests on them. An
import with a balance for the same day replaces it (and its undo then reports
`observation_missing`). On an imported account it is reconciled with the
previous balance and the bookings in between (`reconciliation.difference`), and
a difference is shown, never booked away.
_Avoid_: manual balance, snapshot (for the observation), estimate

**Stale balance** — an account with an update interval whose latest balance is
older than that many days (`stale`, with `ageDays`). It still counts in net
worth and is flagged; an account without any balance is unknown, not stale. No
reminders are sent.

**Known balance period** — for an imported account, from its first balance
snapshot to the last day its imported data covers (latest snapshot or booking). Outside it the
account's balance is unknown, and so is a day with bookings after the snapshot
the balance rests on (rows with a blank Saldo): a balance series never carries
a stale balance or one past or before the data. A manual account has no end:
from its first observation on, its latest one holds (see "Stale balance").

**Net worth (on a day)** — the ownership share of every known balance, assets
minus liability debt, over the accounts that are not archived, imported and
manual (`balanceHistory.ts`; now: `GET /net-worth`, each account at its latest
balance). The share applies here only, never to cash flow. Totals are in EUR;
an account in another currency is never converted and has totals of its own
(`otherCurrencies`). An unknown balance is left out and listed
(`coverage.missingAccountIds`), never counted as zero, so net worth is complete
only when every account is known. Investment and property accounts count like
any other once they have a balance. Transfers between own accounts leave it
unchanged.

**Balance adjustment** — a manual correction to an account's balance, e.g. a
cash withdrawal missing from the export. It corrects a snapshot, so an account
without any snapshot refuses one (`balance_snapshot_missing`), and one dated
after the latest snapshot waits for a later snapshot (listed as not `applied`).
A manual account refuses one (`account_manual`): its balance is only what its
observations say, so correct the observation instead.

**Recurring pattern** — a counterparty an account pays again and again,
detected from its countable expenses in the 180 days up to the account's
latest booking (`patterns.ts`), so an account whose exports lag behind does
not look as if its charges had stopped.
Monthly or weekly patterns need at least three charges with a steady interval
and amount; two charges are one interval and prove nothing. The forecast
counts established ones as fixed costs and lists uncertain and lapsed ones
apart; a weekly one counts each of its charges that falls in the forecast
month (4 or 5: every day a whole number of weeks from its latest charge), a
monthly one one charge. Stored
as `recurring_patterns`; `pattern_type` is `recurring`, `subscription` or
`annual`, with a pattern decision applied (`patternDecisions.ts`). `origin` says
whether detection found it (`detected`) or an actor created it (`created`).

**Subscription** — a recurring pattern told apart by its charges, not by who
the merchant is: the same amount every time, booked on about the same day
each month (3 days early to 5 days late), with no other charge to the
counterparty in between. A counterparty paid only to an IBAN (a person, an
e-invoice biller) is never one unless the user says so, nor is a savings
pattern. The monthly subscription total and the subscription-creep finding
count established subscriptions that have not lapsed, a weekly one at 52/12
charges a month (`monthly_amount`). The monthly total (`monthlySubscriptions`)
also includes yearly subscriptions (annual patterns decided as subscriptions,
not lapsed) at 1/12 of their amount; `monthlySubscriptionsBreakdown` shows that
share separately, and the web UI notes it next to the total.

**Recurring (pattern type)** — a monthly or weekly pattern that is not a
subscription: varying amount or day, paid to an IBAN, or savings.

**Savings pattern** — a monthly or weekly pattern saved or invested rather
than spent (`savings`): most of its charges (over half) are fund purchases by
their description (`MERKINTÄ … KURSSI …`) or go to a counterparty named for a
fund or saving (`rahasto`, `säästö` but not `säästöpankki`, `fund`, `etf`;
`isSavingsCharge`).
A fixed monthly fund purchase by card charges like a subscription, so detection
never makes one a subscription, and it is established only by a pattern
decision: until then it is uncertain and asked about, whatever its confidence.
A decision settles it, `subscription` too.

**Confidence (of a pattern)** — how strongly a monthly or weekly pattern's
charges show a steady rhythm, 0–1, scored at detection (`scorePattern`):
0.4 × charges + 0.3 × interval + 0.3 × amount, where charges = min(1, (n − 2) / 3)
for n charges, interval = max(0, 1 − cv / 0.5) of the days between charges and
amount = max(0, 1 − cv / 0.15) of the amounts (cv: standard deviation over
mean). Three charges never reach 0.75; four steady ones do. The factors are
returned with it.

**Established pattern** — a monthly or weekly pattern that counts as a fixed
cost (and, if a subscription, in the subscription total): confirmed by a
pattern decision, or unconfirmed with confidence at least 0.75 (`CONFIDENT`)
and not a savings pattern.
A lapsed pattern stays established but counts nowhere while it is lapsed.

**Lapsed pattern** — a pattern, weekly, monthly or annual, detected, confirmed
or created, whose counterparty has not charged the account for two periods: the
account's latest booking (not today, so a lagging export lapses nothing) is at
least two periods plus a grace for late booking after the latest charge — 2 ×
31 + 5 = 67 days monthly, 2 × 7 + 3 = 17 weekly, 2 × 365 + 35 = 765 annual (a
detected interval longer than the nominal period counts instead). A charge is any countable expense from the
counterparty that is not a transfer, whatever its amount, so a new price never
lapses a live pattern. A lapsed pattern is kept, active and with its decision
history, and listed with `lapsed: true` and `lapsed_since` (the day it lapsed)
in `/recurring` and in the forecast's `lapsedRecurring` (annual ones in
`lapsedAnnualItems` of their month), but counted in no forecast total, not in
the subscription total or the subscription-creep finding, not asked about and
not announced as new. Detection sets it on every run (`markLapsed` in
`patterns.ts`), creation and annual confirmation too: a charge again clears it,
so the pattern counts again. It can still be decided or rejected.

**Uncertain pattern** — an unconfirmed monthly or weekly pattern below 0.75,
or an unconfirmed savings pattern.
The forecast lists it in `uncertainRecurring`, outside `knownFixed` and
`projectedTotal`.

**Pattern decision** — what the user or an agent (its actor) says a pattern,
monthly, weekly or annual, is: `recurring`, `subscription` or `not_recurring`, or `reset` to
take a decision back. Its state is then `confirmed_recurring`,
`confirmed_subscription` or `rejected`; without one, or after a reset, it is
`unconfirmed`. Decisions are history in `pattern_decisions`, keyed by
account and counterparty (the same merchant on another account is another
pattern): a new one is appended, the latest counts, and re-stating it appends
nothing. Every actor is equally trusted: an agent may replace the user's
decision and the other way round, and the history keeps who decided what.
Detection never writes decisions, so they survive every re-detection. A
decision sets a monthly or weekly pattern's type (an annual one stays annual);
a rejected pattern is left out of the forecast, totals, briefing and
`/recurring`, and never asked about again. A decided pattern is deactivated only
when its charges stop, and its decision applies again if they resume. A
decision is of the pattern's kind when made, annual or monthly/weekly
(`pattern_decisions.annual`), and applies only while the pattern is of that
kind: a row that turns annual (or back) follows the decisions of its new kind,
none until one is made.
_Avoid_: user_confirmed (the legacy flag of confirmed annual patterns)

**Created pattern** — a weekly, monthly or yearly pattern an actor added that
detection never proposed (`origin` `created`, `created_by`; `POST /patterns`,
`patternCreation.ts`), e.g. a contract that started last month or an annual
insurance premium. One charge is enough: the actor cites existing charges, each
a booked expense of that account and counterparty, not a transfer, within 20 %
of the expected amount (25 % yearly, detection's annual tolerance) and at least
5 (weekly), 20 (monthly) or 300 (yearly, so a second charge in a year is not taken for it)
days from the next. It is confirmed at once with a pattern decision by the same
actor and counts like any confirmed pattern, at the expected amount. A yearly
one is an annual pattern (`pattern_type` `annual`) forecast in its typical
month, the month of its latest charge; it is not in the monthly subscription
total. Its charges are the counterparty's countable expenses within the
tolerance of the expected amount from the first cited one on, one per period,
so later ones attach to it (and move a yearly one's typical month). One pattern
per account and counterparty: an inactive one is taken over (same id), an active
detected one, monthly, weekly or annual (also one confirmed as annual), is
decided instead (`409 pattern_exists`); creating resolves the pending
confirmation candidates for the counterparty (`superseded`; see there); and creating an
active created one again re-states it
(a new price or kind; the same values write nothing). While its latest decision
is not `reset`, detection never deactivates, retypes or re-prices it and never
adds a second row; when detection finds the same pattern it stays the created
one, and only its charge count, latest charge and confidence are updated. So it
stays active after its charges stop, until someone rejects it, but two periods
without a charge make it a lapsed pattern, counted nowhere. Rejecting it
works as for any pattern. `reset` withdraws it: nobody vouches for it, so it is
left out of the forecast, totals, questions and `/recurring` unless its own
charges make it established (confidence at least 0.75), and detection treats it
as its own: finding it, it becomes a detected pattern (`created_by` stays as
history); once its charges stop, it is deactivated (a withdrawn yearly one is
left to annual detection).
_Avoid_: manual pattern (it is not about manual decisions)

**Recurring question** — "Onko tämä toistuva?": an uncertain pattern (no
decision, confidence below 0.75 or savings) offered to the user with its charges as
evidence. An established pattern needs no confirmation and is not asked, and a
decided or rejected one never is; any active monthly or weekly pattern can still
be decided, asked or not. A fixed amount is shown as a hint of what it may be
(paid to an IBAN every time: savings, rent or a person; otherwise savings or a
subscription). A bill of varying amount reaches 0.75 in four or five months
with a spread of a few percent; a wider one may need the user's answer. The
briefing shows the three largest and hides a question once answered. Answered with a pattern decision
(`GET /patterns/questions`, `POST /patterns/:id/decision`).

**Annual pattern** — a charge about once a year (330–400 days apart), one the
user confirmed as annual (a confirmation candidate), or a yearly created
pattern. The forecast counts it in its `typical_month` (`annualItems`) unless
a pattern decision rejected it or it has lapsed (two years and 35 days without
a charge). It can be decided like any pattern; it stays annual.

**Confirmation candidate** — a single large expense (≥ 80 €) with no pattern,
offered to the user to confirm as annual (`pattern_confirmations`); asked once
per counterparty and month across accounts. It is hidden while its account has
an active pattern for the counterparty, or while an annual pattern on another
account counts the same payment (same counterparty, within a month and 25 %;
not rejected, withdrawn or lapsed), and then cannot be confirmed (`409
pattern_exists`; an answered one `409 not_pending`). Creating a pattern for the
counterparty resolves it (`superseded`): on that account, and for a yearly
pattern also those about the same payment on other accounts.

**Pattern rules version** — `PATTERN_RULES_VERSION` in `patterns.ts`. Bumping it
re-detects every account's patterns on the next API start, so stored patterns
follow changed rules without waiting for an import.

**Day** — a calendar day `YYYY-MM-DD`. "Today" is today in Helsinki
(Europe/Helsinki), never the server's UTC date.

**Demo data** — the fictional household in `apps/api/src/demo/demoData.ts`,
used by tests and by `npm run seed:demo` for a separate demo database. Never
mixed with real data.
