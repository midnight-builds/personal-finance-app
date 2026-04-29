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
