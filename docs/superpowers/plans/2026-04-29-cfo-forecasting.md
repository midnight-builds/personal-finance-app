# CFO Forecasting & Annual Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect annual/seasonal recurring expenses (e.g., "insurance always comes in January"), let users confirm uncertain large annual payments, and show a next-month spending forecast on the dashboard.

**Architecture:** Extend `recurring_patterns` with `typical_month` (1–12) and `user_confirmed` columns; add `pattern_confirmations` table for user questions. `detectPatterns()` gains a 24-month window and two new helper functions: one for confirmed annual detection (2+ occurrences ≈365 days apart) and one for surfacing large single-occurrence candidates. New `forecast.ts` aggregates known recurring costs + calendar-month historical averages into a 3-month projected spend exposed via `GET /forecast`. A `ForecastPanel` component shows the projection; `BriefingPanel` renders a `PatternConfirmationCard` for `pattern_confirmation` findings.

**Tech Stack:** Node.js SQLite, Fastify, React 19/Vite, Node.js `node:test` + `assert/strict`

---

## File Structure

| File | Change |
|------|--------|
| `apps/api/src/db.ts` | Add `pattern_confirmations` table + `typical_month`/`user_confirmed` columns to `recurring_patterns` |
| `apps/api/src/patterns.ts` | Add `detectAnnualPatternsForAccount()` + `detectConfirmationCandidates()`, call from `detectPatterns()` |
| `apps/api/tests/patterns-annual.test.ts` | Create: 5 test cases for annual detection and confirmation candidates |
| `apps/api/src/patternConfirmations.ts` | Create: `listPendingConfirmations()`, `confirmPatternConfirmation()`, `rejectPatternConfirmation()` |
| `apps/api/tests/pattern-confirmations.test.ts` | Create: 3 test cases |
| `apps/api/src/briefing.ts` | Add `pendingConfirmations()` and `monthlyForecast()` generators |
| `apps/api/src/forecast.ts` | Create: `computeMonthlyForecast()`, `getForecast()` |
| `apps/api/tests/forecast.test.ts` | Create: 4 test cases |
| `apps/api/src/index.ts` | Add `GET /forecast`, `GET /pattern-confirmations`, `POST /pattern-confirmations/:id/confirm`, `POST /pattern-confirmations/:id/reject` |
| `apps/web/src/api/client.ts` | Add types + functions for confirmations and forecast |
| `apps/web/src/components/PatternConfirmationCard.tsx` | Create: confirm/reject UI for `pattern_confirmation` findings |
| `apps/web/src/components/BriefingPanel.tsx` | Render `PatternConfirmationCard` for `pattern_confirmation` finding type |
| `apps/web/src/components/ForecastPanel.tsx` | Create: 3-month projected spend display |
| `apps/web/src/views/HomeView.tsx` | Mount `ForecastPanel` between `CfoStatePanel` and `BriefingPanel` |

---

### Task 1: DB Schema — Annual Patterns + Confirmations

**Goal:** Add `typical_month`/`user_confirmed` columns to `recurring_patterns`; create `pattern_confirmations` table.

**Files:**
- Modify: `apps/api/src/db.ts`

**Acceptance Criteria:**
- [ ] `recurring_patterns` has `typical_month INTEGER` (NULL for non-annual)
- [ ] `recurring_patterns` has `user_confirmed INTEGER` (NULL=auto, 1=confirmed by user, 0=rejected)
- [ ] `pattern_confirmations` table created with all required columns and indexes
- [ ] All changes are idempotent (use existing `safeExec` pattern + `CREATE TABLE IF NOT EXISTS`)
- [ ] All existing tests still pass

**Verify:** `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 "tests/**/*.ts"` → all pass

**Steps:**

- [ ] **Step 1: Add `pattern_confirmations` table inside `initDb()`**

In `apps/api/src/db.ts`, inside the `db.exec(...)` block in `initDb()`, after the `recurring_patterns` table definition and before the index block, add:

```sql
CREATE TABLE IF NOT EXISTS pattern_confirmations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  account_id TEXT NOT NULL,
  counterparty_name TEXT NOT NULL,
  typical_month INTEGER NOT NULL,
  typical_amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_at TEXT,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_pattern_conf_status ON pattern_confirmations(status);
CREATE INDEX IF NOT EXISTS idx_pattern_conf_account ON pattern_confirmations(account_id);
```

- [ ] **Step 2: Add idempotent column migrations**

After the existing `safeExec` calls at the bottom of `initDb()`:

```typescript
safeExec(`ALTER TABLE recurring_patterns ADD COLUMN typical_month INTEGER`);
safeExec(`ALTER TABLE recurring_patterns ADD COLUMN user_confirmed INTEGER`);
```

- [ ] **Step 3: Add `pattern_confirmations` cleanup to debug endpoints**

In `apps/api/src/index.ts`, add `DELETE FROM pattern_confirmations;` to both the `/debug/clear` and `/debug/clear-imports` exec blocks.

- [ ] **Step 4: Run tests**

Run: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 "tests/**/*.ts"`
Expected: all existing tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db.ts apps/api/src/index.ts
git commit -m "feat(api): schema — annual pattern columns + pattern_confirmations table"
```

---

### Task 2: Annual Pattern Detection

**Goal:** `detectPatterns()` detects annual (≈365-day) recurring patterns and surfaces large single-occurrence candidates for user confirmation.

**Files:**
- Modify: `apps/api/src/patterns.ts`
- Create: `apps/api/tests/patterns-annual.test.ts`

**Acceptance Criteria:**
- [ ] Two transactions 330–400 days apart, same counterparty, amounts within 25% → `pattern_type='annual'` with `typical_month` set
- [ ] Single transaction ≥ 80€ with no existing pattern → `pattern_confirmations` record with `status='pending'`
- [ ] Running `detectPatterns` twice doesn't create duplicate `pattern_confirmations`
- [ ] No confirmation created if an annual `recurring_patterns` row already exists for that counterparty
- [ ] No confirmation created for amounts < 80€
- [ ] Counterparties already flagged as `subscription`/`recurring` are excluded from annual detection

**Verify:** `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/patterns-annual.test.ts` → 5/5 pass

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `apps/api/tests/patterns-annual.test.ts`:

```typescript
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DB_PATH = ':memory:';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import { detectPatterns } from '../src/patterns.js';

initDb();

function mkAccount() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'Test', null, 'bank', 'checking');
  return id;
}

function mkSession() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'test', 'csv', 'x', 1, crypto.randomUUID());
  return id;
}

function mkTxOnDate(accountId: string, sessionId: string, counterparty: string, amount: number, date: string) {
  const id = crypto.randomUUID();
  const raw = crypto.randomUUID();
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
    DELETE FROM pattern_confirmations; DELETE FROM recurring_patterns;
    DELETE FROM transfer_links; DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions; DELETE FROM import_sessions; DELETE FROM accounts;
    DELETE FROM categorization_decisions; DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
});

test('detects annual pattern from 2 occurrences ~365 days apart', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTxOnDate(acct, sess, 'IF Vakuutus', -312.50, '2023-01-15');
  mkTxOnDate(acct, sess, 'IF Vakuutus', -318.00, '2024-01-17');

  detectPatterns(acct);

  const pattern = db.prepare(
    "SELECT * FROM recurring_patterns WHERE counterparty_name = 'IF Vakuutus'"
  ).get() as any;
  assert.ok(pattern, 'should create annual pattern');
  assert.equal(pattern.pattern_type, 'annual');
  assert.equal(pattern.typical_month, 1);
  assert.ok(pattern.interval_days >= 330 && pattern.interval_days <= 400, `interval_days ${pattern.interval_days} should be 330-400`);
});

test('creates confirmation candidate for large single-occurrence payment', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTxOnDate(acct, sess, 'IF Vakuutus', -312.50, '2024-01-15');

  detectPatterns(acct);

  const conf = db.prepare(
    "SELECT * FROM pattern_confirmations WHERE counterparty_name = 'IF Vakuutus'"
  ).get() as any;
  assert.ok(conf, 'should create confirmation candidate');
  assert.equal(conf.typical_month, 1);
  assert.equal(conf.status, 'pending');
});

test('does not create duplicate confirmation when detectPatterns runs twice', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTxOnDate(acct, sess, 'IF Vakuutus', -312.50, '2024-01-15');

  detectPatterns(acct);
  detectPatterns(acct);

  const confs = db.prepare(
    "SELECT * FROM pattern_confirmations WHERE counterparty_name = 'IF Vakuutus'"
  ).all() as any[];
  assert.equal(confs.length, 1, 'should have exactly one confirmation');
});

test('does not create confirmation if annual pattern already exists', () => {
  const acct = mkAccount();
  const sess = mkSession();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO recurring_patterns
    (id, created_at, updated_at, account_id, counterparty_name, pattern_type, interval_days,
     typical_amount, currency, first_seen, last_seen, occurrence_count, is_active, typical_month)
    VALUES (?, ?, ?, ?, ?, 'annual', 365, 312.50, 'EUR', '2023-01-15', '2024-01-17', 2, 1, 1)`)
    .run(crypto.randomUUID(), now, now, acct, 'IF Vakuutus');

  mkTxOnDate(acct, sess, 'IF Vakuutus', -312.50, '2024-01-15');
  detectPatterns(acct);

  const conf = db.prepare(
    "SELECT * FROM pattern_confirmations WHERE counterparty_name = 'IF Vakuutus'"
  ).get() as any;
  assert.equal(conf, undefined, 'should not create confirmation when annual pattern already exists');
});

test('does not create confirmation for amounts below 80 EUR', () => {
  const acct = mkAccount();
  const sess = mkSession();
  mkTxOnDate(acct, sess, 'SmallShop', -25.00, '2024-03-15');

  detectPatterns(acct);

  const conf = db.prepare(
    "SELECT * FROM pattern_confirmations WHERE counterparty_name = 'SmallShop'"
  ).get() as any;
  assert.equal(conf, undefined, 'should not create confirmation for amounts below threshold');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/patterns-annual.test.ts`
Expected: all 5 fail (functions not implemented yet)

- [ ] **Step 3: Add annual detection functions to `patterns.ts`**

In `apps/api/src/patterns.ts`, after all existing code, add these two functions and update `detectPatterns` to call them:

```typescript
const ANNUAL_CONFIRMATION_THRESHOLD_EUR = 80;

function detectAnnualPatternsForAccount(accountId: string): void {
  const now = new Date().toISOString();
  const twoYearsAgo = new Date(Date.now() - 730 * 86400_000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT counterparty_name, amount, booking_date
    FROM normalized_transactions
    WHERE account_id = ?
      AND booking_date >= ?
      AND amount < 0
      AND counterparty_name IS NOT NULL
      AND counterparty_name NOT IN (
        SELECT DISTINCT counterparty_name FROM normalized_transactions
        WHERE account_id = ?
          AND id IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
      )
      AND counterparty_name NOT IN (
        SELECT counterparty_name FROM recurring_patterns
        WHERE account_id = ? AND pattern_type IN ('subscription', 'recurring') AND is_active = 1
      )
    ORDER BY counterparty_name, booking_date
  `).all(accountId, twoYearsAgo, accountId, accountId) as Array<{ counterparty_name: string; amount: number; booking_date: string }>;

  const byCounterparty = new Map<string, Array<{ amount: number; date: string }>>();
  for (const r of rows) {
    if (!byCounterparty.has(r.counterparty_name)) byCounterparty.set(r.counterparty_name, []);
    byCounterparty.get(r.counterparty_name)!.push({ amount: r.amount, date: r.booking_date });
  }

  for (const [counterparty, occurrences] of byCounterparty) {
    if (occurrences.length < 2) continue;

    const sorted = occurrences.sort((a, b) => a.date.localeCompare(b.date));
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const a = new Date(sorted[i - 1].date).getTime();
      const b = new Date(sorted[i].date).getTime();
      intervals.push((b - a) / 86400_000);
    }

    const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    if (avgInterval < 330 || avgInterval > 400) continue;

    const amounts = sorted.map((o) => Math.abs(o.amount));
    const avgAmount = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    if (avgAmount === 0) continue;
    const consistent = amounts.every((a) => Math.abs(a - avgAmount) / avgAmount <= 0.25);
    if (!consistent) continue;

    const typicalMonth = new Date(sorted[sorted.length - 1].date).getMonth() + 1;

    const existing = db.prepare(
      'SELECT id FROM recurring_patterns WHERE account_id = ? AND counterparty_name = ?'
    ).get(accountId, counterparty) as { id: string } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE recurring_patterns SET updated_at = ?, pattern_type = 'annual',
          interval_days = ?, typical_amount = ?, last_seen = ?,
          occurrence_count = ?, is_active = 1, typical_month = ?
        WHERE id = ?
      `).run(now, Math.round(avgInterval), avgAmount,
             sorted[sorted.length - 1].date, sorted.length, typicalMonth, existing.id);
    } else {
      db.prepare(`
        INSERT INTO recurring_patterns
          (id, created_at, updated_at, account_id, counterparty_name, pattern_type,
           interval_days, typical_amount, currency, first_seen, last_seen,
           occurrence_count, is_active, typical_month)
        VALUES (?, ?, ?, ?, ?, 'annual', ?, ?, 'EUR', ?, ?, ?, 1, ?)
      `).run(
        crypto.randomUUID(), now, now, accountId, counterparty,
        Math.round(avgInterval), avgAmount,
        sorted[0].date, sorted[sorted.length - 1].date, sorted.length, typicalMonth
      );
    }
  }
}

function detectConfirmationCandidates(accountId: string): void {
  const now = new Date().toISOString();
  const twoYearsAgo = new Date(Date.now() - 730 * 86400_000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT counterparty_name, amount, booking_date
    FROM normalized_transactions
    WHERE account_id = ?
      AND booking_date >= ?
      AND amount < 0
      AND ABS(amount) >= ?
      AND counterparty_name IS NOT NULL
      AND counterparty_name NOT IN (
        SELECT DISTINCT counterparty_name FROM normalized_transactions
        WHERE account_id = ?
          AND id IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
      )
      AND counterparty_name NOT IN (
        SELECT counterparty_name FROM recurring_patterns WHERE account_id = ? AND is_active = 1
      )
    ORDER BY counterparty_name, booking_date
  `).all(accountId, twoYearsAgo, ANNUAL_CONFIRMATION_THRESHOLD_EUR, accountId, accountId) as Array<{ counterparty_name: string; amount: number; booking_date: string }>;

  const byCounterparty = new Map<string, Array<{ amount: number; date: string }>>();
  for (const r of rows) {
    if (!byCounterparty.has(r.counterparty_name)) byCounterparty.set(r.counterparty_name, []);
    byCounterparty.get(r.counterparty_name)!.push({ amount: r.amount, date: r.booking_date });
  }

  for (const [counterparty, occurrences] of byCounterparty) {
    if (occurrences.length !== 1) continue; // only true single-occurrence candidates

    const occ = occurrences[0];
    const typicalMonth = new Date(occ.date).getMonth() + 1;
    const typicalAmount = Math.abs(occ.amount);

    const alreadyPending = db.prepare(
      'SELECT 1 FROM pattern_confirmations WHERE counterparty_name = ? AND typical_month = ? AND status = ?'
    ).get(counterparty, typicalMonth, 'pending');
    if (alreadyPending) continue;

    db.prepare(`
      INSERT INTO pattern_confirmations
        (id, created_at, account_id, counterparty_name, typical_month, typical_amount, currency, status)
      VALUES (?, ?, ?, ?, ?, ?, 'EUR', 'pending')
    `).run(crypto.randomUUID(), now, accountId, counterparty, typicalMonth, typicalAmount);
  }
}
```

At the bottom of the existing `detectPatterns()` function body (before the closing `}`), add the two calls:

```typescript
  detectAnnualPatternsForAccount(accountId);
  detectConfirmationCandidates(accountId);
```

- [ ] **Step 4: Run annual tests**

Run: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/patterns-annual.test.ts`
Expected: all 5 pass

- [ ] **Step 5: Run full test suite**

Run: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 "tests/**/*.ts"`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/patterns.ts apps/api/tests/patterns-annual.test.ts
git commit -m "feat(api): detect annual recurring patterns + surface large single-occurrence confirmation candidates"
```

---

### Task 3: Pattern Confirmation API + Briefing Generator

**Goal:** REST endpoints for listing/confirming/rejecting confirmations; `pendingConfirmations()` briefing generator surfaces them as findings.

**Files:**
- Create: `apps/api/src/patternConfirmations.ts`
- Create: `apps/api/tests/pattern-confirmations.test.ts`
- Modify: `apps/api/src/briefing.ts`
- Modify: `apps/api/src/index.ts`

**Acceptance Criteria:**
- [ ] `listPendingConfirmations()` returns pending records
- [ ] `confirmPatternConfirmation(id)` creates `annual` recurring_pattern + marks `confirmed`
- [ ] `rejectPatternConfirmation(id)` marks `rejected` without creating a pattern
- [ ] `pendingConfirmations()` generator returns up to 3 `pattern_confirmation` findings with `metadata.confirmationId`
- [ ] `GET /pattern-confirmations`, `POST /pattern-confirmations/:id/confirm`, `POST /pattern-confirmations/:id/reject` all respond correctly

**Verify:** `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/pattern-confirmations.test.ts` → 3/3 pass

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `apps/api/tests/pattern-confirmations.test.ts`:

```typescript
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DB_PATH = ':memory:';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import {
  listPendingConfirmations,
  confirmPatternConfirmation,
  rejectPatternConfirmation,
} from '../src/patternConfirmations.js';

initDb();

function mkAccount() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'Test', null, 'bank', 'checking');
  return id;
}

function mkConfirmation(accountId: string, counterparty: string, month: number, amount: number, status = 'pending') {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO pattern_confirmations
    (id, created_at, account_id, counterparty_name, typical_month, typical_amount, currency, status)
    VALUES (?, ?, ?, ?, ?, ?, 'EUR', ?)`)
    .run(id, new Date().toISOString(), accountId, counterparty, month, amount, status);
  return id;
}

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM pattern_confirmations; DELETE FROM recurring_patterns;
    DELETE FROM transfer_links; DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions; DELETE FROM import_sessions; DELETE FROM accounts;
    DELETE FROM categorization_decisions; DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
});

test('confirmPatternConfirmation creates annual recurring_pattern', () => {
  const acct = mkAccount();
  const confId = mkConfirmation(acct, 'IF Vakuutus', 1, 312.50);

  confirmPatternConfirmation(confId);

  const pattern = db.prepare(
    "SELECT * FROM recurring_patterns WHERE counterparty_name = 'IF Vakuutus'"
  ).get() as any;
  assert.ok(pattern, 'should create annual pattern');
  assert.equal(pattern.pattern_type, 'annual');
  assert.equal(pattern.typical_month, 1);
  assert.equal(pattern.user_confirmed, 1);

  const conf = db.prepare('SELECT status FROM pattern_confirmations WHERE id = ?').get(confId) as any;
  assert.equal(conf.status, 'confirmed');
});

test('rejectPatternConfirmation marks rejected, no pattern created', () => {
  const acct = mkAccount();
  const confId = mkConfirmation(acct, 'SomeShop', 3, 200.00);

  rejectPatternConfirmation(confId);

  const pattern = db.prepare(
    "SELECT * FROM recurring_patterns WHERE counterparty_name = 'SomeShop'"
  ).get() as any;
  assert.equal(pattern, undefined, 'should not create pattern on rejection');

  const conf = db.prepare('SELECT status FROM pattern_confirmations WHERE id = ?').get(confId) as any;
  assert.equal(conf.status, 'rejected');
});

test('listPendingConfirmations returns only pending', () => {
  const acct = mkAccount();
  mkConfirmation(acct, 'A', 1, 300.00, 'pending');
  mkConfirmation(acct, 'B', 2, 150.00, 'confirmed');
  mkConfirmation(acct, 'C', 3, 200.00, 'rejected');

  const pending = listPendingConfirmations();
  assert.equal(pending.length, 1);
  assert.equal((pending[0] as any).counterparty_name, 'A');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/pattern-confirmations.test.ts`
Expected: fail (module not found)

- [ ] **Step 3: Create `patternConfirmations.ts`**

Create `apps/api/src/patternConfirmations.ts`:

```typescript
import crypto from 'crypto';
import { db } from './db.js';

export type PatternConfirmation = {
  id: string;
  created_at: string;
  account_id: string;
  counterparty_name: string;
  typical_month: number;
  typical_amount: number;
  currency: string;
  status: string;
};

export function listPendingConfirmations(): PatternConfirmation[] {
  return db.prepare(
    'SELECT * FROM pattern_confirmations WHERE status = ? ORDER BY typical_amount DESC LIMIT 10'
  ).all('pending') as PatternConfirmation[];
}

export function confirmPatternConfirmation(id: string): void {
  const conf = db.prepare('SELECT * FROM pattern_confirmations WHERE id = ?').get(id) as PatternConfirmation | undefined;
  if (!conf) throw new Error('not_found');

  const now = new Date().toISOString();
  const approxDate = `${new Date().getFullYear()}-${String(conf.typical_month).padStart(2, '0')}-01`;

  const existing = db.prepare(
    'SELECT id FROM recurring_patterns WHERE account_id = ? AND counterparty_name = ?'
  ).get(conf.account_id, conf.counterparty_name) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE recurring_patterns SET updated_at = ?, pattern_type = 'annual',
        interval_days = 365, typical_amount = ?, is_active = 1,
        typical_month = ?, user_confirmed = 1
      WHERE id = ?
    `).run(now, conf.typical_amount, conf.typical_month, existing.id);
  } else {
    db.prepare(`
      INSERT INTO recurring_patterns
        (id, created_at, updated_at, account_id, counterparty_name, pattern_type,
         interval_days, typical_amount, currency, first_seen, last_seen,
         occurrence_count, is_active, typical_month, user_confirmed)
      VALUES (?, ?, ?, ?, ?, 'annual', 365, ?, ?, ?, ?, 1, 1, ?, 1)
    `).run(
      crypto.randomUUID(), now, now, conf.account_id, conf.counterparty_name,
      conf.typical_amount, conf.currency, approxDate, approxDate, conf.typical_month
    );
  }

  db.prepare('UPDATE pattern_confirmations SET status = ?, resolved_at = ? WHERE id = ?')
    .run('confirmed', now, id);
}

export function rejectPatternConfirmation(id: string): void {
  const conf = db.prepare('SELECT id FROM pattern_confirmations WHERE id = ?').get(id);
  if (!conf) throw new Error('not_found');
  db.prepare('UPDATE pattern_confirmations SET status = ?, resolved_at = ? WHERE id = ?')
    .run('rejected', new Date().toISOString(), id);
}
```

- [ ] **Step 4: Add `pendingConfirmations()` generator to `briefing.ts`**

In `apps/api/src/briefing.ts`, add the import at the top:
```typescript
import { listPendingConfirmations } from './patternConfirmations.js';
```

Add this function before the `GENERATORS` array:
```typescript
function pendingConfirmations(): FindingInput[] {
  const MONTHS = ['tammikuu', 'helmikuu', 'maaliskuu', 'huhtikuu', 'toukokuu', 'kesäkuu',
                  'heinäkuu', 'elokuu', 'syyskuu', 'lokakuu', 'marraskuu', 'joulukuu'];

  return listPendingConfirmations().slice(0, 3).map((c) => ({
    finding_type: 'pattern_confirmation',
    title: `Tuleeko ${c.counterparty_name} ensi vuonna uudelleen?`,
    description: `${fmt(c.typical_amount)} veloitus ${MONTHS[c.typical_month - 1]}ssa — onko tämä vuosittainen maksu?`,
    severity: 'info' as const,
    impact_eur: c.typical_amount,
    metadata: { confirmationId: c.id, counterparty: c.counterparty_name, month: c.typical_month },
  }));
}
```

Add `pendingConfirmations` to the `GENERATORS` array (append at the end).

- [ ] **Step 5: Add API endpoints to `index.ts`**

In `apps/api/src/index.ts`, add the import:
```typescript
import { listPendingConfirmations, confirmPatternConfirmation, rejectPatternConfirmation } from './patternConfirmations.js';
```

Add these endpoints after the balance-adjustments section:
```typescript
server.get('/pattern-confirmations', async () => listPendingConfirmations());

server.post<{ Params: { id: string } }>('/pattern-confirmations/:id/confirm', async (request, reply) => {
  const { id } = request.params;
  try {
    confirmPatternConfirmation(id);
    return reply.send({ ok: true });
  } catch (err: any) {
    return reply.code(err.message === 'not_found' ? 404 : 500).send({ error: err.message });
  }
});

server.post<{ Params: { id: string } }>('/pattern-confirmations/:id/reject', async (request, reply) => {
  const { id } = request.params;
  try {
    rejectPatternConfirmation(id);
    return reply.send({ ok: true });
  } catch (err: any) {
    return reply.code(err.message === 'not_found' ? 404 : 500).send({ error: err.message });
  }
});
```

- [ ] **Step 6: Run tests**

Run: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/pattern-confirmations.test.ts`
Expected: 3/3 pass

Run full suite: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 "tests/**/*.ts"`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/patternConfirmations.ts apps/api/src/briefing.ts apps/api/src/index.ts apps/api/tests/pattern-confirmations.test.ts
git commit -m "feat(api): pattern confirmation flow — list/confirm/reject + pendingConfirmations briefing generator"
```

---

### Task 4: Forecast Engine

**Goal:** `forecast.ts` aggregates known recurring costs + calendar-month historical averages into a 3-month projected spend; `GET /forecast` exposes it; `monthlyForecast()` warns when next month looks expensive.

**Files:**
- Create: `apps/api/src/forecast.ts`
- Create: `apps/api/tests/forecast.test.ts`
- Modify: `apps/api/src/briefing.ts`
- Modify: `apps/api/src/index.ts`

**Acceptance Criteria:**
- [ ] `computeMonthlyForecast(1)` returns `{ targetMonth, knownFixed, historicalAvg, annualItems, projectedTotal }`
- [ ] `knownFixed` contains all active `subscription`/`recurring` patterns
- [ ] `annualItems` contains active `annual` patterns with `typical_month` matching target month
- [ ] `historicalAvg` is the average of same calendar month in prior years (0 if no history)
- [ ] `projectedTotal` = `max(historicalAvg, knownFixedTotal)` + `annualItemsTotal`
- [ ] `monthlyForecast()` returns `severity: 'warn'` when `projectedTotal >= recentAvg * 1.3`
- [ ] `GET /forecast` returns array of 3 forecast objects

**Verify:** `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/forecast.test.ts` → 4/4 pass

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `apps/api/tests/forecast.test.ts`:

```typescript
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DB_PATH = ':memory:';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import { computeMonthlyForecast } from '../src/forecast.js';

initDb();

function mkAccount() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'Test', null, 'bank', 'checking');
  return id;
}

function mkSession() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), 'test', 'csv', 'x', 1, crypto.randomUUID());
  return id;
}

function mkPattern(accountId: string, counterparty: string, type: string, amount: number, typicalMonth: number | null = null) {
  const now = new Date().toISOString();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO recurring_patterns
    (id, created_at, updated_at, account_id, counterparty_name, pattern_type, interval_days,
     typical_amount, currency, first_seen, last_seen, occurrence_count, is_active, typical_month)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, 2, 1, ?)`)
    .run(
      crypto.randomUUID(), now, now, accountId, counterparty, type,
      type === 'annual' ? 365 : 30, amount, today, today, typicalMonth
    );
}

function mkTxOnDate(accountId: string, sessionId: string, amount: number, date: string) {
  const id = crypto.randomUUID();
  const raw = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(raw, now, sessionId, '{}', date, amount, 'EUR');
  db.prepare('INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name, description, counterparty_iban, transaction_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, raw, sessionId, accountId, date, date, amount, 'EUR', 'Shop', null, null, null);
  return id;
}

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM pattern_confirmations; DELETE FROM recurring_patterns;
    DELETE FROM transfer_links; DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions; DELETE FROM import_sessions; DELETE FROM accounts;
    DELETE FROM categorization_decisions; DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
});

test('forecast includes active monthly subscriptions in knownFixed', () => {
  const acct = mkAccount();
  mkPattern(acct, 'Netflix', 'subscription', 15.99);
  mkPattern(acct, 'Spotify', 'subscription', 9.99);

  const forecast = computeMonthlyForecast(1);
  assert.ok(forecast.knownFixed.length >= 2, 'should have at least 2 fixed items');
  const total = forecast.knownFixed.reduce((s: number, i: any) => s + i.amount, 0);
  assert.ok(total >= 25, `knownFixed total ${total} should be >= 25`);
});

test('forecast includes annual items for matching target month only', () => {
  const acct = mkAccount();
  const targetDate = new Date();
  targetDate.setDate(1);
  targetDate.setMonth(targetDate.getMonth() + 1);
  const targetMonth = targetDate.getMonth() + 1;
  const otherMonth = (targetMonth % 12) + 1;

  mkPattern(acct, 'IF Vakuutus', 'annual', 312.50, targetMonth);
  mkPattern(acct, 'Car Insurance', 'annual', 250.00, otherMonth);

  const forecast = computeMonthlyForecast(1);
  assert.equal(forecast.annualItems.length, 1, 'should include only the annual item matching target month');
  assert.equal(forecast.annualItems[0].counterparty, 'IF Vakuutus');
  assert.ok(forecast.projectedTotal >= 312.50);
});

test('forecast projectedTotal includes annual items added on top of variable base', () => {
  const acct = mkAccount();
  const targetDate = new Date();
  targetDate.setDate(1);
  targetDate.setMonth(targetDate.getMonth() + 1);
  const targetMonth = targetDate.getMonth() + 1;

  mkPattern(acct, 'Netflix', 'subscription', 15.99);
  mkPattern(acct, 'IF Vakuutus', 'annual', 300.00, targetMonth);

  const forecast = computeMonthlyForecast(1);
  assert.ok(forecast.projectedTotal >= 315.99, `projectedTotal ${forecast.projectedTotal} should be >= 315.99`);
});

test('forecast returns required shape with zero data', () => {
  const forecast = computeMonthlyForecast(1);
  assert.ok('targetMonth' in forecast, 'should have targetMonth');
  assert.ok('knownFixed' in forecast, 'should have knownFixed');
  assert.ok('historicalAvg' in forecast, 'should have historicalAvg');
  assert.ok('annualItems' in forecast, 'should have annualItems');
  assert.ok('projectedTotal' in forecast, 'should have projectedTotal');
  assert.equal(typeof forecast.projectedTotal, 'number');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/forecast.test.ts`
Expected: fail (module not found)

- [ ] **Step 3: Create `forecast.ts`**

Create `apps/api/src/forecast.ts`:

```typescript
import { db } from './db.js';

export type ForecastItem = { counterparty: string; amount: number };
export type AnnualForecastItem = { counterparty: string; amount: number; month: number };

export type MonthlyForecast = {
  targetMonth: string;
  knownFixed: ForecastItem[];
  historicalAvg: number;
  annualItems: AnnualForecastItem[];
  projectedTotal: number;
};

export function computeMonthlyForecast(targetMonthOffset: number): MonthlyForecast {
  const targetDate = new Date();
  targetDate.setDate(1);
  targetDate.setMonth(targetDate.getMonth() + targetMonthOffset);
  const targetMonth = targetDate.getMonth() + 1; // 1–12
  const targetYear = targetDate.getFullYear();
  const targetMonthStr = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;

  const monthlyPatterns = db.prepare(`
    SELECT counterparty_name, typical_amount FROM recurring_patterns
    WHERE pattern_type IN ('subscription', 'recurring') AND is_active = 1
    ORDER BY typical_amount DESC
  `).all() as Array<{ counterparty_name: string; typical_amount: number }>;

  const knownFixed: ForecastItem[] = monthlyPatterns.map((p) => ({
    counterparty: p.counterparty_name,
    amount: p.typical_amount,
  }));

  const annualPatterns = db.prepare(`
    SELECT counterparty_name, typical_amount, typical_month FROM recurring_patterns
    WHERE pattern_type = 'annual' AND is_active = 1 AND typical_month = ?
      AND (user_confirmed IS NULL OR user_confirmed = 1)
    ORDER BY typical_amount DESC
  `).all(targetMonth) as Array<{ counterparty_name: string; typical_amount: number; typical_month: number }>;

  const annualItems: AnnualForecastItem[] = annualPatterns.map((p) => ({
    counterparty: p.counterparty_name,
    amount: p.typical_amount,
    month: p.typical_month,
  }));

  const monthPad = String(targetMonth).padStart(2, '0');
  const historicalRows = db.prepare(`
    SELECT SUM(ABS(amount)) AS total
    FROM normalized_transactions
    WHERE strftime('%m', booking_date) = ?
      AND strftime('%Y', booking_date) < ?
      AND amount < 0
      AND id NOT IN (
        SELECT from_transaction_id FROM transfer_links
        UNION SELECT to_transaction_id FROM transfer_links
      )
    GROUP BY strftime('%Y', booking_date)
    ORDER BY booking_date DESC
    LIMIT 3
  `).all(monthPad, String(targetYear)) as Array<{ total: number }>;

  const historicalAvg =
    historicalRows.length > 0
      ? historicalRows.reduce((s, r) => s + r.total, 0) / historicalRows.length
      : 0;

  const knownFixedTotal = knownFixed.reduce((s, i) => s + i.amount, 0);
  const annualTotal = annualItems.reduce((s, i) => s + i.amount, 0);
  const variableBase = Math.max(historicalAvg, knownFixedTotal);
  const projectedTotal = variableBase + annualTotal;

  return { targetMonth: targetMonthStr, knownFixed, historicalAvg, annualItems, projectedTotal };
}

export function getForecast(): MonthlyForecast[] {
  return [1, 2, 3].map((offset) => computeMonthlyForecast(offset));
}
```

- [ ] **Step 4: Add `monthlyForecast()` generator to `briefing.ts`**

In `apps/api/src/briefing.ts`, add the import at the top:
```typescript
import { computeMonthlyForecast } from './forecast.js';
```

Add this function before the `GENERATORS` array:
```typescript
function monthlyForecast(): FindingInput[] {
  const MONTHS = ['tammikuu', 'helmikuu', 'maaliskuu', 'huhtikuu', 'toukokuu', 'kesäkuu',
                  'heinäkuu', 'elokuu', 'syyskuu', 'lokakuu', 'marraskuu', 'joulukuu'];

  const forecast = computeMonthlyForecast(1);
  if (forecast.projectedTotal === 0) return [];

  const threeMonthsAgo = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
  const recentRow = db.prepare(`
    SELECT AVG(monthly_total) AS avg_spend FROM (
      SELECT SUM(ABS(amount)) AS monthly_total
      FROM normalized_transactions
      WHERE booking_date >= ? AND amount < 0
        AND id NOT IN (
          SELECT from_transaction_id FROM transfer_links
          UNION SELECT to_transaction_id FROM transfer_links
        )
      GROUP BY strftime('%Y-%m', booking_date)
      LIMIT 3
    )
  `).get(threeMonthsAgo) as { avg_spend: number | null };

  const recentAvg = recentRow?.avg_spend ?? 0;
  const isExpensive = recentAvg > 0 && forecast.projectedTotal >= recentAvg * 1.3;

  const [year, month] = forecast.targetMonth.split('-');
  const monthName = MONTHS[parseInt(month, 10) - 1];

  const annualNote =
    forecast.annualItems.length > 0
      ? ` + vuosikuluja: ${forecast.annualItems.map((i) => `${i.counterparty} ${fmt(i.amount)}`).join(', ')}`
      : '';

  return [{
    finding_type: 'monthly_forecast',
    title: `Ennuste ${monthName}lle ${year}: ${fmt(forecast.projectedTotal)}`,
    description: `Tiedossa: ${forecast.knownFixed.length} kuukausimaksua (${fmt(forecast.knownFixed.reduce((s, i) => s + i.amount, 0))})${annualNote}. Historiakeskiarvo ${monthName}lle: ${forecast.historicalAvg > 0 ? fmt(forecast.historicalAvg) : 'ei dataa'}.`,
    severity: isExpensive ? 'warn' : 'info',
    impact_eur: forecast.projectedTotal,
    metadata: {
      targetMonth: forecast.targetMonth,
      projectedTotal: forecast.projectedTotal,
      knownFixedCount: forecast.knownFixed.length,
      annualItemsCount: forecast.annualItems.length,
    },
  }];
}
```

Add `monthlyForecast` to the `GENERATORS` array (append at the end).

- [ ] **Step 5: Add `GET /forecast` to `index.ts`**

In `apps/api/src/index.ts`, add the import:
```typescript
import { getForecast } from './forecast.js';
```

Add the endpoint:
```typescript
server.get('/forecast', async () => getForecast());
```

- [ ] **Step 6: Run tests**

Run: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/forecast.test.ts`
Expected: 4/4 pass

Run full suite: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 "tests/**/*.ts"`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/forecast.ts apps/api/src/briefing.ts apps/api/src/index.ts apps/api/tests/forecast.test.ts
git commit -m "feat(api): monthly forecast engine + briefing generator + GET /forecast endpoint"
```

---

### Task 5: UI — Confirmation Cards + Forecast Panel

**Goal:** `PatternConfirmationCard` handles `pattern_confirmation` findings in `BriefingPanel`; `ForecastPanel` shows next 3 months projected spend.

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Create: `apps/web/src/components/PatternConfirmationCard.tsx`
- Modify: `apps/web/src/components/BriefingPanel.tsx`
- Create: `apps/web/src/components/ForecastPanel.tsx`
- Modify: `apps/web/src/views/HomeView.tsx`

**Acceptance Criteria:**
- [ ] `BriefingPanel` renders `PatternConfirmationCard` for `finding_type === 'pattern_confirmation'`
- [ ] `PatternConfirmationCard` shows counterparty, amount, month name + "Kyllä, vuosittainen" / "Ei, kertaluonteinen" buttons
- [ ] "Kyllä" calls `POST /pattern-confirmations/:id/confirm`, removes card optimistically
- [ ] "Ei" calls `POST /pattern-confirmations/:id/reject`, removes card optimistically
- [ ] `ForecastPanel` renders next 3 months with `projectedTotal`, `annualItems`, `knownFixed.length`
- [ ] `ForecastPanel` mounted in `HomeView` between `CfoStatePanel` and `BriefingPanel`

**Steps:**

- [ ] **Step 1: Add types and functions to `api/client.ts`**

Add types after the existing `BriefingSession` type:

```typescript
export type PatternConfirmationRecord = {
  id: string;
  created_at: string;
  account_id: string;
  counterparty_name: string;
  typical_month: number;
  typical_amount: number;
  currency: string;
  status: string;
};

export type ForecastItem = { counterparty: string; amount: number };
export type AnnualForecastItem = { counterparty: string; amount: number; month: number };
export type MonthlyForecast = {
  targetMonth: string;
  knownFixed: ForecastItem[];
  historicalAvg: number;
  annualItems: AnnualForecastItem[];
  projectedTotal: number;
};
```

Add functions after `dismissFinding`:

```typescript
export async function getForecast(): Promise<MonthlyForecast[]> {
  const res = await safeFetch(`${API}/forecast`);
  if (!res.ok) throw new Error(`getForecast failed: ${res.statusText}`);
  return res.json();
}

export async function confirmPatternConfirmation(id: string): Promise<void> {
  const res = await safeFetch(`${API}/pattern-confirmations/${id}/confirm`, { method: 'POST' });
  if (!res.ok) throw new Error(`confirmPatternConfirmation failed: ${res.statusText}`);
}

export async function rejectPatternConfirmation(id: string): Promise<void> {
  const res = await safeFetch(`${API}/pattern-confirmations/${id}/reject`, { method: 'POST' });
  if (!res.ok) throw new Error(`rejectPatternConfirmation failed: ${res.statusText}`);
}
```

- [ ] **Step 2: Create `PatternConfirmationCard.tsx`**

Create `apps/web/src/components/PatternConfirmationCard.tsx`:

```tsx
import { confirmPatternConfirmation, rejectPatternConfirmation } from '../api/client';
import type { InsightFinding } from '../api/client';

const MONTHS = ['tammikuu', 'helmikuu', 'maaliskuu', 'huhtikuu', 'toukokuu', 'kesäkuu',
                'heinäkuu', 'elokuu', 'syyskuu', 'lokakuu', 'marraskuu', 'joulukuu'];

type Props = {
  finding: InsightFinding;
  onResolved: (findingId: string) => void;
  setToast: (v: string) => void;
};

export default function PatternConfirmationCard({ finding, onResolved, setToast }: Props) {
  const meta = finding.metadata as { confirmationId?: string; counterparty?: string; month?: number };
  const confirmationId = meta.confirmationId;
  const monthName = meta.month ? MONTHS[meta.month - 1] : '?';
  const amount = finding.impactEur !== null ? `${finding.impactEur.toFixed(2)} €` : '';

  const handleConfirm = async () => {
    if (!confirmationId) return;
    try {
      await confirmPatternConfirmation(confirmationId);
      setToast(`Merkitty vuosittaiseksi: ${meta.counterparty}`);
      onResolved(finding.id);
    } catch {
      setToast('Virhe vahvistuksessa');
    }
  };

  const handleReject = async () => {
    if (!confirmationId) return;
    try {
      await rejectPatternConfirmation(confirmationId);
      setToast('Ohitettu');
      onResolved(finding.id);
    } catch {
      setToast('Virhe hylkäyksessä');
    }
  };

  return (
    <div className="finding-card finding-card-info">
      <div className="finding-header">
        <span className="chip">Kysymys</span>
        <strong>{meta.counterparty ?? finding.title}</strong>
      </div>
      <p className="finding-desc">
        {amount} {monthName}ssa — tuleeko tämä maksu ensi vuonna todennäköisesti uudelleen?
      </p>
      <div className="finding-actions">
        <button className="mini" type="button" onClick={handleConfirm}>
          Kyllä, vuosittainen
        </button>
        <button className="mini ghost" type="button" onClick={handleReject}>
          Ei, kertaluonteinen
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Update `BriefingPanel.tsx`**

In `apps/web/src/components/BriefingPanel.tsx`:

Add import:
```tsx
import PatternConfirmationCard from './PatternConfirmationCard';
```

Add `handleResolved` (same as dismiss — optimistically hides finding):
```tsx
const handleResolved = (findingId: string) => {
  setDismissed((prev) => new Set(prev).add(findingId));
};
```

Replace the `visibleFindings.map(...)` block with:
```tsx
{visibleFindings.map((finding) => (
  <div key={finding.id}>
    {finding.findingType === 'pattern_confirmation' ? (
      <PatternConfirmationCard
        finding={finding}
        onResolved={handleResolved}
        setToast={setToast}
      />
    ) : (
      <>
        <FindingCard finding={finding} onDismiss={handleDismiss} />
        {onFilterTransactions && finding.transactionIds.length > 0 && (
          <button className="mini" onClick={() => onFilterTransactions(finding.transactionIds)}>
            Näytä tapahtumat
          </button>
        )}
      </>
    )}
  </div>
))}
```

- [ ] **Step 4: Create `ForecastPanel.tsx`**

Create `apps/web/src/components/ForecastPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { getForecast } from '../api/client';
import type { MonthlyForecast } from '../api/client';

const MONTH_NAMES = ['tammi', 'helmi', 'maalis', 'huhti', 'touko', 'kesä',
                     'heinä', 'elo', 'syys', 'loka', 'marras', 'joulu'];

function fmt(n: number) {
  return n.toLocaleString('fi-FI', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
}

export default function ForecastPanel() {
  const [forecasts, setForecasts] = useState<MonthlyForecast[]>([]);

  useEffect(() => {
    getForecast().then(setForecasts).catch(() => {});
  }, []);

  if (forecasts.length === 0 || forecasts.every((f) => f.projectedTotal === 0)) return null;

  return (
    <section className="card glass">
      <div className="card-head">
        <div>
          <p className="eyebrow">Tulevat kulut</p>
          <h2>3 kuukauden ennuste</h2>
        </div>
      </div>
      <div className="forecast-grid">
        {forecasts.map((f) => {
          const [year, month] = f.targetMonth.split('-');
          const monthLabel = MONTH_NAMES[parseInt(month, 10) - 1] + 'kuu ' + year;
          return (
            <div key={f.targetMonth} className="forecast-month">
              <div className="forecast-label">{monthLabel}</div>
              <div className="forecast-total">{fmt(f.projectedTotal)}</div>
              {f.annualItems.length > 0 && (
                <div className="forecast-annual">
                  {f.annualItems.map((i) => (
                    <span key={i.counterparty} className="chip chip-annual">
                      {i.counterparty} {fmt(i.amount)}
                    </span>
                  ))}
                </div>
              )}
              <div className="forecast-meta">
                {f.knownFixed.length} kuukausimaksua
                {f.historicalAvg > 0 && ` · historia: ${fmt(f.historicalAvg)}`}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Mount `ForecastPanel` in `HomeView.tsx`**

In `apps/web/src/views/HomeView.tsx`:

Add import:
```tsx
import ForecastPanel from '../components/ForecastPanel';
```

Add between `<CfoStatePanel>` and `<BriefingPanel>`:
```tsx
<ForecastPanel />
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/components/PatternConfirmationCard.tsx apps/web/src/components/ForecastPanel.tsx apps/web/src/components/BriefingPanel.tsx apps/web/src/views/HomeView.tsx
git commit -m "feat(web): pattern confirmation UI cards + 3-month forecast panel"
```
