# Proactive CFO — Design Spec
_2026-04-28_

## Vision

Finance-app becomes a **proactive personal CFO**: it analyses imported data, surfaces habits and anomalies, and teaches financial awareness — without waiting to be asked. It is not a chatbot or a query interface; it is an opinionated briefing machine that knows your finances better than you do.

Core shift: **import-triggered intelligence**, not passive charts.

---

## Core Experience

### Import triggers a Briefing

Every import runs the full analysis pipeline and produces a **BriefingSession** — an ordered list of typed findings. The home screen shows the latest briefing below the always-visible CFO state panel.

If no import has been done in >7 days, the home screen prominently prompts for a new file.

### Three views

| View | Purpose |
|---|---|
| **Home** | CFO state panel (top) + latest Briefing findings (below) |
| **Explorer** | Transaction list with filters, charts, drill-down |
| **Settings** | Account config, categories, rules |

### CFO State Panel (always visible on Home)

Shows household-level signals as of the latest import:

```
Kotitalous — data: 3 pv sitten   [Tuo uusi →]

Likvidit varat   Runway    Luottovelka   Tilaukset
  12 400 €        8 kk      1 200 €      110 €/kk

[Nordea käyttö]  [S-Pankki säästö ↑]  [Visa luotto ⚠]
  2 340 €           8 500 €              -1 200 €
```

Credit card shown as liability. Savings shown with trend arrow. Warning badge if credit balance growing.

### Briefing Findings

Each finding is a typed card ordered by impact/surprise:

- **subscription_creep** — "Sinulla on nyt 4 tilauspalvelua Visalla — yhteensä 87 €/kk. Uusi: Netflix +15,99 €."
- **one_off_impact** — "Ostit Verkkokauppa.com 289 €. Tällä kuulla runway lyheni 8 kk → 6 kk."
- **savings_milestone** — "Säästötilisi kasvoi 200 € — paras kuukausi tänä vuonna."
- **spending_anomaly** — "Ravintolat: 340 € tässä kuussa, kolminkertainen normaali."
- **new_recurring** — "Uusi toistuva veloitus tunnistettu: Fortum 87 €/kk."
- **credit_health** — "Luottokorttivelkasi on kasvanut 3 kuukautta peräkkäin."

Findings link to the underlying transactions — user can drill down.

---

## Data Model Changes

### accounts — extended

```sql
ALTER TABLE accounts ADD COLUMN account_subtype TEXT NOT NULL DEFAULT 'checking';
-- values: checking | savings | credit_card
ALTER TABLE accounts ADD COLUMN owner_label TEXT;
-- free text: "Mikko", "Laura", null = shared
ALTER TABLE accounts ADD COLUMN credit_limit REAL;
-- credit cards only
ALTER TABLE accounts ADD COLUMN savings_goal REAL;
-- optional savings target
```

Existing `type` column (currently always `'bank'`) is kept for backwards compatibility. `account_subtype` carries the new semantics.

### recurring_patterns (new table)

```sql
CREATE TABLE IF NOT EXISTS recurring_patterns (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  account_id TEXT NOT NULL,
  counterparty_name TEXT,
  pattern_type TEXT NOT NULL,   -- 'subscription' | 'recurring' | 'salary'
  interval_days INTEGER,         -- approx interval
  typical_amount REAL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);
```

### briefing_sessions (new table — must be created before insight_findings)

```sql
CREATE TABLE IF NOT EXISTS briefing_sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  import_session_id TEXT,        -- which import triggered this
  finding_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(import_session_id) REFERENCES import_sessions(id)
);
```

### insight_findings (new table, extends/replaces in-memory Insight)

```sql
CREATE TABLE IF NOT EXISTS insight_findings (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  briefing_session_id TEXT,      -- null = standalone/legacy
  finding_type TEXT NOT NULL,    -- see finding types above
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',  -- info | warn | alert
  impact_eur REAL,               -- optional: EUR impact of this finding
  transaction_ids TEXT,          -- JSON array
  metadata TEXT,                 -- JSON: type-specific extra data
  dismissed_at TEXT,             -- user dismissed
  FOREIGN KEY(briefing_session_id) REFERENCES briefing_sessions(id)
);
```

---

## Backend: New Modules

### `src/patterns.ts` — Recurring & Subscription Detection

Runs after import normalization. Analyses last 6 months of transactions per account.

**RecurringDetector:**
- Groups by `counterparty_name`
- Finds occurrences with interval 25–35 days → monthly recurring
- Finds occurrences with interval 6–8 days → weekly
- Threshold: ≥2 occurrences with consistent amount (±20%)

**SubscriptionDetector:**
- Subset of monthly recurring
- Heuristic keywords in counterparty name (Netflix, Spotify, etc.) OR
- Small fixed amount (< 50 €) with exact repeat interval

**Output:** Upserts `recurring_patterns` rows.

### `src/briefing.ts` — BriefingEngine

Runs after patterns detection. Produces a `BriefingSession` with `InsightFindings`.

**Generators (each returns 0–N findings):**

| Generator | Logic |
|---|---|
| `subscriptionCreep` | Total subscription spend this month vs. 3-month avg; list new subscriptions |
| `oneOffImpact` | Large one-off transactions (>2× median monthly discretionary spend, where discretionary = non-transfer, not matching any active recurring_pattern); compute runway delta vs. current runway |
| `savingsProgress` | Savings account balance trend (last 3 months); milestone detection |
| `creditHealth` | Credit card balance trend; alert if growing 3+ months |
| `spendingAnomaly` | Category spend > 2× rolling average |
| `newRecurring` | Recurring patterns created in this import's date range |

Findings are sorted by `severity` (alert > warn > info) then by `impact_eur` descending.

### `src/summary.ts` — Extended Household Summary

Extends existing summary to include per-account subtype signals:

```ts
type HouseholdSummary = {
  liquidAssets: number;         // sum of checking accounts
  totalSavings: number;         // sum of savings accounts
  creditDebt: number;           // sum of credit_card balances (positive = owed)
  monthlySubscriptions: number; // from active subscription patterns
  runwayMonths: number | null;
  accounts: AccountSignal[];
  dataAgedays: number;          // days since last import
};

type AccountSignal = {
  id: string; name: string; subtype: string; ownerLabel: string | null;
  balance: number; trend: 'up' | 'down' | 'stable' | null;
  warningLevel: 'none' | 'warn' | 'alert';
};
```

---

## API Changes

### New endpoints

```
GET  /briefing/latest           → BriefingSession + findings[]
GET  /briefing/:id              → specific BriefingSession + findings[]
POST /briefing/:findingId/dismiss → mark finding dismissed

GET  /household/summary         → HouseholdSummary (replaces/extends /summary)
GET  /subscriptions             → active RecurringPatterns (type=subscription)
GET  /recurring                 → all active RecurringPatterns

PATCH /accounts/:id             → update subtype, owner_label, credit_limit, savings_goal
```

### Import endpoint change

`POST /import` response now includes `briefingSessionId` so the frontend can immediately navigate to the new briefing.

---

## Frontend: Component Architecture

### Problem

`App.tsx` is 1048 lines. Everything is in one component. This must be split as part of this work.

### New structure

```
src/
  App.tsx                    ← routing + global state (providers)
  api/
    client.ts                ← all fetch calls, typed
  components/
    CfoStatePanel.tsx        ← top bar: household summary + account cards
    BriefingPanel.tsx        ← finding cards list
    FindingCard.tsx           ← single finding with drill-down
    AccountCard.tsx          ← per-account signal chip
    ImportPrompt.tsx         ← "data is stale, import now" CTA
  views/
    HomeView.tsx             ← CfoStatePanel + BriefingPanel
    ExplorerView.tsx         ← transaction list + charts
    SettingsView.tsx         ← accounts config, categories, rules
  charts/
    BalanceChart.tsx         ← account balance over time (Recharts)
    MonthlyNetChart.tsx      ← monthly income/expense bar chart
    SubscriptionChart.tsx    ← subscription spend over time
```

### Chart library

Add **Recharts** (`recharts` + `@types/recharts`). Lightweight, React-native, well-maintained.

### Proactive import prompt

`CfoStatePanel` computes `dataAgeDays` from the latest import session timestamp.
- >7 days: prominent yellow banner "Viimeisin data 8 pv sitten — tuo uusi tiedosto"
- >14 days: red/orange banner
- On mount, if data is stale, ImportPrompt is shown above CfoStatePanel

---

## Error Handling

- Import fails: existing error handling unchanged; no BriefingSession created
- Pattern detection throws: logged, import still succeeds, briefing skipped (non-fatal)
- Briefing generator throws: that generator's findings skipped, others proceed
- API returns empty briefing gracefully (finding_count = 0, no cards shown)

---

## Testing

- **Unit tests** (api): RecurringDetector, SubscriptionDetector, each BriefingGenerator — with fixture transactions
- **Integration test**: full import → patterns → briefing pipeline on real SQLite (`:memory:`)
- **Existing tests**: must all pass unchanged
- **Frontend**: no new automated tests in this phase; Playwright smoke test updated to cover HomeView

---

## Out of Scope (this phase)

- Home Assistant / push notification integration
- Multi-user auth
- Budget targets per person
- AI-powered insight text generation
- Mobile layout

---

## Open Questions (resolved)

- Account subtype: use new `account_subtype` column, keep existing `type` column as-is ✓
- Owner grouping: free-text `owner_label`, no auth system ✓
- Chart library: Recharts ✓
- Briefing persistence: yes, stored in DB for history ✓
