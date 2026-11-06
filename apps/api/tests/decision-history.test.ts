import './setup/testDb.js';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { db } from '../src/db.js';
import { seedDemo } from '../src/demo/demoData.js';
import { ledgerEntries, ledgerTotals } from '../src/ledger.js';
import { listTransactions } from '../src/query.js';
import { searchTransactions } from '../src/transactionSearch.js';
import { getInsights } from '../src/insights.js';
import { getSummary, getHouseholdSummary } from '../src/summary.js';
import { getMonthlyOverview } from '../src/monthly.js';
import { appendDecision, createCategory, deleteCategory, upsertDecision } from '../src/rules.js';
import { acceptRuleSuggestion } from '../src/ruleSuggestions.js';
import { resetDb } from './setup/resetDb.js';

// Categorization decisions are history: a new decision is appended, the most
// recent one is the transaction's category, and nothing that counts
// transactions may see more than one decision per transaction.
const ANCHOR = '2026-11-05';

const categoryId = (name: string) =>
  (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string }).id;
const decisions = (txId: string) =>
  db
    .prepare('SELECT category_id, source FROM categorization_decisions WHERE transaction_id = ? ORDER BY created_at, rowid')
    .all(txId)
    .map((r) => ({ ...r })) as Array<{ category_id: string; source: string }>;
const decisionCount = () =>
  Number((db.prepare('SELECT COUNT(*) AS n FROM categorization_decisions').get() as { n: number }).n);
const listed = (txId: string) => listTransactions().find((t: any) => t.id === txId) as any;

/** Everything visible that reads categories, as one comparable snapshot. */
function visible() {
  return JSON.parse(
    JSON.stringify({
      list: listTransactions(),
      search: searchTransactions({ limit: 500 }),
      searchAll: searchTransactions({ includeTransfers: true, includeDuplicates: true, limit: 500 }),
      ledger: ledgerEntries({ includeTransfers: true, includeDuplicates: true }),
      byCategory: ledgerTotals('category'),
      byMonth: ledgerTotals('month'),
      insights: getInsights(ANCHOR),
      summary: getSummary(ANCHOR),
      household: getHouseholdSummary(ANCHOR),
      monthly: getMonthlyOverview(6, ANCHOR),
    })
  );
}

/** A categorized, countable spending transaction from the demo data. */
function pickSpend(skip: string[] = []) {
  const e = ledgerEntries().find((x) => x.amount < 0 && x.categoryId && !skip.includes(x.id));
  assert.ok(e, 'demo has a categorized spending transaction');
  return { id: e.id, categoryId: e.categoryId as string };
}

before(async () => {
  resetDb();
  await seedDemo(ANCHOR);
});

test('recategorization keeps the history and the latest decision wins', () => {
  const tx = pickSpend();
  const before = decisions(tx.id);
  const food = categoryId('Ruoka ja päivittäistavarat');
  const misc = categoryId('Muut ja epäselvät');
  const other = tx.categoryId === food ? misc : food;

  upsertDecision({ transactionId: tx.id, categoryId: other, source: 'user' });
  const after = decisions(tx.id);
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.at(-1), { category_id: other, source: 'user' });
  assert.equal(listed(tx.id).categoryId, other);
  assert.equal(ledgerEntries().find((e) => e.id === tx.id)?.categoryId, other);

  // restore for the following tests
  upsertDecision({ transactionId: tx.id, categoryId: tx.categoryId, source: 'user' });
  assert.equal(listed(tx.id).categoryId, tx.categoryId);
});

test('two decisions within the same millisecond resolve to the newer insert', () => {
  // A fresh transaction, so the fixed timestamps below cannot outrank other tests' decisions.
  const tx = ledgerEntries()[0];
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, amount, currency)
     SELECT ?, created_at, NULL, import_session_id, account_id, '2000-01-01', -1, currency FROM normalized_transactions WHERE id = ?`
  ).run(id, tx.id);
  const food = categoryId('Ruoka ja päivittäistavarat');
  const misc = categoryId('Muut ja epäselvät');
  const at = '2000-01-01T00:00:00.000Z';
  appendDecision({ transactionId: id, categoryId: food, source: 'user', createdAt: at });
  appendDecision({ transactionId: id, categoryId: misc, source: 'user', createdAt: at });
  assert.equal(listed(id).categoryId, misc);
  assert.equal(ledgerEntries().find((e) => e.id === id)?.categoryId, misc);
  appendDecision({ transactionId: id, categoryId: food, source: 'user', createdAt: at });
  assert.equal(listed(id).categoryId, food);
  assert.equal(ledgerEntries().find((e) => e.id === id)?.categoryId, food);
  assert.equal(decisions(id).length, 3);
});

test('three recategorizations do not fan out any reader', () => {
  const baseline = visible();
  const tx = pickSpend();
  const food = categoryId('Ruoka ja päivittäistavarat');
  const misc = categoryId('Muut ja epäselvät');
  const countBefore = decisionCount();

  // Three changes ending where it started: every number must be as before.
  upsertDecision({ transactionId: tx.id, categoryId: food === tx.categoryId ? misc : food, source: 'user' });
  upsertDecision({ transactionId: tx.id, categoryId: misc === tx.categoryId ? food : misc, source: 'user' });
  upsertDecision({ transactionId: tx.id, categoryId: tx.categoryId, source: 'user' });

  assert.ok(decisionCount() > countBefore, 'history was kept');
  assert.ok(decisions(tx.id).length >= 3);
  assert.deepEqual(visible(), baseline);
  assert.equal(listTransactions().filter((t: any) => t.id === tx.id).length, 1);
  assert.equal(ledgerEntries({ includeTransfers: true, includeDuplicates: true }).filter((e) => e.id === tx.id).length, 1);
});

test('re-stating the latest decision does not grow the table', () => {
  const tx = pickSpend();
  const latest = decisions(tx.id).at(-1)!;
  const n = decisionCount();
  for (let i = 0; i < 3; i++) {
    upsertDecision({ transactionId: tx.id, categoryId: latest.category_id, source: latest.source as 'rule' | 'user' });
  }
  assert.equal(decisionCount(), n);

  // A rule re-run over every transaction's current rule decision appends nothing.
  const ruleLatest = db
    .prepare(
      `SELECT d.transaction_id, d.category_id FROM categorization_decisions d
       WHERE d.source = 'rule' AND d.id = (
         SELECT id FROM categorization_decisions WHERE transaction_id = d.transaction_id
         ORDER BY created_at DESC, rowid DESC LIMIT 1)`
    )
    .all() as Array<{ transaction_id: string; category_id: string }>;
  assert.ok(ruleLatest.length > 0);
  for (const r of ruleLatest) upsertDecision({ transactionId: r.transaction_id, categoryId: r.category_id, source: 'rule' });
  assert.equal(decisionCount(), n);

  // A different source is a new fact (the user confirms the rule's choice).
  const r0 = ruleLatest[0];
  upsertDecision({ transactionId: r0.transaction_id, categoryId: r0.category_id, source: 'user' });
  assert.equal(decisionCount(), n + 1);
});

test('accepting a rule suggestion moves only transactions whose latest category is misc', () => {
  const misc = categoryId('Muut ja epäselvät');
  const food = categoryId('Ruoka ja päivittäistavarat');
  const [stillMisc, wasMisc] = ledgerEntries()
    .filter((e) => e.counterparty)
    .slice(0, 2);
  const pattern = `history-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare('UPDATE normalized_transactions SET counterparty_name = ? WHERE id IN (?, ?)').run(
    pattern,
    stillMisc.id,
    wasMisc.id
  );
  upsertDecision({ transactionId: stillMisc.id, categoryId: misc, source: 'user' });
  upsertDecision({ transactionId: wasMisc.id, categoryId: misc, source: 'user' });
  const transport = createCategory(`Liikenne ${pattern}`).id;
  upsertDecision({ transactionId: wasMisc.id, categoryId: transport, source: 'user' });

  const suggestionId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO rule_suggestions (id, created_at, category_id, category_name, pattern, match_field)
     VALUES (?, ?, ?, ?, ?, 'counterparty')`
  ).run(suggestionId, new Date().toISOString(), food, 'Ruoka ja päivittäistavarat', pattern);
  acceptRuleSuggestion(suggestionId);

  assert.equal(listed(stillMisc.id).categoryId, food);
  assert.equal(listed(wasMisc.id).categoryId, transport, 'an old misc decision is history, not the category');
});

test('deleting a category looks as before: current members move to misc, others keep theirs', () => {
  const misc = categoryId('Muut ja epäselvät');
  const food = categoryId('Ruoka ja päivittäistavarat');
  const doomed = createCategory('Poistettava').id;
  const member = pickSpend();
  const former = pickSpend([member.id]);

  upsertDecision({ transactionId: member.id, categoryId: doomed, source: 'user' });
  upsertDecision({ transactionId: former.id, categoryId: doomed, source: 'user' });
  upsertDecision({ transactionId: former.id, categoryId: food, source: 'user' });
  const memberHistory = decisions(member.id).length;

  const res = deleteCategory(doomed);
  assert.equal(res.reassignedTo, misc);
  assert.equal(db.prepare('SELECT 1 FROM categories WHERE id = ?').get(doomed), undefined);
  assert.equal(
    Number((db.prepare('SELECT COUNT(*) AS n FROM categorization_decisions WHERE category_id = ?').get(doomed) as { n: number }).n),
    0
  );

  assert.equal(listed(member.id).categoryId, misc);
  assert.equal(listed(member.id).categoryName, 'Muut ja epäselvät');
  assert.equal(ledgerEntries().find((e) => e.id === member.id)?.categoryId, misc);
  // The move is recorded as a new decision.
  assert.equal(decisions(member.id).length, memberHistory + 1);
  assert.deepEqual(decisions(member.id).at(-1), { category_id: misc, source: 'category_deleted' });

  assert.equal(listed(former.id).categoryId, food);
  assert.equal(ledgerEntries().find((e) => e.id === former.id)?.categoryId, food);
});

test('a category that has rule suggestions can be deleted; its pending ones are rejected', () => {
  const misc = categoryId('Muut ja epäselvät');
  const doomed = createCategory('Poistettava ehdotuksin').id;
  const insert = db.prepare(
    `INSERT INTO rule_suggestions (id, created_at, category_id, category_name, pattern, match_field, status)
     VALUES (?, ?, ?, 'Poistettava ehdotuksin', ?, 'counterparty', ?)`
  );
  const pending = crypto.randomUUID();
  const accepted = crypto.randomUUID();
  insert.run(pending, new Date().toISOString(), doomed, 'pending-shop', 'pending');
  insert.run(accepted, new Date().toISOString(), doomed, 'accepted-shop', 'accepted');

  deleteCategory(doomed);

  const row = (id: string) =>
    db.prepare('SELECT category_id, category_name, status, resolved_at FROM rule_suggestions WHERE id = ?').get(id) as {
      category_id: string;
      category_name: string;
      status: string;
      resolved_at: string | null;
    };
  assert.equal(db.prepare('SELECT 1 FROM categories WHERE id = ?').get(doomed), undefined);
  // A suggestion for a category that no longer exists cannot be accepted.
  assert.equal(row(pending).status, 'rejected');
  assert.ok(row(pending).resolved_at);
  assert.equal(row(accepted).status, 'accepted');
  // The name of the suggested category stays in the history.
  assert.equal(row(pending).category_name, 'Poistettava ehdotuksin');
  assert.equal(row(accepted).category_id, misc);
});
