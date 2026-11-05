import crypto from 'crypto';
import { db } from './db.js';
import { LATEST_DECISION_ORDER, latestCategoryDecisionJoin } from './sql/transactions.js';

type CategoryMatchInput = {
  counterparty: string;
  description: string;
  amount: number;
};

function getCategoryIdByName(name: string): string | null {
  const row = db
    .prepare('SELECT id FROM categories WHERE name = ? LIMIT 1')
    .get(name) as { id: string } | undefined;
  return row?.id ?? null;
}

export function chooseCategoryFor(input: CategoryMatchInput): string | null {
  const { counterparty, description, amount } = input;
  const text = `${counterparty} ${description}`.toLowerCase();

  const rules = db
    .prepare(
      'SELECT id, category_id, pattern, match_field FROM category_rules ORDER BY priority DESC, created_at DESC'
    )
    .all() as Array<{ id: string; category_id: string; pattern: string; match_field: string }>;

  for (const rule of rules) {
    const haystack =
      rule.match_field === 'counterparty'
        ? counterparty.toLowerCase()
        : description.toLowerCase();
    if (haystack.includes(rule.pattern.toLowerCase())) {
      return rule.category_id;
    }
  }

  if (amount > 0 && text.match(/palkka|salary|payroll/)) {
    return getCategoryIdByName('Tulopuoli ja palkka');
  }

  if (amount > 0 && text.match(/hyvitys|palautus|refund/)) {
    return getCategoryIdByName('Palautukset ja hyvitykset');
  }

  // heuristic keywords
  const heuristics: Array<[RegExp, string]> = [
    [/sähkö|energia|läm[p]?ö|electric/i, 'Laskut ja sopimukset'],
    [/jäte|jätteen|waste|trash|recycling/i, 'Laskut ja sopimukset'],
    [/puhelin|internet|laajakaista|mobiili|mobile|broadband/i, 'Laskut ja sopimukset'],
    [/vakuutus/i, 'Vakuutukset'],
    [/ruoka|market|k[- ]?market|s-market|prisma|lid[l]?/i, 'Ruoka ja päivittäistavarat'],
    [/auto|bensa|poltto|tankkaus|fuel|huolto/i, 'Auto ja liikkuminen'],
    [/palkka|salary|payroll/i, 'Tulopuoli ja palkka'],
  ];
  for (const [re, cat] of heuristics) {
    if (re.test(text)) {
      return getCategoryIdByName(cat);
    }
  }

  return getCategoryIdByName('Muut ja epäselvät');
}

/**
 * Append a categorization decision. Decisions are history: earlier ones are
 * kept and the most recent one is the transaction's category (see
 * latestCategoryDecisionJoin). Re-stating what the latest decision already
 * says (same category from the same source, e.g. a rule re-run or the user
 * picking the same category again) appends nothing, so the table does not grow
 * on repeats. Returns true when a decision was appended.
 */
export function appendDecision(options: {
  transactionId: string;
  categoryId: string;
  source: string;
  ruleId?: string | null;
  createdAt?: string;
}): boolean {
  const { transactionId, categoryId, source, ruleId = null } = options;
  const latest = db
    .prepare(
      `SELECT category_id, source FROM categorization_decisions
       WHERE transaction_id = ?
       ORDER BY ${LATEST_DECISION_ORDER}
       LIMIT 1`
    )
    .get(transactionId) as { category_id: string; source: string } | undefined;
  if (latest && latest.category_id === categoryId && latest.source === source) return false;
  db.prepare(
    'INSERT INTO categorization_decisions (id, created_at, transaction_id, category_id, source, rule_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), options.createdAt ?? new Date().toISOString(), transactionId, categoryId, source, ruleId);
  return true;
}

export function upsertDecision(options: {
  transactionId: string;
  categoryId: string;
  source: 'rule' | 'user';
  ruleId?: string | null;
  counterparty?: string | null;
  description?: string | null;
}) {
  const { transactionId, categoryId, source, ruleId = null, counterparty, description } = options;
  const now = new Date().toISOString();
  appendDecision({ transactionId, categoryId, source, ruleId, createdAt: now });

  // simple learning: create a rule from counterparty/description
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
}

export function listCategories() {
  return db
    .prepare('SELECT id, name, built_in FROM categories ORDER BY built_in DESC, name ASC')
    .all() as Array<{ id: string; name: string; built_in: number }>;
}

function ensureMiscCategoryId(): string {
  const row = db
    .prepare('SELECT id FROM categories WHERE name = ? LIMIT 1')
    .get('Muut ja epäselvät') as { id: string } | undefined;
  if (!row) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO categories (id, created_at, name, built_in) VALUES (?, ?, ?, 1)'
    ).run(id, now, 'Muut ja epäselvät');
    return id;
  }
  return row.id;
}

export function createCategory(name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('name_required');
  const exists = db.prepare('SELECT 1 FROM categories WHERE name = ?').get(trimmed);
  if (exists) throw new Error('name_exists');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO categories (id, created_at, name, built_in) VALUES (?, ?, ?, 0)').run(
    id,
    now,
    trimmed
  );
  return { id, name: trimmed };
}

export function renameCategory(id: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('name_required');
  const target = db.prepare('SELECT built_in FROM categories WHERE id = ?').get(id) as
    | { built_in: number }
    | undefined;
  if (!target) throw new Error('not_found');
  if (trimmed === 'Muut ja epäselvät') throw new Error('reserved_name');
  const exists = db.prepare('SELECT 1 FROM categories WHERE name = ? AND id != ?').get(trimmed, id);
  if (exists) throw new Error('name_exists');
  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(trimmed, id);
}

export function deleteCategory(id: string) {
  const miscId = ensureMiscCategoryId();
  if (id === miscId) throw new Error('cannot_delete_misc');
  const target = db.prepare('SELECT id FROM categories WHERE id = ?').get(id);
  if (!target) throw new Error('not_found');
  db.exec('BEGIN');
  try {
    // Transactions currently in the deleted category move to misc as a new
    // decision, so the move itself is recorded in the history.
    const current = db
      .prepare(
        `SELECT nt.id FROM normalized_transactions nt
         ${latestCategoryDecisionJoin('nt', 'cd')}
         WHERE cd.category_id = ?`
      )
      .all(id) as Array<{ id: string }>;
    const now = new Date().toISOString();
    for (const tx of current) {
      appendDecision({ transactionId: tx.id, categoryId: miscId, source: 'category_deleted', createdAt: now });
    }
    // Older decisions may still point at the category, and the foreign key on
    // category_id forbids deleting it while they do. Those rows are no longer
    // anyone's current category; repoint them at misc so the category can go.
    db.prepare('UPDATE categorization_decisions SET category_id = ? WHERE category_id = ?').run(
      miscId,
      id
    );
    db.prepare('DELETE FROM category_rules WHERE category_id = ?').run(id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { reassignedTo: miscId };
}
