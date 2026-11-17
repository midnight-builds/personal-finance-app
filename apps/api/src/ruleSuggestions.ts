import crypto from 'crypto';
import { db } from './db.js';
import { getOpenAIApiKey } from './settings.js';
import { aiCategorize } from './ai.js';
import { isManual } from './categorization.js';
import { appendDecision, categoryIdByRole } from './rules.js';
import { latestCategoryDecisionJoin, notVoid } from './sql/transactions.js';

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

export function acceptRuleSuggestion(id: string, options: { actor?: string | null } = {}): void {
  const actor = options.actor ?? null;
  const suggestion = db.prepare('SELECT * FROM rule_suggestions WHERE id = ?').get(id) as RuleSuggestion | undefined;
  if (!suggestion) throw new Error('not_found');
  // A resolved suggestion (e.g. rejected when its category was deleted) must
  // not turn into a rule, even if a stale UI still offers it.
  if (suggestion.status !== 'pending') throw new Error('not_pending');
  // Archived while the AI call was in flight: the suggestion never got rejected.
  const category = db.prepare('SELECT archived_at FROM categories WHERE id = ?').get(suggestion.category_id) as
    | { archived_at: string | null }
    | undefined;
  if (!category || category.archived_at) throw new Error('category_archived');

  const now = new Date().toISOString();

  const existingRule = db.prepare(
    'SELECT id FROM category_rules WHERE pattern = ? AND category_id = ? AND match_field = ? LIMIT 1'
  ).get(suggestion.pattern, suggestion.category_id, suggestion.match_field);

  if (!existingRule) {
    db.prepare(
      'INSERT INTO category_rules (id, created_at, category_id, pattern, match_field, priority, actor) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), now, suggestion.category_id, suggestion.pattern, suggestion.match_field, 10, actor);
  }

  // Apply to existing fallback transactions whose counterparty contains the
  // pattern (literally, case-insensitively, like rules match); a manual pick of
  // the fallback is left alone, since a rule never overrides a manual decision.
  const miscId = categoryIdByRole('fallback');
  if (miscId) {
    const pattern = suggestion.pattern.toLowerCase();
    const matching = (
      db.prepare(`
        SELECT nt.id, nt.counterparty_name, cd.source FROM normalized_transactions nt
        ${latestCategoryDecisionJoin('nt', 'cd')}
        WHERE cd.category_id = ? AND ${notVoid('nt')}
      `).all(miscId) as Array<{ id: string; counterparty_name: string | null; source: string }>
    ).filter((tx) => (tx.counterparty_name ?? '').toLowerCase().includes(pattern) && !isManual(tx.id, tx));

    for (const tx of matching) {
      appendDecision({ transactionId: tx.id, categoryId: suggestion.category_id, source: 'rule', createdAt: now, actor });
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

  const miscId = categoryIdByRole('fallback');
  if (!miscId) return;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

  const candidates = db.prepare(`
    SELECT nt.counterparty_name, COUNT(*) AS cnt, AVG(nt.amount) AS avg_amount
    FROM normalized_transactions nt
    ${latestCategoryDecisionJoin('nt', 'cd')}
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
  `).all(miscId, thirtyDaysAgo) as Array<{ counterparty_name: string; cnt: number; avg_amount: number }>;

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

      if (result.mode === 'existing' && result.categoryId !== miscId) {
        categoryId = result.categoryId;
        categoryName = result.categoryName;
      } else if (result.mode === 'options' && result.options.length > 0) {
        const top = result.options[0];
        if (top.categoryId !== miscId) {
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
