import crypto from 'crypto';
import { db, type CategoryRole } from './db.js';
import { LATEST_DECISION_ORDER, latestCategoryDecisionJoin } from './sql/transactions.js';

type CategoryMatchInput = {
  counterparty: string;
  description: string;
  amount: number;
};

type RuleRow = {
  id: string;
  category_id: string;
  pattern: string;
  match_field: string;
  match_type: string;
  amount_sign: string | null;
};

/** The category doing a role's job, whatever it is named; null if none has it. */
export function categoryIdByRole(role: CategoryRole): string | null {
  const row = db.prepare('SELECT id FROM categories WHERE role = ?').get(role) as { id: string } | undefined;
  return row?.id ?? null;
}

const regexCache = new Map<string, RegExp | null>();

/** A rule's pattern as a case-insensitive RegExp; null for an invalid one, which never matches. */
function ruleRegex(pattern: string): RegExp | null {
  if (!regexCache.has(pattern)) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      re = null;
    }
    regexCache.set(pattern, re);
  }
  return regexCache.get(pattern)!;
}

/**
 * The category rules give a transaction: the first matching enabled rule of a
 * category in use, by priority (user rules above built-in ones) and then the
 * newest first; the fallback category when none matches.
 */
export function chooseCategoryFor(input: CategoryMatchInput): string | null {
  const { counterparty, description, amount } = input;
  const fields: Record<string, string> = {
    counterparty: counterparty.toLowerCase(),
    description: description.toLowerCase(),
    text: `${counterparty} ${description}`.toLowerCase(),
  };

  const rules = db
    .prepare(
      `SELECT r.id, r.category_id, r.pattern, r.match_field, r.match_type, r.amount_sign
       FROM category_rules r
       JOIN categories c ON c.id = r.category_id
       WHERE r.disabled_at IS NULL AND c.archived_at IS NULL
       ORDER BY r.priority DESC, r.created_at DESC`
    )
    .all() as RuleRow[];

  for (const rule of rules) {
    if (rule.amount_sign === 'positive' && !(amount > 0)) continue;
    if (rule.amount_sign === 'negative' && !(amount < 0)) continue;
    const haystack = fields[rule.match_field] ?? fields.description;
    const matched =
      rule.match_type === 'regex'
        ? (ruleRegex(rule.pattern)?.test(haystack) ?? false)
        : haystack.includes(rule.pattern.toLowerCase());
    if (matched) return rule.category_id;
  }

  return categoryIdByRole('fallback');
}

/**
 * Append a categorization decision. Decisions are history: earlier ones are
 * kept and the most recent one is the transaction's category (see
 * latestCategoryDecisionJoin). Re-stating what the latest decision already
 * says (same category from the same source, e.g. a rule re-run or the user
 * picking the same category again) appends nothing, so the table does not grow
 * on repeats. `actor` is who made it (null: not known, shown as `system`).
 * Returns true when a decision was appended.
 */
export function appendDecision(options: {
  transactionId: string;
  categoryId: string;
  source: string;
  ruleId?: string | null;
  createdAt?: string;
  actor?: string | null;
  reason?: string | null;
}): boolean {
  const { transactionId, categoryId, source, ruleId = null, actor = null, reason = null } = options;
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
    `INSERT INTO categorization_decisions (id, created_at, transaction_id, category_id, source, rule_id, actor, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    options.createdAt ?? new Date().toISOString(),
    transactionId,
    categoryId,
    source,
    ruleId,
    actor,
    reason
  );
  return true;
}

export function upsertDecision(options: {
  transactionId: string;
  categoryId: string;
  source: 'rule' | 'user';
  ruleId?: string | null;
  counterparty?: string | null;
  description?: string | null;
  actor?: string | null;
}) {
  const { transactionId, categoryId, source, ruleId = null, counterparty, description, actor = null } = options;
  const now = new Date().toISOString();
  appendDecision({ transactionId, categoryId, source, ruleId, createdAt: now, actor });

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
          'INSERT INTO category_rules (id, created_at, category_id, pattern, match_field, priority, actor) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(crypto.randomUUID(), now, categoryId, pattern.toLowerCase(), matchField, 10, actor);
      }
    }
  }
}

export type CategoryListItem = { id: string; name: string; built_in: number; role: CategoryRole | null };

/** Categories in use; archived ones only when asked for. */
export function listCategories(options: { includeArchived?: boolean } = {}) {
  const where = options.includeArchived ? '' : 'WHERE archived_at IS NULL';
  return db
    .prepare(`SELECT id, name, built_in, role FROM categories ${where} ORDER BY built_in DESC, name ASC`)
    .all() as CategoryListItem[];
}

/** True when the category exists and is not archived. */
export function isCategoryInUse(id: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM categories WHERE id = ? AND archived_at IS NULL').get(id));
}

export function createCategory(name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('name_required');
  // Archived categories keep their names: their decisions still show them.
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

/** Renames any category in use, role categories included; id, role, decisions and rules stay. */
export function renameCategory(id: string, name: string) {
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new Error('name_required');
  const target = db.prepare('SELECT archived_at FROM categories WHERE id = ?').get(id) as
    | { archived_at: string | null }
    | undefined;
  if (!target) throw new Error('not_found');
  if (target.archived_at) throw new Error('category_archived');
  const exists = db.prepare('SELECT 1 FROM categories WHERE name = ? AND id != ?').get(trimmed, id);
  if (exists) throw new Error('name_exists');
  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(trimmed, id);
}

/**
 * Archives a category (categories are never deleted): its current transactions
 * move to `moveTo` (default: the fallback category) by new decisions, its rules
 * are disabled and its pending rule suggestions rejected. Earlier decisions are
 * history and stay as they are. A category with a role cannot be archived.
 */
export function deleteCategory(id: string, options: { moveTo?: string; actor?: string | null } = {}) {
  const target = db.prepare('SELECT role, archived_at FROM categories WHERE id = ?').get(id) as
    | { role: string | null; archived_at: string | null }
    | undefined;
  if (!target || target.archived_at) throw new Error('not_found');
  if (target.role) throw new Error('category_has_role');
  const moveTo = options.moveTo ?? categoryIdByRole('fallback');
  if (!moveTo || moveTo === id || !isCategoryInUse(moveTo)) throw new Error('invalid_move_target');

  db.exec('BEGIN');
  try {
    const current = db
      .prepare(
        `SELECT nt.id FROM normalized_transactions nt
         ${latestCategoryDecisionJoin('nt', 'cd')}
         WHERE cd.category_id = ?`
      )
      .all(id) as Array<{ id: string }>;
    const now = new Date().toISOString();
    for (const tx of current) {
      appendDecision({
        transactionId: tx.id,
        categoryId: moveTo,
        source: 'category_archived',
        createdAt: now,
        actor: options.actor ?? null,
      });
    }
    db.prepare('UPDATE category_rules SET disabled_at = ? WHERE category_id = ? AND disabled_at IS NULL').run(now, id);
    // A pending suggestion can no longer be accepted. It keeps pointing at the
    // archived category, which records what was suggested.
    db.prepare(
      `UPDATE rule_suggestions SET status = 'rejected', resolved_at = ?
       WHERE category_id = ? AND status = 'pending'`
    ).run(now, id);
    db.prepare('UPDATE categories SET archived_at = ? WHERE id = ?').run(now, id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { reassignedTo: moveTo };
}
