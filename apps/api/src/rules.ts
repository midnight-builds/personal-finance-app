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
 * on repeats. `actor` is who made it (null: not known, shown as `system`);
 * `changeSetId` the change set that wrote it, if any.
 * Returns the new decision's id, or null when nothing was appended.
 */
export function appendDecision(options: {
  transactionId: string;
  categoryId: string;
  source: string;
  ruleId?: string | null;
  createdAt?: string;
  actor?: string | null;
  reason?: string | null;
  changeSetId?: string | null;
}): string | null {
  const { transactionId, categoryId, source, ruleId = null, actor = null, reason = null, changeSetId = null } = options;
  const latest = db
    .prepare(
      `SELECT category_id, source FROM categorization_decisions
       WHERE transaction_id = ?
       ORDER BY ${LATEST_DECISION_ORDER}
       LIMIT 1`
    )
    .get(transactionId) as { category_id: string; source: string } | undefined;
  if (latest && latest.category_id === categoryId && latest.source === source) return null;
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO categorization_decisions (id, created_at, transaction_id, category_id, source, rule_id, actor, reason, change_set_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    options.createdAt ?? new Date().toISOString(),
    transactionId,
    categoryId,
    source,
    ruleId,
    actor,
    reason,
    changeSetId
  );
  return id;
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

  if (source === 'user') learnRuleFromChoice({ categoryId, counterparty, description, actor, createdAt: now });
}

/**
 * Simple learning from a manual choice: a rule from the counterparty (or the
 * description) to the chosen category, unless one exists. Returns the created
 * rule, or null when none was created.
 */
export function learnRuleFromChoice(options: {
  categoryId: string;
  counterparty?: string | null;
  description?: string | null;
  actor?: string | null;
  createdAt?: string;
  changeSetId?: string | null;
}): { id: string; categoryId: string; pattern: string; matchField: string } | null {
  const { categoryId, counterparty, description, actor = null, changeSetId = null } = options;
  const pattern = (counterparty || description || '').trim().toLowerCase();
  if (pattern.length < 3) return null;
  const matchField = counterparty ? 'counterparty' : 'description';
  const existingRule = db
    .prepare('SELECT id FROM category_rules WHERE pattern = ? AND category_id = ? AND match_field = ? LIMIT 1')
    .get(pattern, categoryId, matchField);
  if (existingRule) return null;
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO category_rules (id, created_at, category_id, pattern, match_field, priority, actor, change_set_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, options.createdAt ?? new Date().toISOString(), categoryId, pattern, matchField, USER_RULE_PRIORITY, actor, changeSetId);
  return { id, categoryId, pattern, matchField };
}

/** Priority of rules the user or an agent makes; built-in rules sit below (see db.ts). */
export const USER_RULE_PRIORITY = 10;

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
