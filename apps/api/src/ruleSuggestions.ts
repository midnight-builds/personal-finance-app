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
