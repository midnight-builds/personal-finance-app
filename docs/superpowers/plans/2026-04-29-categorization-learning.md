# Categorization Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix accumulation of duplicate category rules from repeated user decisions, and expose AI-generated rule suggestions in the UI so users can approve rules with one click instead of manually categorizing the same counterparty repeatedly.

**Architecture:** `upsertDecision()` in `rules.ts` gets a duplicate-check guard before inserting a new rule; a one-time SQL migration in `db.ts` deduplicates existing rules. New `ruleSuggestions.ts` scans "Muut ja epäselvät" transactions, batches top counterparties through the existing `aiCategorize()`, and stores candidates in a new `rule_suggestions` table. `generateRuleSuggestions()` is called fire-and-forget from the import pipeline after categorization. A new `RuleSuggestionsPanel` in the web app renders pending suggestions with approve/reject.

**Tech Stack:** Node.js SQLite, Fastify, React 19/Vite, Node.js `node:test` + `assert/strict`

---

## File Structure

| File | Change |
|------|--------|
| `apps/api/src/db.ts` | Add `rule_suggestions` table; add dedup migration for `category_rules` |
| `apps/api/src/rules.ts` | Guard `upsertDecision` against duplicate rule insertion |
| `apps/api/tests/rules.test.ts` | Add 2 test cases for dedup behavior |
| `apps/api/src/ruleSuggestions.ts` | Create: `listPendingRuleSuggestions()`, `acceptRuleSuggestion()`, `rejectRuleSuggestion()`, `generateRuleSuggestions()` |
| `apps/api/tests/rule-suggestions.test.ts` | Create: 4 test cases |
| `apps/api/src/importer.ts` | Call `generateRuleSuggestions()` fire-and-forget at end of `processImport` |
| `apps/api/src/index.ts` | Add `GET /rule-suggestions`, `POST /rule-suggestions/:id/accept`, `POST /rule-suggestions/:id/reject` |
| `apps/web/src/api/client.ts` | Add `RuleSuggestion` type + 3 functions |
| `apps/web/src/components/RuleSuggestionsPanel.tsx` | Create: panel with approve/reject buttons |
| `apps/web/src/views/HomeView.tsx` | Mount `RuleSuggestionsPanel` after `BriefingPanel` |

---

### Task 1: Rule Deduplication

**Goal:** Prevent duplicate `category_rules` from repeated user decisions on the same counterparty; deduplicate existing rules.

**Files:**
- Modify: `apps/api/src/db.ts`
- Modify: `apps/api/src/rules.ts`
- Modify: `apps/api/tests/rules.test.ts`

**Acceptance Criteria:**
- [ ] Calling `upsertDecision` twice with same counterparty + category creates exactly 1 rule
- [ ] Calling `upsertDecision` with same counterparty but different categories creates 2 rules
- [ ] Existing duplicate rules (same `pattern` + `category_id` + `match_field`) are removed on startup
- [ ] All existing `rules.test.ts` tests still pass

**Verify:** `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/rules.test.ts` → all pass

**Steps:**

- [ ] **Step 1: Write failing tests**

Open `apps/api/tests/rules.test.ts`. Add a `getCategoryId` helper after the existing `createTx` function:

```typescript
function getCategoryId(name: string): string {
  const row = db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string } | undefined;
  if (!row) throw new Error(`Category not found: ${name}`);
  return row.id;
}
```

Add a `mkTxFull` helper (the existing `createTx` doesn't set `counterparty_name`):

```typescript
function mkTxFull(counterparty: string): string {
  const id = crypto.randomUUID();
  const acctId = crypto.randomUUID();
  const sessId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)')
    .run(acctId, now, 'Test', null, 'bank');
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format) VALUES (?, ?, ?, ?)')
    .run(sessId, now, 'Test', 'CSV');
  db.prepare('INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, amount, currency, counterparty_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, now, null, sessId, acctId, now, -30, 'EUR', counterparty);
  return id;
}
```

Append these two test cases at the end of the file:

```typescript
test('upsertDecision does not create duplicate rule for same counterparty+category', () => {
  const txId1 = mkTxFull('K-Market');
  const txId2 = mkTxFull('K-Market');
  const catId = getCategoryId('Ruoka ja päivittäistavarat');

  upsertDecision({ transactionId: txId1, categoryId: catId, source: 'user', counterparty: 'K-Market' });
  upsertDecision({ transactionId: txId2, categoryId: catId, source: 'user', counterparty: 'K-Market' });

  const rules = db.prepare("SELECT * FROM category_rules WHERE pattern = 'k-market'").all() as any[];
  assert.equal(rules.length, 1, 'should have exactly one rule for K-Market');
});

test('upsertDecision creates separate rules for same counterparty with different categories', () => {
  const txId1 = mkTxFull('S-Market');
  const txId2 = mkTxFull('S-Market');
  const catFood = getCategoryId('Ruoka ja päivittäistavarat');
  const catMisc = getCategoryId('Muut ja epäselvät');

  upsertDecision({ transactionId: txId1, categoryId: catFood, source: 'user', counterparty: 'S-Market' });
  upsertDecision({ transactionId: txId2, categoryId: catMisc, source: 'user', counterparty: 'S-Market' });

  const rules = db.prepare("SELECT * FROM category_rules WHERE pattern = 's-market'").all() as any[];
  assert.equal(rules.length, 2, 'different categories should produce separate rules');
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/rules.test.ts`
Expected: existing tests pass, 2 new tests fail (duplicate rules being created)

- [ ] **Step 3: Add duplicate guard to `upsertDecision` in `rules.ts`**

In `apps/api/src/rules.ts`, inside `upsertDecision()`, replace the `if (source === 'user')` block:

```typescript
// BEFORE:
if (source === 'user') {
  const pattern = (counterparty || description || '').trim();
  if (pattern.length >= 3) {
    db.prepare(
      'INSERT INTO category_rules (id, created_at, category_id, pattern, match_field, priority) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), now, categoryId, pattern.toLowerCase(), counterparty ? 'counterparty' : 'description', 10);
  }
}
```

```typescript
// AFTER:
if (source === 'user') {
  const pattern = (counterparty || description || '').trim();
  if (pattern.length >= 3) {
    const matchField = counterparty ? 'counterparty' : 'description';
    const existingRule = db.prepare(
      'SELECT id FROM category_rules WHERE pattern = ? AND category_id = ? AND match_field = ? LIMIT 1'
    ).get(pattern.toLowerCase(), categoryId, matchField);
    if (!existingRule) {
      db.prepare(
        'INSERT INTO category_rules (id, created_at, category_id, pattern, match_field, priority) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(crypto.randomUUID(), now, categoryId, pattern.toLowerCase(), matchField, 10);
    }
  }
}
```

- [ ] **Step 4: Add dedup migration to `db.ts`**

In `apps/api/src/db.ts`, after the existing `safeExec` calls at the bottom of `initDb()`, add:

```typescript
safeExec(`
  DELETE FROM category_rules WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM category_rules GROUP BY pattern, category_id, match_field
  )
`);
```

- [ ] **Step 5: Run tests**

Run: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/rules.test.ts`
Expected: all tests pass including the 2 new ones

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/rules.ts apps/api/src/db.ts apps/api/tests/rules.test.ts
git commit -m "fix(api): prevent duplicate category rules + deduplicate existing rules on startup"
```

---

### Task 2: AI Rule Suggestion Backend

**Goal:** New `ruleSuggestions.ts` generates AI-powered suggestions for uncategorized transactions; REST endpoints let the UI list, accept, and reject them.

**Files:**
- Modify: `apps/api/src/db.ts`
- Create: `apps/api/src/ruleSuggestions.ts`
- Create: `apps/api/tests/rule-suggestions.test.ts`
- Modify: `apps/api/src/importer.ts`
- Modify: `apps/api/src/index.ts`

**Acceptance Criteria:**
- [ ] `rule_suggestions` table exists with `id, created_at, category_id, category_name, pattern, match_field, sample_counterparty, ai_reason, confidence, status`
- [ ] `listPendingRuleSuggestions()` returns only `status='pending'` rows
- [ ] `acceptRuleSuggestion(id)` creates a `category_rules` row (skips if duplicate), applies to matching "Muut" transactions, sets `status='accepted'`
- [ ] `rejectRuleSuggestion(id)` sets `status='rejected'` without creating a rule
- [ ] `generateRuleSuggestions()` returns immediately (no-op) when no OpenAI key is configured
- [ ] Import pipeline calls `generateRuleSuggestions()` fire-and-forget

**Verify:** `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/rule-suggestions.test.ts` → 4/4 pass

**Steps:**

- [ ] **Step 1: Add `rule_suggestions` table to `db.ts`**

Inside the `db.exec(...)` block in `initDb()`, after the `pattern_confirmations` table (or after `recurring_patterns` if Plan 1 hasn't been applied yet), add:

```sql
CREATE TABLE IF NOT EXISTS rule_suggestions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  category_id TEXT NOT NULL,
  category_name TEXT NOT NULL,
  pattern TEXT NOT NULL,
  match_field TEXT NOT NULL DEFAULT 'counterparty',
  sample_counterparty TEXT,
  ai_reason TEXT,
  confidence REAL NOT NULL DEFAULT 0.8,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_at TEXT,
  FOREIGN KEY(category_id) REFERENCES categories(id)
);
CREATE INDEX IF NOT EXISTS idx_rule_suggestions_status ON rule_suggestions(status);
```

Also add `DELETE FROM rule_suggestions;` to both `/debug/clear` and `/debug/clear-imports` exec blocks in `apps/api/src/index.ts`.

- [ ] **Step 2: Write failing tests**

Create `apps/api/tests/rule-suggestions.test.ts`:

```typescript
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DB_PATH = ':memory:';

import { initDb, db, seedDefaultCategories } from '../src/db.js';
import {
  listPendingRuleSuggestions,
  acceptRuleSuggestion,
  rejectRuleSuggestion,
} from '../src/ruleSuggestions.js';

initDb();

function getCategoryId(name: string): string {
  const row = db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string } | undefined;
  if (!row) throw new Error(`Category not found: ${name}`);
  return row.id;
}

function mkSuggestion(categoryName: string, pattern: string, status = 'pending') {
  const id = crypto.randomUUID();
  const categoryId = getCategoryId(categoryName);
  db.prepare(`
    INSERT INTO rule_suggestions
      (id, created_at, category_id, category_name, pattern, match_field, sample_counterparty, ai_reason, confidence, status)
    VALUES (?, ?, ?, ?, ?, 'counterparty', ?, 'AI reason', 0.9, ?)
  `).run(id, new Date().toISOString(), categoryId, categoryName, pattern, pattern, status);
  return id;
}

beforeEach(() => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM rule_suggestions;
    DELETE FROM category_rules; DELETE FROM categorization_decisions;
    DELETE FROM transfer_links; DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions; DELETE FROM import_sessions; DELETE FROM accounts;
    DELETE FROM categories WHERE built_in = 0;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
});

test('listPendingRuleSuggestions returns only pending', () => {
  mkSuggestion('Ruoka ja päivittäistavarat', 'k-market', 'pending');
  mkSuggestion('Auto ja liikkuminen', 'neste', 'accepted');
  mkSuggestion('Laskut ja sopimukset', 'helen', 'rejected');

  const pending = listPendingRuleSuggestions();
  assert.equal(pending.length, 1);
  assert.equal((pending[0] as any).pattern, 'k-market');
});

test('acceptRuleSuggestion creates category_rule and marks accepted', () => {
  const id = mkSuggestion('Ruoka ja päivittäistavarat', 's-market');

  acceptRuleSuggestion(id);

  const suggestion = db.prepare('SELECT status FROM rule_suggestions WHERE id = ?').get(id) as any;
  assert.equal(suggestion.status, 'accepted');

  const rule = db.prepare("SELECT * FROM category_rules WHERE pattern = 's-market'").get() as any;
  assert.ok(rule, 'should create category_rule');
  assert.equal(rule.match_field, 'counterparty');
});

test('acceptRuleSuggestion skips duplicate rule if one already exists', () => {
  const catId = getCategoryId('Ruoka ja päivittäistavarat');
  db.prepare(
    "INSERT INTO category_rules (id, created_at, category_id, pattern, match_field, priority) VALUES (?, ?, ?, 's-market', 'counterparty', 10)"
  ).run(crypto.randomUUID(), new Date().toISOString(), catId);

  const id = mkSuggestion('Ruoka ja päivittäistavarat', 's-market');
  acceptRuleSuggestion(id);

  const rules = db.prepare("SELECT * FROM category_rules WHERE pattern = 's-market'").all() as any[];
  assert.equal(rules.length, 1, 'should not create duplicate rule');
});

test('rejectRuleSuggestion marks rejected without creating a rule', () => {
  const id = mkSuggestion('Auto ja liikkuminen', 'neste');

  rejectRuleSuggestion(id);

  const suggestion = db.prepare('SELECT status FROM rule_suggestions WHERE id = ?').get(id) as any;
  assert.equal(suggestion.status, 'rejected');

  const rule = db.prepare("SELECT * FROM category_rules WHERE pattern = 'neste'").get() as any;
  assert.equal(rule, undefined, 'should not create rule on rejection');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/rule-suggestions.test.ts`
Expected: fail (module not found)

- [ ] **Step 4: Create `ruleSuggestions.ts`**

Create `apps/api/src/ruleSuggestions.ts`:

```typescript
import crypto from 'crypto';
import { db } from './db.js';
import { getOpenAIApiKey } from './settings.js';
import { aiCategorize } from './ai.js';

export type RuleSuggestion = {
  id: string;
  created_at: string;
  category_id: string;
  category_name: string;
  pattern: string;
  match_field: string;
  sample_counterparty: string | null;
  ai_reason: string | null;
  confidence: number;
  status: string;
};

export function listPendingRuleSuggestions(): RuleSuggestion[] {
  return db.prepare(
    'SELECT * FROM rule_suggestions WHERE status = ? ORDER BY confidence DESC, created_at DESC LIMIT 20'
  ).all('pending') as RuleSuggestion[];
}

export function acceptRuleSuggestion(id: string): void {
  const suggestion = db.prepare('SELECT * FROM rule_suggestions WHERE id = ?').get(id) as RuleSuggestion | undefined;
  if (!suggestion) throw new Error('not_found');

  const now = new Date().toISOString();

  const existingRule = db.prepare(
    'SELECT id FROM category_rules WHERE pattern = ? AND category_id = ? AND match_field = ? LIMIT 1'
  ).get(suggestion.pattern, suggestion.category_id, suggestion.match_field);

  if (!existingRule) {
    db.prepare(
      'INSERT INTO category_rules (id, created_at, category_id, pattern, match_field, priority) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), now, suggestion.category_id, suggestion.pattern, suggestion.match_field, 10);
  }

  // Apply to existing "Muut" transactions matching this counterparty
  const miscRow = db.prepare("SELECT id FROM categories WHERE name = 'Muut ja epäselvät' LIMIT 1").get() as { id: string } | undefined;
  if (miscRow) {
    const matching = db.prepare(`
      SELECT nt.id FROM normalized_transactions nt
      JOIN categorization_decisions cd ON cd.transaction_id = nt.id
      WHERE cd.category_id = ?
        AND LOWER(nt.counterparty_name) LIKE ?
    `).all(miscRow.id, `%${suggestion.pattern}%`) as Array<{ id: string }>;

    for (const tx of matching) {
      db.prepare('DELETE FROM categorization_decisions WHERE transaction_id = ?').run(tx.id);
      db.prepare(
        'INSERT INTO categorization_decisions (id, created_at, transaction_id, category_id, source, rule_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(crypto.randomUUID(), now, tx.id, suggestion.category_id, 'rule', null);
    }
  }

  db.prepare('UPDATE rule_suggestions SET status = ?, resolved_at = ? WHERE id = ?')
    .run('accepted', now, id);
}

export function rejectRuleSuggestion(id: string): void {
  const suggestion = db.prepare('SELECT id FROM rule_suggestions WHERE id = ?').get(id);
  if (!suggestion) throw new Error('not_found');
  db.prepare('UPDATE rule_suggestions SET status = ?, resolved_at = ? WHERE id = ?')
    .run('rejected', new Date().toISOString(), id);
}

export async function generateRuleSuggestions(): Promise<void> {
  if (!getOpenAIApiKey()) return;

  const miscRow = db.prepare("SELECT id FROM categories WHERE name = 'Muut ja epäselvät' LIMIT 1").get() as { id: string } | undefined;
  if (!miscRow) return;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

  const candidates = db.prepare(`
    SELECT nt.counterparty_name, COUNT(*) AS cnt, AVG(nt.amount) AS avg_amount
    FROM normalized_transactions nt
    JOIN categorization_decisions cd ON cd.transaction_id = nt.id
    WHERE cd.category_id = ?
      AND nt.counterparty_name IS NOT NULL
      AND nt.booking_date >= ?
      AND nt.amount < 0
      AND LOWER(nt.counterparty_name) NOT IN (
        SELECT pattern FROM rule_suggestions WHERE status = 'pending' AND match_field = 'counterparty'
      )
      AND LOWER(nt.counterparty_name) NOT IN (
        SELECT pattern FROM category_rules WHERE match_field = 'counterparty'
      )
    GROUP BY nt.counterparty_name
    ORDER BY cnt DESC
    LIMIT 10
  `).all(miscRow.id, thirtyDaysAgo) as Array<{ counterparty_name: string; cnt: number; avg_amount: number }>;

  for (const candidate of candidates) {
    try {
      const result = await aiCategorize({
        counterparty: candidate.counterparty_name,
        description: null,
        amount: candidate.avg_amount,
        currency: 'EUR',
      });

      let categoryId: string | null = null;
      let categoryName: string | null = null;
      let reason: string | null = null;

      if (result.mode === 'existing' && result.categoryId !== miscRow.id) {
        categoryId = result.categoryId;
        categoryName = result.categoryName;
      } else if (result.mode === 'options' && result.options.length > 0) {
        const top = result.options[0];
        if (top.categoryId !== miscRow.id) {
          categoryId = top.categoryId;
          categoryName = top.categoryName;
          reason = top.reason;
        }
      }

      if (!categoryId || !categoryName) continue;

      const alreadyPending = db.prepare(
        "SELECT 1 FROM rule_suggestions WHERE pattern = ? AND match_field = 'counterparty' AND status = 'pending'"
      ).get(candidate.counterparty_name.toLowerCase());
      if (alreadyPending) continue;

      db.prepare(`
        INSERT INTO rule_suggestions
          (id, created_at, category_id, category_name, pattern, match_field,
           sample_counterparty, ai_reason, confidence, status)
        VALUES (?, ?, ?, ?, ?, 'counterparty', ?, ?, 0.85, 'pending')
      `).run(
        crypto.randomUUID(),
        new Date().toISOString(),
        categoryId,
        categoryName,
        candidate.counterparty_name.toLowerCase(),
        candidate.counterparty_name,
        reason
      );
    } catch {
      // skip individual failures silently
    }
  }
}
```

- [ ] **Step 5: Call `generateRuleSuggestions` from `importer.ts`**

In `apps/api/src/importer.ts`, add the import:
```typescript
import { generateRuleSuggestions } from './ruleSuggestions.js';
```

At the very end of `processImport()` (after `runBriefing` is awaited and before `return result`), add:

```typescript
  // Fire-and-forget: non-blocking AI rule suggestions
  generateRuleSuggestions().catch((err) => {
    console.error('[importer] generateRuleSuggestions failed:', err);
  });
```

- [ ] **Step 6: Add API endpoints to `index.ts`**

In `apps/api/src/index.ts`, add the import:
```typescript
import { listPendingRuleSuggestions, acceptRuleSuggestion, rejectRuleSuggestion } from './ruleSuggestions.js';
```

Add these endpoints:
```typescript
server.get('/rule-suggestions', async () => listPendingRuleSuggestions());

server.post<{ Params: { id: string } }>('/rule-suggestions/:id/accept', async (request, reply) => {
  const { id } = request.params;
  try {
    acceptRuleSuggestion(id);
    return reply.send({ ok: true });
  } catch (err: any) {
    return reply.code(err.message === 'not_found' ? 404 : 500).send({ error: err.message });
  }
});

server.post<{ Params: { id: string } }>('/rule-suggestions/:id/reject', async (request, reply) => {
  const { id } = request.params;
  try {
    rejectRuleSuggestion(id);
    return reply.send({ ok: true });
  } catch (err: any) {
    return reply.code(err.message === 'not_found' ? 404 : 500).send({ error: err.message });
  }
});
```

- [ ] **Step 7: Run tests**

Run: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 tests/rule-suggestions.test.ts`
Expected: 4/4 pass

Run full suite: `cd apps/api && NODE_OPTIONS=--experimental-sqlite tsx --test --test-concurrency=1 "tests/**/*.ts"`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/db.ts apps/api/src/ruleSuggestions.ts apps/api/src/importer.ts apps/api/src/index.ts apps/api/tests/rule-suggestions.test.ts
git commit -m "feat(api): AI rule suggestions — generate, list, accept, reject; triggered from import pipeline"
```

---

### Task 3: AI Rule Suggestions UI

**Goal:** `RuleSuggestionsPanel` shows pending AI rule suggestions with one-click approve/reject; mounted in `HomeView` after `BriefingPanel`.

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Create: `apps/web/src/components/RuleSuggestionsPanel.tsx`
- Modify: `apps/web/src/views/HomeView.tsx`

**Acceptance Criteria:**
- [ ] `RuleSuggestionsPanel` loads pending suggestions on mount and on `refreshKey` change
- [ ] Each row shows: sample counterparty → category name, AI reason if available
- [ ] "Hyväksy sääntö" calls accept endpoint, removes row optimistically
- [ ] "Hylkää" calls reject endpoint, removes row optimistically
- [ ] Panel is hidden (`return null`) when no pending suggestions
- [ ] `refreshKey` prop is wired to `briefingRefreshKey` so panel refreshes after import

**Steps:**

- [ ] **Step 1: Add types and functions to `api/client.ts`**

Add the type after the existing types at the top:

```typescript
export type RuleSuggestion = {
  id: string;
  created_at: string;
  category_id: string;
  category_name: string;
  pattern: string;
  match_field: string;
  sample_counterparty: string | null;
  ai_reason: string | null;
  confidence: number;
  status: string;
};
```

Add the functions after the existing briefing functions:

```typescript
export async function getRuleSuggestions(): Promise<RuleSuggestion[]> {
  const res = await safeFetch(`${API}/rule-suggestions`);
  if (!res.ok) throw new Error(`getRuleSuggestions failed: ${res.statusText}`);
  return res.json();
}

export async function acceptRuleSuggestion(id: string): Promise<void> {
  const res = await safeFetch(`${API}/rule-suggestions/${id}/accept`, { method: 'POST' });
  if (!res.ok) throw new Error(`acceptRuleSuggestion failed: ${res.statusText}`);
}

export async function rejectRuleSuggestion(id: string): Promise<void> {
  const res = await safeFetch(`${API}/rule-suggestions/${id}/reject`, { method: 'POST' });
  if (!res.ok) throw new Error(`rejectRuleSuggestion failed: ${res.statusText}`);
}
```

- [ ] **Step 2: Create `RuleSuggestionsPanel.tsx`**

Create `apps/web/src/components/RuleSuggestionsPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { getRuleSuggestions, acceptRuleSuggestion, rejectRuleSuggestion } from '../api/client';
import type { RuleSuggestion } from '../api/client';

type Props = {
  setToast: (v: string) => void;
  refreshKey?: string | number;
};

export default function RuleSuggestionsPanel({ setToast, refreshKey }: Props) {
  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([]);

  useEffect(() => {
    getRuleSuggestions().then(setSuggestions).catch(() => {});
  }, [refreshKey]);

  if (suggestions.length === 0) return null;

  const remove = (id: string) => setSuggestions((prev) => prev.filter((s) => s.id !== id));

  const handleAccept = async (s: RuleSuggestion) => {
    try {
      await acceptRuleSuggestion(s.id);
      setToast(`Sääntö lisätty: ${s.sample_counterparty ?? s.pattern} → ${s.category_name}`);
      remove(s.id);
    } catch {
      setToast('Hyväksyminen epäonnistui');
    }
  };

  const handleReject = async (s: RuleSuggestion) => {
    try {
      await rejectRuleSuggestion(s.id);
      setToast('Ehdotus hylätty');
      remove(s.id);
    } catch {
      setToast('Hylkääminen epäonnistui');
    }
  };

  return (
    <section className="card glass">
      <div className="card-head">
        <div>
          <p className="eyebrow">AI-ehdotukset</p>
          <h2>Kategoriasäännöt</h2>
        </div>
      </div>
      <p className="muted">
        AI tunnisti nämä kauppakumppanit — hyväksy säännöt automaattista kategorisointia varten.
      </p>
      <div className="rule-suggestions">
        {suggestions.map((s) => (
          <div key={s.id} className="rule-suggestion-row">
            <div className="rule-suggestion-info">
              <strong>{s.sample_counterparty ?? s.pattern}</strong>
              <span className="arrow"> → </span>
              <span className="chip">{s.category_name}</span>
              {s.ai_reason && <span className="muted rule-reason">{s.ai_reason}</span>}
            </div>
            <div className="rule-suggestion-actions">
              <button className="mini" type="button" onClick={() => handleAccept(s)}>
                Hyväksy sääntö
              </button>
              <button className="mini ghost" type="button" onClick={() => handleReject(s)}>
                Hylkää
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Mount `RuleSuggestionsPanel` in `HomeView.tsx`**

In `apps/web/src/views/HomeView.tsx`, add the import:
```tsx
import RuleSuggestionsPanel from '../components/RuleSuggestionsPanel';
```

After the `<BriefingPanel ... />` block, add:
```tsx
<RuleSuggestionsPanel
  setToast={setToast}
  refreshKey={briefingRefreshKey}
/>
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/components/RuleSuggestionsPanel.tsx apps/web/src/views/HomeView.tsx
git commit -m "feat(web): AI rule suggestions panel with approve/reject"
```
