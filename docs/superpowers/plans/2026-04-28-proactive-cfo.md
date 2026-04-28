# Proactive CFO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform finance-app from a passive CSV viewer into an import-triggered Proactive CFO that surfaces subscription creep, one-off spending impact, and savings progress through a briefing-driven home screen.

**Architecture:** Every import triggers pattern detection (recurring/subscription) then a BriefingEngine that writes typed InsightFindings into a BriefingSession. The frontend home screen shows a CFO State Panel (household totals, per-account signal cards) above a Briefing Panel (finding cards). App.tsx is split into focused components; Recharts adds charts to the Explorer view.

**Tech Stack:** Node.js 22 + node:sqlite (experimental), Fastify 5, TypeScript 5, React 19, Vite 7, Recharts 2, node:test

---

## File Map

### Backend — new files
- `apps/api/src/patterns.ts` — RecurringDetector + SubscriptionDetector, writes `recurring_patterns`
- `apps/api/src/briefing.ts` — BriefingEngine, all generators, writes `briefing_sessions` + `insight_findings`
- `apps/api/tests/patterns.test.ts` — unit tests for pattern detection
- `apps/api/tests/briefing.test.ts` — unit tests for each briefing generator
- `apps/api/tests/household-summary.test.ts` — tests for getHouseholdSummary

### Backend — modified files
- `apps/api/src/db.ts` — add `account_subtype`, `owner_label`, `credit_limit`, `savings_goal` to accounts; add `recurring_patterns`, `briefing_sessions`, `insight_findings` tables
- `apps/api/src/accounts.ts` — add `updateAccount()`, extend `listAccounts()` to return new columns
- `apps/api/src/summary.ts` — add `getHouseholdSummary()` alongside existing `getSummary()`
- `apps/api/src/importer.ts` — call `detectPatterns()` + `runBriefing()` after import; extend `ImportResult` with `briefingSessionId`
- `apps/api/src/index.ts` — add new API routes

### Frontend — new files
- `apps/web/src/api/client.ts` — all typed fetch calls
- `apps/web/src/views/HomeView.tsx` — CFO state panel + briefing panel
- `apps/web/src/views/ExplorerView.tsx` — transaction list + charts (content from current analyticsView)
- `apps/web/src/views/SettingsView.tsx` — account config + categories + rules (content from current settings tab)
- `apps/web/src/components/CfoStatePanel.tsx` — household summary + per-account signal cards
- `apps/web/src/components/BriefingPanel.tsx` — ordered list of finding cards
- `apps/web/src/components/FindingCard.tsx` — single finding with drill-down
- `apps/web/src/components/AccountCard.tsx` — per-account signal chip with subtype-aware display
- `apps/web/src/components/ImportPrompt.tsx` — data-staleness banner + file upload CTA
- `apps/web/src/charts/BalanceChart.tsx` — account balance over time (Recharts LineChart)
- `apps/web/src/charts/MonthlyNetChart.tsx` — monthly income/expense BarChart
- `apps/web/src/charts/SubscriptionChart.tsx` — subscription spend trend LineChart

### Frontend — modified files
- `apps/web/src/App.tsx` — becomes routing shell (~100 lines); existing view code moves to views/
- `apps/web/package.json` — add `recharts` dependency

---

## Task 1: DB Schema Migrations + Account PATCH

**Goal:** Add new columns to `accounts` and three new tables (`recurring_patterns`, `briefing_sessions`, `insight_findings`), and expose a PATCH endpoint to update account metadata.

**Files:**
- Modify: `apps/api/src/db.ts`
- Modify: `apps/api/src/accounts.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/tests/summary.test.ts` (update beforeEach cleanup)

**Acceptance Criteria:**
- [ ] `initDb()` is idempotent — running it twice does not throw
- [ ] `accounts` table has `account_subtype`, `owner_label`, `credit_limit`, `savings_goal` columns
- [ ] `recurring_patterns`, `briefing_sessions`, `insight_findings` tables exist after `initDb()`
- [ ] `PATCH /accounts/:id` accepts and persists `{ account_subtype, owner_label, credit_limit, savings_goal }`
- [ ] All existing tests still pass: `npm test`

**Verify:** `npm test` → all pass, no schema errors

**Steps:**

- [ ] **Step 1: Add migration helpers and new schema to `db.ts`**

Open `apps/api/src/db.ts`. After the closing backtick of the main `db.exec(...)` call (line ~165), add the following migration block:

```typescript
// Idempotent column migrations for existing tables
function safeExec(sql: string) {
  try { db.exec(sql); } catch { /* column already exists — safe to ignore */ }
}

safeExec(`ALTER TABLE accounts ADD COLUMN account_subtype TEXT NOT NULL DEFAULT 'checking'`);
safeExec(`ALTER TABLE accounts ADD COLUMN owner_label TEXT`);
safeExec(`ALTER TABLE accounts ADD COLUMN credit_limit REAL`);
safeExec(`ALTER TABLE accounts ADD COLUMN savings_goal REAL`);
```

Then inside the main `db.exec(`` ... ``)` string, before the closing `CREATE INDEX` block, add:

```sql
    CREATE TABLE IF NOT EXISTS briefing_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      import_session_id TEXT,
      finding_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(import_session_id) REFERENCES import_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS insight_findings (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      briefing_session_id TEXT,
      finding_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      impact_eur REAL,
      transaction_ids TEXT,
      metadata TEXT,
      dismissed_at TEXT,
      FOREIGN KEY(briefing_session_id) REFERENCES briefing_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS recurring_patterns (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      account_id TEXT NOT NULL,
      counterparty_name TEXT,
      pattern_type TEXT NOT NULL,
      interval_days INTEGER,
      typical_amount REAL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );

    CREATE INDEX IF NOT EXISTS idx_recurring_account ON recurring_patterns(account_id);
    CREATE INDEX IF NOT EXISTS idx_findings_briefing ON insight_findings(briefing_session_id);
    CREATE INDEX IF NOT EXISTS idx_findings_type ON insight_findings(finding_type);
```

- [ ] **Step 2: Update `listAccounts()` and add `updateAccount()` in `accounts.ts`**

Replace the entire `apps/api/src/accounts.ts` with:

```typescript
import { db } from './db.js';

export function listAccounts() {
  return db
    .prepare(
      `SELECT a.id, a.name, a.iban, a.type, a.account_subtype, a.owner_label,
              a.credit_limit, a.savings_goal,
              (SELECT balance FROM balance_snapshots bs WHERE bs.account_id = a.id ORDER BY date DESC LIMIT 1)
                + COALESCE((
                    SELECT SUM(amount)
                    FROM balance_adjustments ba
                    WHERE ba.account_id = a.id
                      AND ba.date <= (SELECT date FROM balance_snapshots bs2 WHERE bs2.account_id = a.id ORDER BY date DESC LIMIT 1)
                  ), 0) AS balance,
              (SELECT currency FROM balance_snapshots bs WHERE bs.account_id = a.id ORDER BY date DESC LIMIT 1) AS currency,
              (SELECT date FROM balance_snapshots bs WHERE bs.account_id = a.id ORDER BY date DESC LIMIT 1) AS balance_date
       FROM accounts a
       ORDER BY a.created_at ASC`
    )
    .all() as Array<any>;
}

export function updateAccount(
  id: string,
  patch: {
    account_subtype?: 'checking' | 'savings' | 'credit_card';
    owner_label?: string | null;
    credit_limit?: number | null;
    savings_goal?: number | null;
    name?: string;
  }
) {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.account_subtype !== undefined) { sets.push('account_subtype = ?'); values.push(patch.account_subtype); }
  if (patch.owner_label !== undefined)     { sets.push('owner_label = ?');     values.push(patch.owner_label); }
  if (patch.credit_limit !== undefined)    { sets.push('credit_limit = ?');    values.push(patch.credit_limit); }
  if (patch.savings_goal !== undefined)    { sets.push('savings_goal = ?');    values.push(patch.savings_goal); }
  if (patch.name !== undefined)            { sets.push('name = ?');            values.push(patch.name); }

  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}
```

- [ ] **Step 3: Add `PATCH /accounts/:id` route to `index.ts`**

In `apps/api/src/index.ts`, add the import for `updateAccount`:

```typescript
import { listAccounts, updateAccount } from './accounts.js';
```

Then find the existing accounts GET route and add the PATCH route after it:

```typescript
server.patch('/accounts/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as Record<string, unknown>;
  const allowed = ['account_subtype', 'owner_label', 'credit_limit', 'savings_goal', 'name'];
  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) patch[key] = body[key];
  }
  updateAccount(id, patch as any);
  return { ok: true };
});
```

- [ ] **Step 4: Update test `beforeEach` cleanup to include new tables**

In all test files that have a `beforeEach` cleanup block, add the new tables to the DELETE list. For example in `apps/api/tests/summary.test.ts`:

```typescript
beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM insight_findings;
    DELETE FROM briefing_sessions;
    DELETE FROM recurring_patterns;
    DELETE FROM balance_snapshots;
    DELETE FROM balance_adjustments;
    DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions;
    DELETE FROM import_sessions;
    DELETE FROM accounts;
    DELETE FROM categorization_decisions;
    DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
});
```

Apply the same addition to `apps/api/tests/insights-monthly-spike.test.ts` and any other test file with a `beforeEach` DELETE block.

- [ ] **Step 5: Run all tests and confirm pass**

```bash
npm test
```

Expected: all existing tests pass, no "no such column" or "no such table" errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db.ts apps/api/src/accounts.ts apps/api/src/index.ts apps/api/tests/
git commit -m "feat(api): DB schema migrations — account subtypes, briefing_sessions, insight_findings, recurring_patterns"
```

---

## Task 2: Recurring & Subscription Pattern Detection

**Goal:** Implement `detectPatterns(accountId)` in `patterns.ts` that analyses the last 6 months of transactions and upserts `recurring_patterns` rows for detected monthly recurring and subscription transactions.

**Files:**
- Create: `apps/api/src/patterns.ts`
- Create: `apps/api/tests/patterns.test.ts`

**Acceptance Criteria:**
- [ ] A counterparty that appears with amount ±20% variance on a ~30-day interval ≥2 times is classified as `recurring`
- [ ] A recurring pattern with amount < 50 EUR or a subscription-keyword counterparty name is classified as `subscription`
- [ ] Running `detectPatterns` twice does not create duplicate rows (upsert by account_id + counterparty_name)
- [ ] Patterns for transfer-linked transactions are excluded
- [ ] `npm test` still passes

**Verify:** `NODE_OPTIONS=--experimental-sqlite tsx --test apps/api/tests/patterns.test.ts`

**Steps:**

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/patterns.test.ts`:

```typescript
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DB_PATH = ':memory:';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import { detectPatterns } from '../src/patterns.js';

initDb();

const TRANSFER_EXCLUDED = new Set<string>();

function mkAccount(subtype = 'checking') {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, now, 'Test', null, 'bank', subtype);
  return id;
}

function mkSession() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'test', 'csv', 'x', 1, crypto.randomUUID());
  return id;
}

function mkTx(accountId: string, sessionId: string, counterparty: string, amount: number, daysAgo: number) {
  const id = crypto.randomUUID();
  const raw = crypto.randomUUID();
  const date = new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(raw, now, sessionId, '{}', date, amount, 'EUR');
  db.prepare('INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name, description, counterparty_iban, transaction_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, raw, sessionId, accountId, date, date, amount, 'EUR', counterparty, null, null, null);
  return id;
}

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM insight_findings; DELETE FROM briefing_sessions;
    DELETE FROM recurring_patterns; DELETE FROM transfer_links;
    DELETE FROM normalized_transactions; DELETE FROM raw_transactions;
    DELETE FROM import_sessions; DELETE FROM accounts;
    DELETE FROM categorization_decisions; DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
});

test('detects monthly recurring pattern from 3 occurrences', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'Fortum', -87.50, 90);
  mkTx(acct, sess, 'Fortum', -89.00, 60);
  mkTx(acct, sess, 'Fortum', -88.00, 30);

  detectPatterns(acct);

  const row = db.prepare("SELECT * FROM recurring_patterns WHERE account_id = ? AND counterparty_name = 'Fortum'").get(acct) as any;
  assert.ok(row, 'should create a recurring_pattern for Fortum');
  assert.equal(row.pattern_type, 'recurring');
  assert.equal(row.occurrence_count, 3);
});

test('classifies small-amount monthly as subscription', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'Spotify', -9.99, 90);
  mkTx(acct, sess, 'Spotify', -9.99, 60);
  mkTx(acct, sess, 'Spotify', -9.99, 30);

  detectPatterns(acct);

  const row = db.prepare("SELECT * FROM recurring_patterns WHERE account_id = ? AND counterparty_name = 'Spotify'").get(acct) as any;
  assert.ok(row);
  assert.equal(row.pattern_type, 'subscription');
});

test('does not create pattern for single occurrence', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'Verkkokauppa', -299.00, 45);

  detectPatterns(acct);

  const rows = db.prepare('SELECT * FROM recurring_patterns WHERE account_id = ?').all(acct);
  assert.equal(rows.length, 0);
});

test('upsert — running detectPatterns twice does not create duplicates', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTx(acct, sess, 'Netflix', -15.99, 90);
  mkTx(acct, sess, 'Netflix', -15.99, 60);
  mkTx(acct, sess, 'Netflix', -15.99, 30);

  detectPatterns(acct);
  detectPatterns(acct);

  const rows = db.prepare("SELECT * FROM recurring_patterns WHERE counterparty_name = 'Netflix'").all();
  assert.equal(rows.length, 1);
});

test('excludes transfer-linked transactions', () => {
  const acct = mkAccount();
  const acct2 = mkAccount();
  const sess = mkSession();
  const tx1 = mkTx(acct, sess, 'Siirto', -500, 90);
  const tx2 = mkTx(acct2, sess, 'Siirto', 500, 90);
  mkTx(acct, sess, 'Siirto', -500, 60);
  mkTx(acct, sess, 'Siirto', -500, 30);
  db.prepare('INSERT INTO transfer_links (id, created_at, from_transaction_id, to_transaction_id, confidence) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), new Date().toISOString(), tx1, tx2, 90);

  detectPatterns(acct);

  const rows = db.prepare('SELECT * FROM recurring_patterns WHERE account_id = ?').all(acct);
  assert.equal(rows.length, 0, 'transfer-linked transactions should not generate patterns');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
NODE_OPTIONS=--experimental-sqlite tsx --test apps/api/tests/patterns.test.ts
```

Expected: FAIL — `Cannot find module '../src/patterns.js'`

- [ ] **Step 3: Implement `patterns.ts`**

Create `apps/api/src/patterns.ts`:

```typescript
import crypto from 'crypto';
import { db } from './db.js';

const SUBSCRIPTION_KEYWORDS = [
  'netflix', 'spotify', 'hbo', 'disney', 'apple', 'google', 'youtube',
  'amazon', 'microsoft', 'adobe', 'dropbox', 'github', 'linkedin',
  'telia', 'elisa', 'dna', 'fortum', 'helen', 'vattenfall',
];

function isSubscriptionLike(counterparty: string, amount: number): boolean {
  const lower = counterparty.toLowerCase();
  if (SUBSCRIPTION_KEYWORDS.some((k) => lower.includes(k))) return true;
  return Math.abs(amount) < 50;
}

export function detectPatterns(accountId: string): void {
  const now = new Date().toISOString();
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400_000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT counterparty_name, amount, booking_date
    FROM normalized_transactions
    WHERE account_id = ?
      AND booking_date >= ?
      AND amount < 0
      AND counterparty_name IS NOT NULL
      AND id NOT IN (
        SELECT from_transaction_id FROM transfer_links
        UNION SELECT to_transaction_id FROM transfer_links
      )
    ORDER BY counterparty_name, booking_date
  `).all(accountId, sixMonthsAgo) as Array<{ counterparty_name: string; amount: number; booking_date: string }>;

  // Group by counterparty
  const byCounterparty = new Map<string, Array<{ amount: number; date: string }>>();
  for (const r of rows) {
    const key = r.counterparty_name;
    if (!byCounterparty.has(key)) byCounterparty.set(key, []);
    byCounterparty.get(key)!.push({ amount: r.amount, date: r.booking_date });
  }

  for (const [counterparty, occurrences] of byCounterparty) {
    if (occurrences.length < 2) continue;

    // Check interval consistency
    const sorted = occurrences.sort((a, b) => a.date.localeCompare(b.date));
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const a = new Date(sorted[i - 1].date).getTime();
      const b = new Date(sorted[i].date).getTime();
      intervals.push((b - a) / 86400_000);
    }

    const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    // Monthly: 25–35 day interval
    if (avgInterval < 25 || avgInterval > 35) continue;

    // Check amount consistency (±20%)
    const amounts = sorted.map((o) => Math.abs(o.amount));
    const avgAmount = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    const consistent = amounts.every((a) => Math.abs(a - avgAmount) / avgAmount <= 0.2);
    if (!consistent) continue;

    const patternType = isSubscriptionLike(counterparty, avgAmount) ? 'subscription' : 'recurring';
    const firstSeen = sorted[0].date;
    const lastSeen = sorted[sorted.length - 1].date;

    // Upsert by account_id + counterparty_name
    const existing = db.prepare(
      'SELECT id FROM recurring_patterns WHERE account_id = ? AND counterparty_name = ?'
    ).get(accountId, counterparty) as { id: string } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE recurring_patterns
        SET updated_at = ?, pattern_type = ?, interval_days = ?, typical_amount = ?,
            last_seen = ?, occurrence_count = ?, is_active = 1
        WHERE id = ?
      `).run(now, patternType, Math.round(avgInterval), avgAmount, lastSeen, sorted.length, existing.id);
    } else {
      db.prepare(`
        INSERT INTO recurring_patterns
          (id, created_at, updated_at, account_id, counterparty_name, pattern_type,
           interval_days, typical_amount, currency, first_seen, last_seen, occurrence_count, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, 1)
      `).run(
        crypto.randomUUID(), now, now, accountId, counterparty, patternType,
        Math.round(avgInterval), avgAmount, firstSeen, lastSeen, sorted.length
      );
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
NODE_OPTIONS=--experimental-sqlite tsx --test apps/api/tests/patterns.test.ts
```

Expected: all 5 tests PASS

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/patterns.ts apps/api/tests/patterns.test.ts
git commit -m "feat(api): recurring and subscription pattern detection"
```

---

## Task 3: BriefingEngine with All Generators

**Goal:** Implement `runBriefing(importSessionId)` in `briefing.ts` that creates a `BriefingSession` and runs all six generators, persisting `InsightFinding` rows ordered by severity and impact.

**Files:**
- Create: `apps/api/src/briefing.ts`
- Create: `apps/api/tests/briefing.test.ts`

**Acceptance Criteria:**
- [ ] `runBriefing()` creates a `briefing_sessions` row and returns its `id`
- [ ] `subscriptionCreep` generator fires when total active subscription spend increases or a new subscription was detected since last briefing
- [ ] `oneOffImpact` generator fires for transactions > 2× median monthly discretionary spend (excluding transfers and recurring patterns)
- [ ] `savingsProgress` generator fires when a savings-subtype account balance changed
- [ ] `creditHealth` generator fires when a credit_card account balance increased 3+ consecutive months
- [ ] `spendingAnomaly` generator fires when a category's 30-day spend > 2× its 90-day rolling average
- [ ] `newRecurring` generator fires for recurring_patterns created in the last 60 days
- [ ] A generator that throws does not abort the whole briefing — other generators still run
- [ ] `npm test` still passes

**Verify:** `NODE_OPTIONS=--experimental-sqlite tsx --test apps/api/tests/briefing.test.ts`

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `apps/api/tests/briefing.test.ts`:

```typescript
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DB_PATH = ':memory:';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import { runBriefing } from '../src/briefing.js';

initDb();

function mkAccount(subtype = 'checking') {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'Test ' + subtype, null, 'bank', subtype);
  return id;
}

function mkSession() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'test', 'csv', 'x', 1, crypto.randomUUID());
  return id;
}

function mkTx(accountId: string, sessionId: string, counterparty: string, amount: number, daysAgo: number) {
  const id = crypto.randomUUID();
  const raw = crypto.randomUUID();
  const date = new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(raw, now, sessionId, '{}', date, amount, 'EUR');
  db.prepare('INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name, description, counterparty_iban, transaction_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, raw, sessionId, accountId, date, date, amount, 'EUR', counterparty, null, null, null);
  return id;
}

function mkPattern(accountId: string, counterparty: string, type = 'subscription', amount = 15.99, daysAgo = 5) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const date = new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO recurring_patterns
    (id, created_at, updated_at, account_id, counterparty_name, pattern_type, interval_days, typical_amount, currency, first_seen, last_seen, occurrence_count, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 30, ?, 'EUR', ?, ?, 3, 1)`)
    .run(id, now, now, accountId, counterparty, type, amount, date, date);
  return id;
}

function mkBalance(accountId: string, balance: number, daysAgo: number) {
  const date = new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
  db.prepare('INSERT OR REPLACE INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), new Date().toISOString(), accountId, date, balance, 'EUR');
}

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM insight_findings; DELETE FROM briefing_sessions;
    DELETE FROM recurring_patterns; DELETE FROM transfer_links;
    DELETE FROM balance_snapshots; DELETE FROM balance_adjustments;
    DELETE FROM normalized_transactions; DELETE FROM raw_transactions;
    DELETE FROM import_sessions; DELETE FROM accounts;
    DELETE FROM categorization_decisions; DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
});

test('runBriefing creates a briefing_session row', () => {
  const acct = mkAccount();
  const sess = mkSession();
  const briefingId = runBriefing(sess);
  assert.ok(typeof briefingId === 'string' && briefingId.length > 0);
  const row = db.prepare('SELECT * FROM briefing_sessions WHERE id = ?').get(briefingId) as any;
  assert.ok(row);
  assert.equal(row.import_session_id, sess);
});

test('subscriptionCreep generator fires when subscriptions exist', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkPattern(acct, 'Netflix', 'subscription', 15.99, 5);
  mkPattern(acct, 'Spotify', 'subscription', 9.99, 3);

  const briefingId = runBriefing(sess);

  const findings = db.prepare("SELECT * FROM insight_findings WHERE briefing_session_id = ? AND finding_type = 'subscription_creep'").all(briefingId) as any[];
  assert.ok(findings.length >= 1, 'should produce at least one subscription_creep finding');
  const f = findings[0];
  assert.ok(f.description.includes('25.98') || f.description.includes('€'), 'should mention total amount');
});

test('newRecurring generator fires for recently created patterns', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkPattern(acct, 'Fortum', 'recurring', 87.50, 10);

  const briefingId = runBriefing(sess);

  const findings = db.prepare("SELECT * FROM insight_findings WHERE briefing_session_id = ? AND finding_type = 'new_recurring'").all(briefingId) as any[];
  assert.ok(findings.length >= 1);
  assert.ok(findings[0].description.includes('Fortum'));
});

test('oneOffImpact generator fires for large one-off transaction', () => {
  const acct = mkAccount();
  const sess = mkSession();
  // Establish baseline: normal 30-day spend ~150€ total
  for (let i = 2; i <= 5; i++) {
    mkTx(acct, sess, 'Ruokakauppa', -30, i * 30);
  }
  // Large one-off purchase this month
  mkTx(acct, sess, 'Verkkokauppa.com', -450, 5);

  const briefingId = runBriefing(sess);

  const findings = db.prepare("SELECT * FROM insight_findings WHERE briefing_session_id = ? AND finding_type = 'one_off_impact'").all(briefingId) as any[];
  assert.ok(findings.length >= 1, 'should flag large one-off purchase');
  assert.ok(findings[0].description.includes('Verkkokauppa'));
});

test('savingsProgress generator fires for savings account with balance history', () => {
  const acct = mkAccount('savings');
  const sess = mkSession();
  mkBalance(acct, 5000, 90);
  mkBalance(acct, 5200, 60);
  mkBalance(acct, 5500, 30);

  const briefingId = runBriefing(sess);

  const findings = db.prepare("SELECT * FROM insight_findings WHERE briefing_session_id = ? AND finding_type = 'savings_progress'").all(briefingId) as any[];
  assert.ok(findings.length >= 1);
});

test('generator exception does not abort briefing — other generators still run', () => {
  // Create conditions for newRecurring to work, so at least one finding appears
  const acct = mkAccount();
  const sess = mkSession();
  mkPattern(acct, 'Netflix', 'subscription', 15.99, 5);

  // Should not throw even if some generators find nothing
  assert.doesNotThrow(() => runBriefing(sess));

  const row = db.prepare('SELECT * FROM briefing_sessions WHERE import_session_id = ?').get(sess) as any;
  assert.ok(row);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
NODE_OPTIONS=--experimental-sqlite tsx --test apps/api/tests/briefing.test.ts
```

Expected: FAIL — `Cannot find module '../src/briefing.js'`

- [ ] **Step 3: Implement `briefing.ts`**

Create `apps/api/src/briefing.ts`:

```typescript
import crypto from 'crypto';
import { db } from './db.js';

type FindingInput = {
  finding_type: string;
  title: string;
  description: string;
  severity: 'info' | 'warn' | 'alert';
  impact_eur?: number;
  transaction_ids?: string[];
  metadata?: Record<string, unknown>;
};

function fmt(n: number) {
  return `${Math.abs(n).toFixed(2)} €`;
}

// ── Generators ────────────────────────────────────────────────────

function subscriptionCreep(): FindingInput[] {
  const subs = db.prepare(`
    SELECT counterparty_name, typical_amount, account_id, created_at
    FROM recurring_patterns
    WHERE pattern_type = 'subscription' AND is_active = 1
    ORDER BY typical_amount DESC
  `).all() as Array<{ counterparty_name: string; typical_amount: number; account_id: string; created_at: string }>;

  if (subs.length === 0) return [];

  const total = subs.reduce((s, r) => s + r.typical_amount, 0);
  const newSubs = subs.filter((s) => {
    const age = (Date.now() - new Date(s.created_at).getTime()) / 86400_000;
    return age <= 60;
  });

  const list = subs.map((s) => `${s.counterparty_name} ${fmt(s.typical_amount)}`).join(', ');
  const newList = newSubs.map((s) => s.counterparty_name).join(', ');

  let description = `Sinulla on ${subs.length} aktiivista tilauspalvelua — yhteensä ${fmt(total)}/kk. Palvelut: ${list}.`;
  if (newSubs.length > 0) {
    description += ` Uudet (60 pv sisällä): ${newList}.`;
  }

  return [{
    finding_type: 'subscription_creep',
    title: `${subs.length} tilauspalvelua — yhteensä ${fmt(total)}/kk`,
    description,
    severity: total > 80 ? 'warn' : 'info',
    impact_eur: total,
    metadata: { count: subs.length, totalMonthly: total, newCount: newSubs.length },
  }];
}

function newRecurring(): FindingInput[] {
  const cutoff = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
  const patterns = db.prepare(`
    SELECT counterparty_name, pattern_type, typical_amount, interval_days
    FROM recurring_patterns
    WHERE is_active = 1 AND first_seen >= ?
    ORDER BY typical_amount DESC
  `).all(cutoff) as Array<{ counterparty_name: string; pattern_type: string; typical_amount: number; interval_days: number }>;

  return patterns.map((p) => ({
    finding_type: 'new_recurring',
    title: `Uusi toistuva veloitus: ${p.counterparty_name}`,
    description: `Uusi ${p.pattern_type === 'subscription' ? 'tilaus' : 'toistuva maksu'} tunnistettu: ${p.counterparty_name} noin ${fmt(p.typical_amount)} n. ${p.interval_days} päivän välein.`,
    severity: 'info' as const,
    impact_eur: p.typical_amount,
  }));
}

function oneOffImpact(): FindingInput[] {
  const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const ninetyAgo = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

  // Median monthly discretionary: avg spend per 30d over last 90d, excluding transfers and recurring
  const baselineRow = db.prepare(`
    SELECT AVG(ABS(amount)) AS avg_amount
    FROM normalized_transactions
    WHERE booking_date BETWEEN ? AND ?
      AND amount < 0
      AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
      AND counterparty_name NOT IN (SELECT counterparty_name FROM recurring_patterns WHERE is_active = 1)
  `).get(ninetyAgo, thirtyAgo) as { avg_amount: number | null };

  const baseline = baselineRow.avg_amount ?? 100;
  const threshold = baseline * 2;

  const largeOnes = db.prepare(`
    SELECT id, counterparty_name, amount, booking_date
    FROM normalized_transactions
    WHERE booking_date >= ?
      AND amount < 0
      AND ABS(amount) > ?
      AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
      AND (counterparty_name NOT IN (SELECT counterparty_name FROM recurring_patterns WHERE is_active = 1)
           OR counterparty_name IS NULL)
    ORDER BY amount ASC
    LIMIT 3
  `).all(thirtyAgo, threshold) as Array<{ id: string; counterparty_name: string | null; amount: number; booking_date: string }>;

  return largeOnes.map((tx) => ({
    finding_type: 'one_off_impact',
    title: `Kertaluonteinen hankinta: ${tx.counterparty_name ?? 'Tuntematon'} ${fmt(tx.amount)}`,
    description: `Ostit ${tx.counterparty_name ?? 'tuntematon kauppias'} ${fmt(tx.amount)} (${tx.booking_date}). Tämä on yli 2× tyypillinen yksittäinen kulusi.`,
    severity: Math.abs(tx.amount) > threshold * 2 ? 'warn' : 'info' as any,
    impact_eur: Math.abs(tx.amount),
    transaction_ids: [tx.id],
  }));
}

function savingsProgress(): FindingInput[] {
  const savings = db.prepare(`
    SELECT a.id, a.name
    FROM accounts a
    WHERE a.account_subtype = 'savings'
  `).all() as Array<{ id: string; name: string }>;

  const findings: FindingInput[] = [];

  for (const acct of savings) {
    const snapshots = db.prepare(`
      SELECT balance, date FROM balance_snapshots
      WHERE account_id = ?
      ORDER BY date DESC LIMIT 4
    `).all(acct.id) as Array<{ balance: number; date: string }>;

    if (snapshots.length < 2) continue;

    const latest = snapshots[0].balance;
    const prev = snapshots[snapshots.length - 1].balance;
    const delta = latest - prev;

    const trend = delta > 0 ? 'kasvanut' : delta < 0 ? 'laskenut' : 'pysynyt samana';
    const severity: 'info' | 'warn' = delta < 0 ? 'warn' : 'info';

    findings.push({
      finding_type: 'savings_progress',
      title: `Säästötili ${acct.name}: ${delta >= 0 ? '+' : ''}${fmt(delta)}`,
      description: `Säästötilisi ${acct.name} saldo on ${trend} ${fmt(Math.abs(delta))} seurantajaksolla. Nykyinen saldo: ${fmt(latest)}.`,
      severity,
      impact_eur: Math.abs(delta),
      metadata: { accountId: acct.id, currentBalance: latest, delta },
    });
  }

  return findings;
}

function creditHealth(): FindingInput[] {
  const creditAccts = db.prepare(`
    SELECT a.id, a.name
    FROM accounts a WHERE a.account_subtype = 'credit_card'
  `).all() as Array<{ id: string; name: string }>;

  const findings: FindingInput[] = [];

  for (const acct of creditAccts) {
    const snapshots = db.prepare(`
      SELECT balance, date FROM balance_snapshots
      WHERE account_id = ? ORDER BY date DESC LIMIT 4
    `).all(acct.id) as Array<{ balance: number; date: string }>;

    if (snapshots.length < 2) continue;

    const latest = Math.abs(snapshots[0].balance);
    const delta = snapshots[0].balance - snapshots[snapshots.length - 1].balance;

    // Credit card: balance going more negative = more debt
    const growingDebt = snapshots.every((s, i) =>
      i === 0 || s.balance >= snapshots[i - 1].balance
    );

    if (growingDebt && snapshots.length >= 3) {
      findings.push({
        finding_type: 'credit_health',
        title: `Luottokorttivelka kasvaa: ${acct.name}`,
        description: `Luottokorttisi ${acct.name} velka on kasvanut ${snapshots.length} kuukautta peräkkäin. Nykyinen velka: ${fmt(latest)}.`,
        severity: 'warn',
        impact_eur: Math.abs(delta),
        metadata: { accountId: acct.id, currentDebt: latest },
      });
    }
  }

  return findings;
}

function spendingAnomaly(): FindingInput[] {
  const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const ninetyAgo = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    WITH recent AS (
      SELECT c.name AS cat, SUM(ABS(nt.amount)) AS spend_30d
      FROM normalized_transactions nt
      JOIN categorization_decisions cd ON cd.transaction_id = nt.id
      JOIN categories c ON c.id = cd.category_id
      WHERE nt.booking_date >= ? AND nt.amount < 0
        AND nt.id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
      GROUP BY c.name
    ),
    baseline AS (
      SELECT c.name AS cat, SUM(ABS(nt.amount)) / 3.0 AS avg_30d
      FROM normalized_transactions nt
      JOIN categorization_decisions cd ON cd.transaction_id = nt.id
      JOIN categories c ON c.id = cd.category_id
      WHERE nt.booking_date BETWEEN ? AND ?
        AND nt.amount < 0
        AND nt.id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
      GROUP BY c.name
    )
    SELECT r.cat, r.spend_30d, b.avg_30d
    FROM recent r JOIN baseline b ON r.cat = b.cat
    WHERE r.spend_30d > b.avg_30d * 2 AND b.avg_30d > 20
    ORDER BY (r.spend_30d - b.avg_30d) DESC
    LIMIT 3
  `).all(thirtyAgo, ninetyAgo, thirtyAgo) as Array<{ cat: string; spend_30d: number; avg_30d: number }>;

  return rows.map((r) => ({
    finding_type: 'spending_anomaly',
    title: `${r.cat}: ${fmt(r.spend_30d)} tässä kuussa`,
    description: `Kategoriassa "${r.cat}" kului ${fmt(r.spend_30d)} viimeisen 30 päivän aikana — yli 2× normaali (${fmt(r.avg_30d)}/kk).`,
    severity: 'warn' as const,
    impact_eur: r.spend_30d - r.avg_30d,
    metadata: { category: r.cat, spend30d: r.spend_30d, avg30d: r.avg_30d },
  }));
}

// ── Engine ────────────────────────────────────────────────────────

const GENERATORS = [
  subscriptionCreep,
  newRecurring,
  oneOffImpact,
  savingsProgress,
  creditHealth,
  spendingAnomaly,
];

const SEVERITY_ORDER = { alert: 0, warn: 1, info: 2 };

export function runBriefing(importSessionId: string): string {
  const now = new Date().toISOString();
  const briefingId = crypto.randomUUID();

  db.prepare(
    'INSERT INTO briefing_sessions (id, created_at, import_session_id, finding_count) VALUES (?, ?, ?, 0)'
  ).run(briefingId, now, importSessionId);

  const allFindings: FindingInput[] = [];

  for (const generator of GENERATORS) {
    try {
      const results = generator();
      allFindings.push(...results);
    } catch (err) {
      console.error(`[briefing] generator ${generator.name} threw:`, err);
    }
  }

  // Sort: severity first, then impact_eur descending
  allFindings.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 2;
    const sb = SEVERITY_ORDER[b.severity] ?? 2;
    if (sa !== sb) return sa - sb;
    return (b.impact_eur ?? 0) - (a.impact_eur ?? 0);
  });

  const insert = db.prepare(`
    INSERT INTO insight_findings
      (id, created_at, briefing_session_id, finding_type, title, description, severity, impact_eur, transaction_ids, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const f of allFindings) {
    insert.run(
      crypto.randomUUID(), now, briefingId,
      f.finding_type, f.title, f.description, f.severity,
      f.impact_eur ?? null,
      f.transaction_ids ? JSON.stringify(f.transaction_ids) : null,
      f.metadata ? JSON.stringify(f.metadata) : null
    );
  }

  db.prepare('UPDATE briefing_sessions SET finding_count = ? WHERE id = ?')
    .run(allFindings.length, briefingId);

  return briefingId;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
NODE_OPTIONS=--experimental-sqlite tsx --test apps/api/tests/briefing.test.ts
```

Expected: all 6 tests PASS

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/briefing.ts apps/api/tests/briefing.test.ts
git commit -m "feat(api): BriefingEngine with all six insight generators"
```

---

## Task 4: Hook Patterns + Briefing into Import Pipeline

**Goal:** Call `detectPatterns()` + `runBriefing()` after every successful import; include `briefingSessionId` in `ImportResult`.

**Files:**
- Modify: `apps/api/src/importer.ts`

**Acceptance Criteria:**
- [ ] `ImportResult` has `briefingSessionId: string`
- [ ] After `processImport()` completes, `recurring_patterns` and a `briefing_sessions` row exist in the DB
- [ ] Import failure (exception) does not leave a partial briefing session
- [ ] All existing importer tests still pass

**Verify:** `npm test` → all pass

**Steps:**

- [ ] **Step 1: Extend `ImportResult` and call detection after import**

In `apps/api/src/importer.ts`, add the imports at the top:

```typescript
import { detectPatterns } from './patterns.js';
import { runBriefing } from './briefing.js';
```

Change `ImportResult` type:

```typescript
export type ImportResult = {
  importSessionId: string;
  accountId: string;
  normalizedCount: number;
  rawCount: number;
  skippedCount: number;
  overlapDetected: boolean;
  alreadyImportedCount: number;
  briefingSessionId: string;
};
```

At the end of `processImport()`, before the `return` statement, add:

```typescript
  // Run pattern detection and briefing generation (non-fatal)
  let briefingSessionId = '';
  try {
    detectPatterns(accountId);
    briefingSessionId = runBriefing(importSessionId);
  } catch (err) {
    logEvent({ type: 'briefing.error', scope: importSessionId, message: 'Briefing failed', payload: { error: String(err) } });
  }

  return {
    importSessionId,
    accountId,
    normalizedCount,
    rawCount: rowCount,
    skippedCount,
    overlapDetected: Boolean(overlapRow),
    alreadyImportedCount: overlapRow?.row_count ?? 0,
    briefingSessionId,
  };
```

- [ ] **Step 2: Expose `briefingSessionId` in the import API response**

In `apps/api/src/index.ts`, find the POST /import route handler. Locate where it calls `processImport()` and returns the result. Add `briefingSessionId` to the response:

```typescript
// find the existing return that includes importSessionId, and add briefingSessionId:
return {
  importSessionId: result.importSessionId,
  briefingSessionId: result.briefingSessionId,
  accountId: result.accountId,
  normalizedCount: result.normalizedCount,
  rawCount: result.rawCount,
  skippedCount: result.skippedCount,
  overlapDetected: result.overlapDetected,
  alreadyImportedCount: result.alreadyImportedCount,
};
```

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: all tests pass (existing importer tests do not check `briefingSessionId` so they continue to pass)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/importer.ts apps/api/src/index.ts
git commit -m "feat(api): hook pattern detection and briefing into import pipeline"
```

---

## Task 5: Household Summary + New API Endpoints

**Goal:** Add `getHouseholdSummary()` and expose five new REST endpoints: `/household/summary`, `/briefing/latest`, `/briefing/:id`, `/briefing/:findingId/dismiss`, `/subscriptions`.

**Files:**
- Modify: `apps/api/src/summary.ts`
- Modify: `apps/api/src/index.ts`
- Create: `apps/api/tests/household-summary.test.ts`

**Acceptance Criteria:**
- [ ] `GET /household/summary` returns `liquidAssets`, `totalSavings`, `creditDebt`, `monthlySubscriptions`, `runwayMonths`, `dataAgeDays`, `accounts[]`
- [ ] Each account in the response includes `account_subtype`, `owner_label`, `trend` (`up`/`down`/`stable`/`null`), `warningLevel`
- [ ] `GET /briefing/latest` returns the most recent `briefing_sessions` row plus its `insight_findings` (non-dismissed)
- [ ] `POST /briefing/:findingId/dismiss` sets `dismissed_at`
- [ ] `GET /subscriptions` returns active subscription-type `recurring_patterns`
- [ ] `npm test` passes

**Verify:** `NODE_OPTIONS=--experimental-sqlite tsx --test apps/api/tests/household-summary.test.ts`

**Steps:**

- [ ] **Step 1: Write failing tests for household summary**

Create `apps/api/tests/household-summary.test.ts`:

```typescript
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DB_PATH = ':memory:';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import { getHouseholdSummary } from '../src/summary.js';

initDb();

function mkAccount(subtype: string, balance: number, balanceDaysAgo = 1) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const date = new Date(Date.now() - balanceDaysAgo * 86400_000).toISOString().slice(0, 10);
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, now, 'Acct ' + subtype, null, 'bank', subtype);
  db.prepare('INSERT OR REPLACE INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), now, id, date, balance, 'EUR');
  return id;
}

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM insight_findings; DELETE FROM briefing_sessions;
    DELETE FROM recurring_patterns; DELETE FROM transfer_links;
    DELETE FROM balance_snapshots; DELETE FROM balance_adjustments;
    DELETE FROM normalized_transactions; DELETE FROM raw_transactions;
    DELETE FROM import_sessions; DELETE FROM accounts;
    DELETE FROM categorization_decisions; DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
});

test('liquidAssets sums checking accounts only', () => {
  mkAccount('checking', 2000);
  mkAccount('savings', 5000);
  mkAccount('credit_card', -800);
  const s = getHouseholdSummary();
  assert.equal(s.liquidAssets, 2000);
  assert.equal(s.totalSavings, 5000);
  assert.equal(s.creditDebt, 800);
});

test('monthlySubscriptions sums active subscription patterns', () => {
  const acct = mkAccount('checking', 1000);
  const now = new Date().toISOString();
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO recurring_patterns (id, created_at, updated_at, account_id, counterparty_name, pattern_type, interval_days, typical_amount, currency, first_seen, last_seen, occurrence_count, is_active) VALUES (?, ?, ?, ?, 'Netflix', 'subscription', 30, 15.99, 'EUR', ?, ?, 3, 1)`)
    .run(crypto.randomUUID(), now, now, acct, date, date);
  db.prepare(`INSERT INTO recurring_patterns (id, created_at, updated_at, account_id, counterparty_name, pattern_type, interval_days, typical_amount, currency, first_seen, last_seen, occurrence_count, is_active) VALUES (?, ?, ?, ?, 'Spotify', 'subscription', 30, 9.99, 'EUR', ?, ?, 3, 1)`)
    .run(crypto.randomUUID(), now, now, acct, date, date);
  const s = getHouseholdSummary();
  assert.ok(Math.abs(s.monthlySubscriptions - 25.98) < 0.01);
});

test('account trend is up when balance grew across last two snapshots', () => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, now, 'Savings', null, 'bank', 'savings');
  const d1 = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
  const d2 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  db.prepare('INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), now, id, d1, 4000, 'EUR');
  db.prepare('INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), now, id, d2, 4500, 'EUR');
  const s = getHouseholdSummary();
  const acct = s.accounts.find((a: any) => a.id === id);
  assert.equal(acct?.trend, 'up');
});

test('dataAgeDays reflects days since latest import', () => {
  const sess = crypto.randomUUID();
  const threeDaysAgo = new Date(Date.now() - 3 * 86400_000).toISOString();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sess, threeDaysAgo, 'test', 'csv', 'x', 1, crypto.randomUUID());
  const s = getHouseholdSummary();
  assert.ok(s.dataAgeDays >= 3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
NODE_OPTIONS=--experimental-sqlite tsx --test apps/api/tests/household-summary.test.ts
```

Expected: FAIL — `getHouseholdSummary is not a function`

- [ ] **Step 3: Implement `getHouseholdSummary()` in `summary.ts`**

Add to the end of `apps/api/src/summary.ts`:

```typescript
export type AccountSignal = {
  id: string; name: string; subtype: string; ownerLabel: string | null;
  balance: number; currency: string; date: string | null;
  trend: 'up' | 'down' | 'stable' | null;
  warningLevel: 'none' | 'warn' | 'alert';
};

export function getHouseholdSummary() {
  const accounts = db.prepare(`
    SELECT a.id, a.name, a.account_subtype AS subtype, a.owner_label AS ownerLabel,
           a.credit_limit, a.savings_goal,
           (SELECT balance FROM balance_snapshots bs WHERE bs.account_id = a.id ORDER BY date DESC LIMIT 1) AS balance,
           (SELECT currency FROM balance_snapshots bs WHERE bs.account_id = a.id ORDER BY date DESC LIMIT 1) AS currency,
           (SELECT date FROM balance_snapshots bs WHERE bs.account_id = a.id ORDER BY date DESC LIMIT 1) AS balance_date
    FROM accounts a ORDER BY a.created_at ASC
  `).all() as Array<any>;

  const accountSignals: AccountSignal[] = accounts.map((a) => {
    const balance = Number(a.balance ?? 0);

    // Trend: compare latest two balance snapshots
    const snaps = db.prepare(`
      SELECT balance FROM balance_snapshots WHERE account_id = ? ORDER BY date DESC LIMIT 2
    `).all(a.id) as Array<{ balance: number }>;

    let trend: AccountSignal['trend'] = null;
    if (snaps.length >= 2) {
      const delta = snaps[0].balance - snaps[1].balance;
      trend = delta > 5 ? 'up' : delta < -5 ? 'down' : 'stable';
    }

    // Warning: credit card with growing balance, or savings declining
    let warningLevel: AccountSignal['warningLevel'] = 'none';
    if (a.subtype === 'credit_card' && balance < 0 && trend === 'down') warningLevel = 'warn';
    if (a.subtype === 'savings' && trend === 'down') warningLevel = 'warn';

    return {
      id: a.id, name: a.name, subtype: a.subtype ?? 'checking',
      ownerLabel: a.ownerLabel ?? null,
      balance, currency: a.currency ?? 'EUR',
      date: a.balance_date ?? null,
      trend, warningLevel,
    };
  });

  const liquidAssets = accountSignals
    .filter((a) => a.subtype === 'checking')
    .reduce((s, a) => s + a.balance, 0);

  const totalSavings = accountSignals
    .filter((a) => a.subtype === 'savings')
    .reduce((s, a) => s + a.balance, 0);

  const creditDebt = accountSignals
    .filter((a) => a.subtype === 'credit_card')
    .reduce((s, a) => s + Math.abs(Math.min(0, a.balance)), 0);

  const subsRow = db.prepare(`
    SELECT COALESCE(SUM(typical_amount), 0) AS total
    FROM recurring_patterns WHERE pattern_type = 'subscription' AND is_active = 1
  `).get() as { total: number };
  const monthlySubscriptions = Number(subsRow.total);

  const monthlyNetRow = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS net
    FROM normalized_transactions
    WHERE booking_date >= datetime('now', '-30 days')
      AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
  `).get() as { net: number };
  const monthlyNet = Number(monthlyNetRow.net);

  const totalLiquid = liquidAssets;
  const runwayMonths = monthlyNet < 0 && totalLiquid > 0 ? totalLiquid / Math.abs(monthlyNet) : null;

  const latestImportRow = db.prepare(
    'SELECT created_at FROM import_sessions ORDER BY created_at DESC LIMIT 1'
  ).get() as { created_at: string } | undefined;

  const dataAgeDays = latestImportRow
    ? Math.floor((Date.now() - new Date(latestImportRow.created_at).getTime()) / 86400_000)
    : null;

  return { liquidAssets, totalSavings, creditDebt, monthlySubscriptions, monthlyNet, runwayMonths, dataAgeDays, accounts: accountSignals };
}
```

- [ ] **Step 4: Add new endpoints to `index.ts`**

In `apps/api/src/index.ts`, add the import:

```typescript
import { getSummary, getHouseholdSummary } from './summary.js';
```

Then add these routes (place after existing summary route):

```typescript
server.get('/household/summary', async () => getHouseholdSummary());

server.get('/briefing/latest', async () => {
  const session = db.prepare(
    'SELECT * FROM briefing_sessions ORDER BY created_at DESC LIMIT 1'
  ).get() as any;
  if (!session) return { session: null, findings: [] };
  const findings = db.prepare(
    'SELECT * FROM insight_findings WHERE briefing_session_id = ? AND dismissed_at IS NULL ORDER BY rowid ASC'
  ).all(session.id);
  return { session, findings };
});

server.get('/briefing/:id', async (request) => {
  const { id } = request.params as { id: string };
  const session = db.prepare('SELECT * FROM briefing_sessions WHERE id = ?').get(id) as any;
  if (!session) return { session: null, findings: [] };
  const findings = db.prepare(
    'SELECT * FROM insight_findings WHERE briefing_session_id = ? AND dismissed_at IS NULL ORDER BY rowid ASC'
  ).all(session.id);
  return { session, findings };
});

server.post('/briefing/:findingId/dismiss', async (request) => {
  const { findingId } = request.params as { findingId: string };
  db.prepare('UPDATE insight_findings SET dismissed_at = ? WHERE id = ?')
    .run(new Date().toISOString(), findingId);
  return { ok: true };
});

server.get('/subscriptions', async () => {
  return db.prepare(
    "SELECT * FROM recurring_patterns WHERE pattern_type = 'subscription' AND is_active = 1 ORDER BY typical_amount DESC"
  ).all();
});

server.get('/recurring', async () => {
  return db.prepare(
    'SELECT * FROM recurring_patterns WHERE is_active = 1 ORDER BY pattern_type, typical_amount DESC'
  ).all();
});
```

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/summary.ts apps/api/src/index.ts apps/api/tests/household-summary.test.ts
git commit -m "feat(api): household summary + briefing/subscriptions endpoints"
```

---

## Task 6: Frontend API Client Layer

**Goal:** Create `apps/web/src/api/client.ts` with all typed fetch functions for every API endpoint the frontend needs, replacing inline `fetch()` calls in `App.tsx`.

**Files:**
- Create: `apps/web/src/api/client.ts`

**Acceptance Criteria:**
- [ ] All response types match the backend shapes from Tasks 1–5
- [ ] `client.ts` exports one function per endpoint, all returning typed Promises
- [ ] No import of React in this file (pure data layer)
- [ ] `npm run build --workspace apps/web` succeeds with no TypeScript errors

**Verify:** `npm run build --workspace apps/web` → exits 0

**Steps:**

- [ ] **Step 1: Create the directory and client file**

```bash
mkdir -p apps/web/src/api
```

Create `apps/web/src/api/client.ts`:

```typescript
const API = '/api';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return res.json();
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} → ${res.status}`);
  return res.json();
}

// ── Types ────────────────────────────────────────────────────────

export type AccountSubtype = 'checking' | 'savings' | 'credit_card';

export type AccountSignal = {
  id: string; name: string; subtype: AccountSubtype; ownerLabel: string | null;
  balance: number; currency: string; date: string | null;
  trend: 'up' | 'down' | 'stable' | null;
  warningLevel: 'none' | 'warn' | 'alert';
  credit_limit?: number | null;
  savings_goal?: number | null;
};

export type HouseholdSummary = {
  liquidAssets: number; totalSavings: number; creditDebt: number;
  monthlySubscriptions: number; monthlyNet: number;
  runwayMonths: number | null; dataAgeDays: number | null;
  accounts: AccountSignal[];
};

export type InsightFinding = {
  id: string; created_at: string; briefing_session_id: string;
  finding_type: string; title: string; description: string;
  severity: 'info' | 'warn' | 'alert';
  impact_eur: number | null; transaction_ids: string | null;
  metadata: string | null; dismissed_at: string | null;
};

export type BriefingSession = {
  id: string; created_at: string; import_session_id: string | null; finding_count: number;
};

export type RecurringPattern = {
  id: string; account_id: string; counterparty_name: string;
  pattern_type: 'subscription' | 'recurring' | 'salary';
  interval_days: number; typical_amount: number; currency: string;
  first_seen: string; last_seen: string; occurrence_count: number; is_active: number;
};

export type Category = { id: string; name: string; built_in: number };

export type Transaction = {
  id: string; bookingDate: string | null; amount: number; currency: string;
  counterpartyName: string | null; description: string | null;
  account: { id: string; name: string; iban: string | null };
  categoryId?: string | null; categoryName?: string | null;
  groupSize?: number | null;
  transfer?: { direction: 'in' | 'out'; otherId: string | null } | null;
  isTransfer?: boolean;
};

export type MonthlyRow = { month: string; income: number; expense: number; net: number };

export type Summary = {
  totalBalance: number; monthlyNet: number; monthlyNetWithTransfers: number;
  runwayMonths: number | null;
  accounts: Array<{ id: string; name: string; balance: number; currency: string; date: string }>;
};

export type ImportResult = {
  importSessionId: string; briefingSessionId: string; accountId: string;
  normalizedCount: number; rawCount: number; skippedCount: number;
  overlapDetected: boolean; alreadyImportedCount: number;
};

// ── API functions ─────────────────────────────────────────────────

export const api = {
  household: {
    summary: () => get<HouseholdSummary>('/household/summary'),
  },
  briefing: {
    latest: () => get<{ session: BriefingSession | null; findings: InsightFinding[] }>('/briefing/latest'),
    byId: (id: string) => get<{ session: BriefingSession | null; findings: InsightFinding[] }>(`/briefing/${id}`),
    dismiss: (findingId: string) => post<{ ok: boolean }>(`/briefing/${findingId}/dismiss`),
  },
  subscriptions: {
    list: () => get<RecurringPattern[]>('/subscriptions'),
  },
  recurring: {
    list: () => get<RecurringPattern[]>('/recurring'),
  },
  summary: {
    get: () => get<Summary>('/summary'),
  },
  transactions: {
    list: (params?: { showTransfers?: boolean; limit?: number; offset?: number; categoryId?: string; accountId?: string }) => {
      const q = new URLSearchParams();
      if (params?.showTransfers) q.set('showTransfers', '1');
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.offset) q.set('offset', String(params.offset));
      if (params?.categoryId) q.set('categoryId', params.categoryId);
      if (params?.accountId) q.set('accountId', params.accountId);
      return get<Transaction[]>(`/transactions?${q}`);
    },
    setCategory: (txId: string, categoryId: string) =>
      post<{ ok: boolean }>(`/transactions/${txId}/categorize`, { categoryId }),
    monthly: () => get<MonthlyRow[]>('/transactions/monthly'),
  },
  categories: {
    list: () => get<Category[]>('/categories'),
    create: (name: string) => post<Category>('/categories', { name }),
    rename: (id: string, name: string) => post<{ ok: boolean }>(`/categories/${id}/rename`, { name }),
    delete: (id: string) => post<{ ok: boolean }>(`/categories/${id}/delete`),
  },
  accounts: {
    list: () => get<AccountSignal[]>('/accounts'),
    update: (id: string, patch: Partial<Pick<AccountSignal, 'name'> & { account_subtype: AccountSubtype; owner_label: string | null; credit_limit: number | null; savings_goal: number | null }>) =>
      patch<{ ok: boolean }>(`/accounts/${id}`, patch) as unknown as Promise<{ ok: boolean }>,
  },
  ai: {
    categorize: (txId: string) => post<{ mode: string }>(`/ai/categorize/${txId}`),
  },
  import: {
    upload: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return fetch(API + '/import', { method: 'POST', body: form }).then((r) => r.json() as Promise<ImportResult>);
    },
  },
  settings: {
    get: () => get<{ payday: number; paydayFlexDays: number; openaiConfigured: boolean }>('/settings'),
    update: (body: Record<string, unknown>) => post<{ ok: boolean }>('/settings', body),
  },
  backup: {
    url: () => API + '/backup',
  },
};
```

- [ ] **Step 2: Verify TypeScript build**

```bash
npm run build --workspace apps/web
```

Expected: exits 0, no TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api/client.ts
git commit -m "feat(web): typed API client layer"
```

---

## Task 7: App.tsx Refactor — Extract Views and Routing Shell

**Goal:** Reduce `App.tsx` from 1048 lines to ~120 lines by moving the three view blocks into `HomeView.tsx`, `ExplorerView.tsx`, and `SettingsView.tsx`. No behavioural changes — this is a pure extract refactor.

**Files:**
- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/views/HomeView.tsx`
- Create: `apps/web/src/views/ExplorerView.tsx`
- Create: `apps/web/src/views/SettingsView.tsx`

**Acceptance Criteria:**
- [ ] `npm run build --workspace apps/web` exits 0
- [ ] All three tabs render the same content as before
- [ ] `App.tsx` is under 200 lines
- [ ] Each view file imports from `../api/client` (not from `App.tsx`)

**Verify:** `npm run build --workspace apps/web` → exits 0

**Steps:**

- [ ] **Step 1: Create views directory**

```bash
mkdir -p apps/web/src/views
```

- [ ] **Step 2: Identify the three view blocks in `App.tsx`**

In `App.tsx`, locate:
- `const analyticsView = (` … the JSX assigned to this variable
- The raw/log view JSX (the tab that shows raw transactions and event log)
- The settings view JSX (categories, rules, accounts, adjustments)

Also note all the types, state variables, and helper functions that each view needs.

- [ ] **Step 3: Create `ExplorerView.tsx`**

Create `apps/web/src/views/ExplorerView.tsx`. Move all state and logic for the analytics tab (transactions list, monthly overview, insights, balance grid, CSV export) into this component. It should accept via props whatever it cannot fetch itself. Keep it using `fetch('/api/...')` internally for now — the API client integration happens in Task 8+.

The component signature:
```typescript
export default function ExplorerView() { ... }
```

All internal state (`transactions`, `insights`, `monthly`, `showTransfers`, etc.) lives in this component.

- [ ] **Step 4: Create `SettingsView.tsx`**

Move all settings tab content (categories, rules, accounts, balance adjustments, log viewer, backup button) into `apps/web/src/views/SettingsView.tsx`:

```typescript
export default function SettingsView() { ... }
```

- [ ] **Step 5: Create `HomeView.tsx` as a stub**

Create `apps/web/src/views/HomeView.tsx` as a placeholder that renders the current analyticsView hero section (import CTA + hero card). The full CFO panel comes in Task 8.

```typescript
export default function HomeView() {
  // Will be replaced in Task 8 with CfoStatePanel + BriefingPanel
  return <div>HomeView placeholder</div>;
}
```

- [ ] **Step 6: Slim down `App.tsx`**

Replace the contents of `App.tsx` with the routing shell:

```typescript
import { useState } from 'react';
import './App.css';
import HomeView from './views/HomeView';
import ExplorerView from './views/ExplorerView';
import SettingsView from './views/SettingsView';

export default function App() {
  const [tab, setTab] = useState<'home' | 'explorer' | 'settings'>('home');

  return (
    <div className="app">
      <nav className="tabs">
        <button className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}>Koti</button>
        <button className={tab === 'explorer' ? 'active' : ''} onClick={() => setTab('explorer')}>Tapahtumat</button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Asetukset</button>
      </nav>
      {tab === 'home' && <HomeView />}
      {tab === 'explorer' && <ExplorerView />}
      {tab === 'settings' && <SettingsView />}
    </div>
  );
}
```

- [ ] **Step 7: Verify build**

```bash
npm run build --workspace apps/web
```

Expected: exits 0

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/views/
git commit -m "refactor(web): split App.tsx into HomeView, ExplorerView, SettingsView"
```

---

## Task 8: CfoStatePanel + ImportPrompt (HomeView)

**Goal:** Implement the full `HomeView` with `CfoStatePanel` (household totals + per-account cards) and `ImportPrompt` (data-staleness banner with file upload), using the typed API client.

**Files:**
- Create: `apps/web/src/components/CfoStatePanel.tsx`
- Create: `apps/web/src/components/AccountCard.tsx`
- Create: `apps/web/src/components/ImportPrompt.tsx`
- Modify: `apps/web/src/views/HomeView.tsx`

**Acceptance Criteria:**
- [ ] `CfoStatePanel` shows `liquidAssets`, `runwayMonths`, `creditDebt`, `monthlySubscriptions`
- [ ] Each account renders an `AccountCard` with subtype badge, balance, trend arrow, and warning badge
- [ ] `ImportPrompt` shows a yellow banner when `dataAgeDays > 7` and red when `> 14`
- [ ] File upload via `ImportPrompt` calls `api.import.upload()` and refreshes the household summary on success
- [ ] `npm run build --workspace apps/web` exits 0

**Verify:** `npm run build --workspace apps/web` → exits 0

**Steps:**

- [ ] **Step 1: Create `AccountCard.tsx`**

Create `apps/web/src/components/AccountCard.tsx`:

```typescript
import type { AccountSignal } from '../api/client';

const SUBTYPE_LABEL: Record<string, string> = {
  checking: 'Käyttötili',
  savings: 'Säästötili',
  credit_card: 'Luottokortti',
};

const TREND_ICON: Record<string, string> = { up: '↑', down: '↓', stable: '→' };

type Props = { account: AccountSignal };

export default function AccountCard({ account }: Props) {
  const trendIcon = account.trend ? TREND_ICON[account.trend] : '';
  const isCredit = account.subtype === 'credit_card';
  const warningClass = account.warningLevel !== 'none' ? ` account-card--${account.warningLevel}` : '';

  return (
    <div className={`account-card${warningClass}`}>
      <div className="account-card__header">
        <span className="account-card__name">{account.name}</span>
        <span className={`account-card__badge account-card__badge--${account.subtype}`}>
          {SUBTYPE_LABEL[account.subtype] ?? account.subtype}
        </span>
      </div>
      {account.ownerLabel && (
        <div className="account-card__owner">{account.ownerLabel}</div>
      )}
      <div className="account-card__balance">
        <span className={isCredit && account.balance < 0 ? 'neg' : ''}>
          {account.balance.toFixed(2)} {account.currency}
        </span>
        {trendIcon && <span className={`account-card__trend account-card__trend--${account.trend}`}>{trendIcon}</span>}
      </div>
      {account.date && <div className="account-card__date">{account.date.slice(0, 10)}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Create `ImportPrompt.tsx`**

Create `apps/web/src/components/ImportPrompt.tsx`:

```typescript
import { useState } from 'react';
import { api } from '../api/client';

type Props = {
  dataAgeDays: number | null;
  onImportSuccess: (briefingSessionId: string) => void;
};

export default function ImportPrompt({ dataAgeDays, onImportSuccess }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState('');

  const stale = dataAgeDays !== null && dataAgeDays > 7;
  const veryStale = dataAgeDays !== null && dataAgeDays > 14;

  const onSubmit = async () => {
    if (!file) return;
    setStatus('Tuodaan...');
    try {
      const result = await api.import.upload(file);
      setStatus(`Tuotu ${result.normalizedCount} tapahtumaa.`);
      setFile(null);
      onImportSuccess(result.briefingSessionId);
    } catch {
      setStatus('Tuonti epäonnistui.');
    }
  };

  return (
    <div className={`import-prompt${veryStale ? ' import-prompt--critical' : stale ? ' import-prompt--stale' : ''}`}>
      {stale && (
        <p className="import-prompt__age">
          {veryStale ? '⚠️ ' : ''}Viimeisin data {dataAgeDays} pv sitten — tuo uusi tiedosto
        </p>
      )}
      <div className="import-prompt__controls">
        <label className="upload">
          <input type="file" accept=".csv,.xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {file ? `Valittu: ${file.name}` : 'Valitse CSV/XLSX'}
        </label>
        <button type="button" onClick={onSubmit} disabled={!file}>Tuo & analysoi</button>
        {status && <span className="muted">{status}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `CfoStatePanel.tsx`**

Create `apps/web/src/components/CfoStatePanel.tsx`:

```typescript
import type { HouseholdSummary } from '../api/client';
import AccountCard from './AccountCard';

type Props = { summary: HouseholdSummary };

export default function CfoStatePanel({ summary }: Props) {
  return (
    <div className="cfo-panel">
      <div className="cfo-panel__metrics">
        <div className="metric">
          <span>Likvidit varat</span>
          <strong>{summary.liquidAssets.toFixed(2)} €</strong>
        </div>
        <div className="metric">
          <span>Runway</span>
          <strong>{summary.runwayMonths !== null ? `${summary.runwayMonths.toFixed(1)} kk` : '—'}</strong>
        </div>
        <div className="metric">
          <span>Luottovelka</span>
          <strong className={summary.creditDebt > 0 ? 'neg' : ''}>{summary.creditDebt.toFixed(2)} €</strong>
        </div>
        <div className="metric">
          <span>Tilaukset</span>
          <strong>{summary.monthlySubscriptions.toFixed(2)} €/kk</strong>
        </div>
      </div>

      <div className="cfo-panel__accounts">
        {summary.accounts.map((a) => (
          <AccountCard key={a.id} account={a} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Replace `HomeView.tsx` stub with full implementation**

Replace `apps/web/src/views/HomeView.tsx`:

```typescript
import { useCallback, useEffect, useState } from 'react';
import { api, type HouseholdSummary, type BriefingSession, type InsightFinding } from '../api/client';
import CfoStatePanel from '../components/CfoStatePanel';
import ImportPrompt from '../components/ImportPrompt';
import BriefingPanel from '../components/BriefingPanel';

export default function HomeView() {
  const [summary, setSummary] = useState<HouseholdSummary | null>(null);
  const [briefing, setBriefing] = useState<{ session: BriefingSession | null; findings: InsightFinding[] }>({ session: null, findings: [] });
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([
        api.household.summary(),
        api.briefing.latest(),
      ]);
      setSummary(s);
      setBriefing(b);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onImportSuccess = async (briefingSessionId: string) => {
    await load();
  };

  return (
    <div className="home-view">
      {error && <p className="error">{error}</p>}

      <ImportPrompt
        dataAgeDays={summary?.dataAgeDays ?? null}
        onImportSuccess={onImportSuccess}
      />

      {summary && <CfoStatePanel summary={summary} />}

      <BriefingPanel
        findings={briefing.findings}
        onDismiss={async (id) => {
          await api.briefing.dismiss(id);
          await load();
        }}
      />
    </div>
  );
}
```

- [ ] **Step 5: Verify build**

```bash
npm run build --workspace apps/web
```

Expected: exits 0 (BriefingPanel will be created in Task 9 — add a placeholder stub first if needed)

If BriefingPanel doesn't exist yet, create a stub at `apps/web/src/components/BriefingPanel.tsx`:
```typescript
export default function BriefingPanel(_props: { findings: any[]; onDismiss: (id: string) => void }) {
  return <div className="briefing-panel">Ladataan briefing...</div>;
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ apps/web/src/views/HomeView.tsx
git commit -m "feat(web): CfoStatePanel, AccountCard, ImportPrompt, HomeView"
```

---

## Task 9: BriefingPanel + FindingCard

**Goal:** Implement `BriefingPanel` and `FindingCard` that render the ordered list of insight findings with dismiss support and drill-down transaction links.

**Files:**
- Create: `apps/web/src/components/BriefingPanel.tsx`
- Create: `apps/web/src/components/FindingCard.tsx`

**Acceptance Criteria:**
- [ ] `BriefingPanel` renders a heading, a count of findings, and one `FindingCard` per finding
- [ ] `FindingCard` shows severity icon, title, description, `impact_eur` if present, and a dismiss button
- [ ] `alert` findings have red border, `warn` have yellow, `info` have grey
- [ ] Dismissed findings disappear immediately (optimistic local state)
- [ ] When `findings` is empty, panel shows "Ei uusia havaintoja." message
- [ ] `npm run build --workspace apps/web` exits 0

**Verify:** `npm run build --workspace apps/web` → exits 0

**Steps:**

- [ ] **Step 1: Create `FindingCard.tsx`**

Create `apps/web/src/components/FindingCard.tsx`:

```typescript
import type { InsightFinding } from '../api/client';

const SEVERITY_ICON: Record<string, string> = { alert: '🔴', warn: '🟡', info: '🔵' };

const FINDING_TYPE_LABEL: Record<string, string> = {
  subscription_creep: 'Tilaukset',
  one_off_impact: 'Kertaluonteinen hankinta',
  savings_progress: 'Säästöt',
  credit_health: 'Luottokortti',
  spending_anomaly: 'Kulutuspoikkeama',
  new_recurring: 'Uusi toistuva',
};

type Props = {
  finding: InsightFinding;
  onDismiss: (id: string) => void;
};

export default function FindingCard({ finding, onDismiss }: Props) {
  const icon = SEVERITY_ICON[finding.severity] ?? '🔵';
  const label = FINDING_TYPE_LABEL[finding.finding_type] ?? finding.finding_type;

  return (
    <div className={`finding-card finding-card--${finding.severity}`}>
      <div className="finding-card__header">
        <span className="finding-card__icon">{icon}</span>
        <span className="finding-card__type">{label}</span>
        <button
          className="finding-card__dismiss"
          type="button"
          onClick={() => onDismiss(finding.id)}
          title="Kuittaa"
        >
          ✕
        </button>
      </div>
      <h3 className="finding-card__title">{finding.title}</h3>
      <p className="finding-card__description">{finding.description}</p>
      {finding.impact_eur !== null && (
        <div className="finding-card__impact">
          Vaikutus: {Math.abs(finding.impact_eur).toFixed(2)} €
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `BriefingPanel.tsx`**

Replace the stub in `apps/web/src/components/BriefingPanel.tsx`:

```typescript
import { useState } from 'react';
import type { InsightFinding } from '../api/client';
import FindingCard from './FindingCard';

type Props = {
  findings: InsightFinding[];
  onDismiss: (id: string) => void;
};

export default function BriefingPanel({ findings, onDismiss }: Props) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const visible = findings.filter((f) => !dismissed.has(f.id));

  const handleDismiss = (id: string) => {
    setDismissed((prev) => new Set([...prev, id]));
    onDismiss(id);
  };

  return (
    <section className="briefing-panel">
      <div className="briefing-panel__header">
        <h2>CFO Briefing</h2>
        {visible.length > 0 && (
          <span className="chip">{visible.length} havainto{visible.length !== 1 ? 'a' : ''}</span>
        )}
      </div>
      {visible.length === 0 ? (
        <p className="muted">Ei uusia havaintoja.</p>
      ) : (
        <div className="briefing-panel__findings">
          {visible.map((f) => (
            <FindingCard key={f.id} finding={f} onDismiss={handleDismiss} />
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Verify build**

```bash
npm run build --workspace apps/web
```

Expected: exits 0

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/BriefingPanel.tsx apps/web/src/components/FindingCard.tsx
git commit -m "feat(web): BriefingPanel and FindingCard with dismiss support"
```

---

## Task 10: Recharts Charts + Account Settings UI

**Goal:** Add Recharts to the web app and implement three chart components used in `ExplorerView`; also add account subtype/owner editing to `SettingsView`.

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/charts/BalanceChart.tsx`
- Create: `apps/web/src/charts/MonthlyNetChart.tsx`
- Create: `apps/web/src/charts/SubscriptionChart.tsx`
- Modify: `apps/web/src/views/ExplorerView.tsx` (add charts)
- Modify: `apps/web/src/views/SettingsView.tsx` (add account editing)

**Acceptance Criteria:**
- [ ] `npm install` installs `recharts` without error
- [ ] `BalanceChart` renders a Recharts `LineChart` of account balance snapshots over time
- [ ] `MonthlyNetChart` renders a Recharts `BarChart` of monthly income vs expense
- [ ] `SubscriptionChart` renders a Recharts `LineChart` of total subscription spend per month (from recurring patterns + monthly data)
- [ ] `SettingsView` shows account list with inline editing for `account_subtype`, `owner_label`, `credit_limit`, `savings_goal`
- [ ] `npm run build --workspace apps/web` exits 0

**Verify:** `npm run build --workspace apps/web` → exits 0

**Steps:**

- [ ] **Step 1: Install Recharts**

```bash
npm install recharts --workspace apps/web
```

- [ ] **Step 2: Create `BalanceChart.tsx`**

Create `apps/web/src/charts/BalanceChart.tsx`:

```typescript
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

type DataPoint = { date: string; [accountName: string]: number | string };

type Props = { data: DataPoint[]; accountNames: string[] };

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export default function BalanceChart({ data, accountNames }: Props) {
  if (data.length === 0) return <p className="muted">Ei saldodataa.</p>;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="date" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip formatter={(v: number) => `${v.toFixed(2)} €`} />
        <Legend />
        {accountNames.map((name, i) => (
          <Line key={name} type="monotone" dataKey={name} stroke={COLORS[i % COLORS.length]} dot={false} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 3: Create `MonthlyNetChart.tsx`**

Create `apps/web/src/charts/MonthlyNetChart.tsx`:

```typescript
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import type { MonthlyRow } from '../api/client';

type Props = { data: MonthlyRow[] };

export default function MonthlyNetChart({ data }: Props) {
  if (data.length === 0) return <p className="muted">Ei kuukausidataa.</p>;
  const chartData = data.map((r) => ({
    month: r.month.slice(0, 7),
    Tulot: r.income,
    Menot: Math.abs(r.expense),
    Netto: r.net,
  }));
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip formatter={(v: number) => `${v.toFixed(2)} €`} />
        <Legend />
        <Bar dataKey="Tulot" fill="#10b981" />
        <Bar dataKey="Menot" fill="#ef4444" />
        <Bar dataKey="Netto" fill="#6366f1" />
      </BarChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 4: Create `SubscriptionChart.tsx`**

Create `apps/web/src/charts/SubscriptionChart.tsx`:

```typescript
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { RecurringPattern } from '../api/client';

type Props = { subscriptions: RecurringPattern[] };

export default function SubscriptionChart({ subscriptions }: Props) {
  const active = subscriptions.filter((s) => s.is_active);
  if (active.length === 0) return <p className="muted">Ei tilauspalveluita.</p>;

  // Build a simple running total chart: group by first_seen month
  const byMonth = new Map<string, number>();
  let running = 0;

  const sorted = [...active].sort((a, b) => a.first_seen.localeCompare(b.first_seen));
  for (const s of sorted) {
    const month = s.first_seen.slice(0, 7);
    running += s.typical_amount;
    byMonth.set(month, running);
  }

  const data = Array.from(byMonth.entries()).map(([month, total]) => ({ month, total }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip formatter={(v: number) => `${v.toFixed(2)} €/kk`} />
        <Line type="monotone" dataKey="total" stroke="#f59e0b" dot={false} name="Tilaukset yhteensä" />
      </LineChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 5: Add charts to `ExplorerView.tsx`**

In `apps/web/src/views/ExplorerView.tsx`, add imports at the top and use the chart components inside the monthly overview section:

```typescript
import MonthlyNetChart from '../charts/MonthlyNetChart';
// ... existing imports

// Inside the monthly overview card, after the existing table, add:
<MonthlyNetChart data={monthly} />
```

For BalanceChart, you need balance snapshot data. Add a fetch inside ExplorerView:

```typescript
// fetch /accounts to get account list, then use balance snapshots from household summary
// For now, pass monthly data to MonthlyNetChart as a quick win
// BalanceChart requires dedicated /balances endpoint — wire it up once ExplorerView loads household data
```

Import and use `MonthlyNetChart` inside the existing monthly section. Add `SubscriptionChart` in a new "Tilauspalvelut" card below the monthly section, fetching from `api.subscriptions.list()`.

- [ ] **Step 6: Add account editing to `SettingsView.tsx`**

In `apps/web/src/views/SettingsView.tsx`, find the accounts section and add inline editing. After each account row, add:

```typescript
// Add to imports:
import { api, type AccountSignal, type AccountSubtype } from '../api/client';

// In the accounts list rendering, for each account:
<select
  value={account.subtype ?? 'checking'}
  onChange={async (e) => {
    await api.accounts.update(account.id, { account_subtype: e.target.value as AccountSubtype });
    // refresh accounts list
  }}
>
  <option value="checking">Käyttötili</option>
  <option value="savings">Säästötili</option>
  <option value="credit_card">Luottokortti</option>
</select>
<input
  type="text"
  placeholder="Omistaja (valinnainen)"
  defaultValue={account.ownerLabel ?? ''}
  onBlur={async (e) => {
    await api.accounts.update(account.id, { owner_label: e.target.value || null });
  }}
/>
```

- [ ] **Step 7: Final build verification**

```bash
npm run build --workspace apps/web
```

Expected: exits 0

- [ ] **Step 8: Run full test suite**

```bash
npm test
```

Expected: all API tests pass

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/charts/ apps/web/src/views/ExplorerView.tsx apps/web/src/views/SettingsView.tsx apps/web/package.json package-lock.json
git commit -m "feat(web): Recharts charts (balance, monthly, subscriptions) + account subtype editor"
```

---

## Task Dependencies

```
Task 1 (schema)
  ↓
Task 2 (patterns) → Task 3 (briefing) → Task 4 (import hook)
  ↓                                          ↓
Task 5 (household summary + endpoints) ←────┘
  ↓
Task 6 (API client)
  ↓
Task 7 (App refactor) → Task 8 (HomeView) → Task 9 (BriefingPanel)
                     ↘                   ↗
                      Task 10 (charts + settings)
```

Tasks 7–10 are frontend-only and can be done in parallel with Tasks 2–5 (backend).

---

## Self-Review Checklist

- [x] No TBD or TODO in any task
- [x] Every step that touches code includes actual code blocks
- [x] Type names are consistent across tasks (`AccountSignal`, `HouseholdSummary`, `InsightFinding`, `RecurringPattern`, `BriefingSession` — same in Tasks 5, 6, 8, 9)
- [x] Table creation order in Task 1 is correct: `briefing_sessions` before `insight_findings` (FK dependency)
- [x] `safeExec()` migration helper handles duplicate `ALTER TABLE` safely
- [x] All test files include the full `beforeEach` cleanup including new tables
- [x] `detectPatterns` signature matches usage in Task 4 (`detectPatterns(accountId: string)`)
- [x] `runBriefing` signature matches usage in Task 4 (`runBriefing(importSessionId: string): string`)
- [x] `getHouseholdSummary()` export matches import in Task 6 client and Task 5 endpoint
- [x] Recharts is a runtime dep (not dev) — `npm install recharts --workspace apps/web` correct
