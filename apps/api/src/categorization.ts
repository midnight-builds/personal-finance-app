import crypto from 'crypto';
import {
  CHANGE_SET_MAX_LISTED_ROWS,
  categorizationOpSchema,
  type CategorizationOp,
  type CategorizationPlan,
  type CategoryChange,
  type ChangeException,
  type ChangeSet,
  type ChangeSetList,
  type ChangeSetListItem,
  type ChangeSetStatus,
  type ChangeSummary,
  type RowChange,
  type RuleChange,
} from '@finance-app/shared';
import { db } from './db.js';
import { DomainError } from './http/errors.js';
import { USER_RULE_PRIORITY, appendDecision, categoryIdByRole, learnRuleFromChoice } from './rules.js';
import { LATEST_DECISION_ORDER, latestCategoryDecisionJoin, notVoid } from './sql/transactions.js';

// Change sets (docs/CATEGORIES.md, "Operations"): every change to
// categorization is planned first, applied with the plan's token and undoable
// as a whole. `plan` writes nothing; `apply` re-plans in one transaction,
// refuses a stale token and returns the existing set for a token already
// applied. Amounts, dates, accounts, balances, transfers and imports are never
// written here: only decisions, categories, rules and rule suggestions.

type Op = CategorizationOp;
type Category = { id: string; name: string; role: string | null; archived_at: string | null; merged_into_id: string | null };
type Rule = {
  id: string;
  category_id: string;
  pattern: string;
  match_field: string;
  match_type: string;
  amount_sign: string | null;
  priority: number;
  builtin: number;
  disabled_at: string | null;
  disabled_change_set_id: string | null;
};
type Latest = { id: string; category_id: string; source: string };

/** A row to move. `newRule`: the decision is made by the rule this set creates. */
type DraftRow = RowChange & { source: string; ruleId?: string | null; newRule?: boolean };
/** A rule effect; a created rule may copy match details from another rule (merge). */
type DraftRule = RuleChange & { matchType?: string; amountSign?: string | null; priority?: number };

/** What applying an operation would do now, and the state that conclusion rests on. */
type Draft = {
  op: Op;
  rows: DraftRow[];
  categories: CategoryChange[];
  rules: DraftRule[];
  suggestions: { reject: string[]; restore: string[] };
  exceptions: ChangeException[];
  undoOf?: string;
  deps: Record<string, unknown>;
};

/** Stored with the change set: everything its undo needs. */
type Payload = {
  op: Op;
  rows: Array<RowChange & { decisionId: string }>;
  categories: CategoryChange[];
  rules: RuleChange[];
  suggestions: { rejected: string[]; restored: string[] };
  exceptions: ChangeException[];
};

type ChangeSetRow = {
  id: string;
  created_at: string;
  actor: string;
  kind: string;
  reason: string | null;
  plan_token: string;
  payload: string;
  status: ChangeSetStatus;
  undo_of_id: string | null;
};

// ---------- reading state ----------

function getCategory(id: string): Category | undefined {
  const row = db.prepare('SELECT id, name, role, archived_at, merged_into_id FROM categories WHERE id = ?').get(id);
  return row ? ({ ...row } as Category) : undefined;
}

function getRule(id: string): Rule | undefined {
  const row = db
    .prepare(
      `SELECT id, category_id, pattern, match_field, match_type, amount_sign, priority, builtin, disabled_at, disabled_change_set_id
       FROM category_rules WHERE id = ?`
    )
    .get(id);
  return row ? ({ ...row } as Rule) : undefined;
}

function rulesOf(categoryId: string): Rule[] {
  return db
    .prepare(
      `SELECT id, category_id, pattern, match_field, match_type, amount_sign, priority, builtin, disabled_at, disabled_change_set_id
       FROM category_rules WHERE category_id = ? ORDER BY created_at, rowid`
    )
    .all(categoryId)
    .map((r) => ({ ...r }) as Rule);
}

function latestDecision(transactionId: string): Latest | null {
  const row = db
    .prepare(
      `SELECT id, category_id, source FROM categorization_decisions
       WHERE transaction_id = ? ORDER BY ${LATEST_DECISION_ORDER} LIMIT 1`
    )
    .get(transactionId);
  return row ? ({ ...row } as Latest) : null;
}

/**
 * True when the transaction's category is a manual decision. An `undo`
 * decision restores the one before the decision it reverted (undo only reverts
 * a decision that is still the latest, so that one sits right below it) and is
 * as manual as the restored one.
 */
export function isManual(transactionId: string, latest: Pick<Latest, 'source'>): boolean {
  if (latest.source !== 'undo') return latest.source === 'user';
  const history = db
    .prepare(`SELECT source FROM categorization_decisions WHERE transaction_id = ? ORDER BY ${LATEST_DECISION_ORDER}`)
    .all(transactionId) as Array<{ source: string }>;
  let i = 0;
  while (history[i]?.source === 'undo') i += 2;
  return history[i]?.source === 'user';
}

function rowsInCategory(categoryId: string): Array<Latest & { txId: string }> {
  return db
    .prepare(
      `SELECT nt.id AS tx_id, cd.id, cd.category_id, cd.source FROM normalized_transactions nt
       ${latestCategoryDecisionJoin('nt', 'cd')}
       WHERE cd.category_id = ? AND ${notVoid('nt')} ORDER BY nt.rowid`
    )
    .all(categoryId)
    .map((r) => {
      const row = r as { tx_id: string } & Latest;
      return { id: row.id, category_id: row.category_id, source: row.source, txId: row.tx_id };
    }) as Array<Latest & { txId: string }>;
}

function nameTaken(name: string, exceptId?: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM categories WHERE name = ? AND id != ?').get(name, exceptId ?? ''));
}

/** The newest change set whose payload lists the entity: tells a re-planned state from an undone one. */
function lastTouch(list: 'categories' | 'rules', id: string): string | null {
  const row = db
    .prepare(
      `SELECT cs.id FROM change_sets cs, json_each(cs.payload, '$.${list}') je
       WHERE json_extract(je.value, '$.id') = ? ORDER BY cs.rowid DESC LIMIT 1`
    )
    .get(id) as { id: string } | undefined;
  return row?.id ?? null;
}

/** The newest change set that gave a category this name or took it away. */
function lastNameTouch(name: string): string | null {
  const row = db
    .prepare(
      `SELECT cs.id FROM change_sets cs, json_each(cs.payload, '$.categories') je
       WHERE json_extract(je.value, '$.name') = ? OR json_extract(je.value, '$.fromName') = ?
       ORDER BY cs.rowid DESC LIMIT 1`
    )
    .get(name, name) as { id: string } | undefined;
  return row?.id ?? null;
}

function categoryState(id: string) {
  const c = getCategory(id);
  return c ? [id, c.name, c.role, c.archived_at, c.merged_into_id, lastTouch('categories', id)] : [id, null];
}

function ruleState(id: string) {
  const r = getRule(id);
  return r ? [id, r.category_id, r.disabled_at, lastTouch('rules', id), getCategory(r.category_id)?.archived_at ?? null] : [id, null];
}

function requireCategoryInUse(id: string, notFound = 'category_not_found'): Category {
  const c = getCategory(id);
  if (!c) throw new DomainError(notFound, 404, { categoryId: id });
  if (c.archived_at) throw new DomainError('category_archived', 400, { categoryId: id });
  return c;
}

const ruleChange = (r: Rule, change: RuleChange['change']): DraftRule => ({
  id: r.id,
  change,
  categoryId: r.category_id,
  pattern: r.pattern,
  matchField: r.match_field,
});

const publicRow = (r: RowChange): RowChange => ({
  transactionId: r.transactionId,
  fromCategoryId: r.fromCategoryId,
  toCategoryId: r.toCategoryId,
});

const publicRule = (r: RuleChange): RuleChange => ({
  id: r.id,
  change: r.change,
  categoryId: r.categoryId,
  pattern: r.pattern,
  matchField: r.matchField,
});

// ---------- planning ----------

function emptyDraft(op: Op): Draft {
  return { op, rows: [], categories: [], rules: [], suggestions: { reject: [], restore: [] }, exceptions: [], deps: {} };
}

function draftRecategorize(op: Extract<Op, { kind: 'recategorize' }>): Draft {
  const draft = emptyDraft(op);
  requireCategoryInUse(op.categoryId);
  const known = new Set(
    (
      db
        .prepare(`SELECT id FROM normalized_transactions WHERE id IN (${op.transactionIds.map(() => '?').join(',')})`)
        .all(...op.transactionIds) as Array<{ id: string }>
    ).map((r) => r.id)
  );
  const unknown = op.transactionIds.filter((id) => !known.has(id));
  if (unknown.length) throw new DomainError('unknown_transactions', 400, { transactionIds: unknown });

  const seen: Array<[string, string | null]> = [];
  for (const transactionId of op.transactionIds) {
    const latest = latestDecision(transactionId);
    seen.push([transactionId, latest?.id ?? null]);
    // Confirming a category a rule chose makes it manual; only a manual
    // decision already in the target is left as is.
    if (latest?.category_id === op.categoryId && isManual(transactionId, latest)) continue;
    draft.rows.push({ transactionId, fromCategoryId: latest?.category_id ?? null, toCategoryId: op.categoryId, source: 'user' });
  }
  draft.deps = { rows: seen.sort(), categories: [categoryState(op.categoryId)] };
  return draft;
}

function draftCreateCategory(op: Extract<Op, { kind: 'create_category' }>): Draft {
  // Archived categories keep their names: their decisions still show them.
  if (nameTaken(op.name)) throw new DomainError('name_exists', 400);
  const draft = emptyDraft(op);
  draft.categories.push({ id: null, change: 'created', name: op.name });
  // A name freed by a rename can be created again: that must be a new plan,
  // not the set that created the name the first time.
  draft.deps = { name: [op.name, lastNameTouch(op.name)] };
  return draft;
}

function draftRenameCategory(op: Extract<Op, { kind: 'rename_category' }>): Draft {
  const category = requireCategoryInUse(op.categoryId);
  if (nameTaken(op.name, op.categoryId)) throw new DomainError('name_exists', 400);
  const draft = emptyDraft(op);
  if (category.name !== op.name) {
    draft.categories.push({ id: category.id, change: 'renamed', name: op.name, fromName: category.name });
  }
  draft.deps = { categories: [categoryState(op.categoryId)] };
  return draft;
}

/** Archive semantics shared by archive and merge: rows move, rules are disabled, pending suggestions rejected. */
function draftArchive(draft: Draft, category: Category, moveTo: string) {
  const rows = rowsInCategory(category.id);
  for (const row of rows) {
    draft.rows.push({ transactionId: row.txId, fromCategoryId: category.id, toCategoryId: moveTo, source: 'category_archived' });
  }
  const rules = rulesOf(category.id);
  for (const rule of rules) if (!rule.disabled_at) draft.rules.push(ruleChange(rule, 'disabled'));
  draft.suggestions.reject = (
    db.prepare(`SELECT id FROM rule_suggestions WHERE category_id = ? AND status = 'pending' ORDER BY id`).all(category.id) as Array<{
      id: string;
    }>
  ).map((s) => s.id);
  return {
    rows: rows.map((r) => [r.txId, r.id]).sort(),
    rules: rules.map((r) => ruleState(r.id)),
    suggestions: draft.suggestions.reject,
  };
}

function archivable(id: string): Category {
  const category = requireCategoryInUse(id);
  if (category.role) throw new DomainError('category_has_role', 400, { categoryId: id });
  return category;
}

function draftArchiveCategory(op: Extract<Op, { kind: 'archive_category' }>): Draft {
  const category = archivable(op.categoryId);
  const moveTo = op.moveTo ?? categoryIdByRole('fallback');
  if (!moveTo || moveTo === category.id || !getCategory(moveTo) || getCategory(moveTo)!.archived_at) {
    throw new DomainError('invalid_move_target', 400, { moveTo });
  }
  const draft = emptyDraft(op);
  const deps = draftArchive(draft, category, moveTo);
  draft.categories.push({ id: category.id, change: 'archived', name: category.name, movedTo: moveTo });
  draft.deps = { ...deps, categories: [categoryState(category.id), categoryState(moveTo)] };
  return draft;
}

const sameMatch = (a: Rule, b: Rule) =>
  a.pattern === b.pattern && a.match_field === b.match_field && a.match_type === b.match_type && a.amount_sign === b.amount_sign;

function draftMergeCategories(op: Extract<Op, { kind: 'merge_categories' }>): Draft {
  const from = archivable(op.fromId);
  if (op.intoId === op.fromId) throw new DomainError('invalid_merge_target', 400, { intoId: op.intoId });
  requireCategoryInUse(op.intoId);
  const draft = emptyDraft(op);
  const deps = draftArchive(draft, from, op.intoId);
  // The merged category's own rules now point into the target: re-created there,
  // or an identical disabled one re-enabled; an identical enabled one is enough.
  const intoRules = rulesOf(op.intoId);
  for (const rule of rulesOf(from.id)) {
    if (rule.disabled_at || rule.builtin) continue;
    const twin = intoRules.find((r) => sameMatch(r, rule));
    if (twin && !twin.disabled_at) continue;
    if (twin) {
      draft.rules.push(ruleChange(twin, 'enabled'));
      continue;
    }
    draft.rules.push({
      id: null,
      change: 'created',
      categoryId: op.intoId,
      pattern: rule.pattern,
      matchField: rule.match_field,
      matchType: rule.match_type,
      amountSign: rule.amount_sign,
      priority: rule.priority,
    });
  }
  draft.categories.push({ id: from.id, change: 'merged', name: from.name, intoId: op.intoId });
  draft.deps = {
    ...deps,
    intoRules: intoRules.map((r) => ruleState(r.id)),
    categories: [categoryState(from.id), categoryState(op.intoId)],
  };
  return draft;
}

function draftCreateRule(op: Extract<Op, { kind: 'create_rule' }>): Draft {
  requireCategoryInUse(op.categoryId);
  const pattern = op.pattern.toLowerCase();
  const draft = emptyDraft({ ...op, pattern });
  const twins = (
    db
      .prepare(
        `SELECT id FROM category_rules WHERE category_id = ? AND pattern = ? AND match_field = ?
           AND match_type = 'contains' AND amount_sign IS NULL ORDER BY created_at, rowid`
      )
      .all(op.categoryId, pattern, op.matchField) as Array<{ id: string }>
  ).map((r) => getRule(r.id)!);
  if (twins.some((r) => !r.disabled_at)) throw new DomainError('rule_exists', 409);
  // An identical rule is re-enabled rather than duplicated: rules are never deleted.
  const reused = twins[0];
  draft.rules.push(
    reused ? ruleChange(reused, 'enabled') : { id: null, change: 'created', categoryId: op.categoryId, pattern, matchField: op.matchField }
  );

  const candidates = db
    .prepare(
      `SELECT nt.id AS tx_id, nt.counterparty_name, nt.description, cd.id, cd.category_id, cd.source
       FROM normalized_transactions nt ${latestCategoryDecisionJoin('nt', 'cd')}
       WHERE ${notVoid('nt')} ORDER BY nt.rowid`
    )
    .all() as Array<{ tx_id: string; counterparty_name: string | null; description: string | null } & Latest>;
  const seen: Array<[string, string | null]> = [];
  for (const tx of candidates) {
    const haystack = ((op.matchField === 'counterparty' ? tx.counterparty_name : tx.description) ?? '').toLowerCase();
    if (!haystack.includes(pattern)) continue;
    seen.push([tx.tx_id, tx.id ?? null]);
    if (tx.category_id === op.categoryId) continue;
    // Manual beats rule: a manual decision is left alone and reported.
    if (tx.id && isManual(tx.tx_id, tx)) {
      draft.exceptions.push({ transactionId: tx.tx_id, reason: 'manual_decision' });
      continue;
    }
    draft.rows.push({
      transactionId: tx.tx_id,
      fromCategoryId: tx.category_id ?? null,
      toCategoryId: op.categoryId,
      source: 'rule',
      ...(reused ? { ruleId: reused.id } : { newRule: true }),
    });
  }
  draft.deps = { rows: seen.sort(), categories: [categoryState(op.categoryId)], rules: twins.map((r) => ruleState(r.id)) };
  return draft;
}

function draftDisableRule(op: Extract<Op, { kind: 'disable_rule' }>): Draft {
  const rule = getRule(op.ruleId);
  if (!rule) throw new DomainError('rule_not_found', 404, { ruleId: op.ruleId });
  if (rule.disabled_at) throw new DomainError('rule_disabled', 409, { ruleId: op.ruleId });
  const draft = emptyDraft(op);
  draft.rules.push(ruleChange(rule, 'disabled'));
  draft.deps = { rules: [ruleState(rule.id)] };
  return draft;
}

function readChangeSet(id: string): ChangeSetRow {
  const row = db.prepare('SELECT * FROM change_sets WHERE id = ?').get(id);
  if (!row) throw new DomainError('change_set_not_found', 404, { changeSetId: id });
  return { ...row } as ChangeSetRow;
}

function draftUndo(op: Extract<Op, { kind: 'undo' }>): Draft {
  const set = readChangeSet(op.changeSetId);
  if (set.kind === 'undo') throw DomainError.conflict('cannot_undo_undo');
  if (set.status === 'undone') throw DomainError.conflict('already_undone');
  const payload = JSON.parse(set.payload) as Payload;
  const draft = emptyDraft(op);
  draft.undoOf = set.id;
  const touchedCategories = new Set<string>();
  const seenRows: Array<[string, string | null]> = [];
  const fallback = categoryIdByRole('fallback');
  const archivedNow = new Set<string>(); // archived by this undo
  const unarchivedNow = new Set<string>(); // brought back by this undo

  for (const change of payload.categories) {
    const id = change.id!;
    touchedCategories.add(id);
    const current = getCategory(id);
    if (!current) continue;
    if (change.change === 'created') {
      if (current.archived_at || !fallback || current.role) {
        draft.exceptions.push({ categoryId: id, reason: 'changed_since' });
        continue;
      }
      // Undoing a creation archives the category, with archive semantics (these
      // rows restore nothing, so their decisions are not `undo` ones).
      archivedNow.add(id);
      touchedCategories.add(fallback);
      const rows = rowsInCategory(id);
      for (const row of rows) {
        seenRows.push([row.txId, row.id]);
        draft.rows.push({ transactionId: row.txId, fromCategoryId: id, toCategoryId: fallback, source: 'category_archived' });
      }
      for (const rule of rulesOf(id)) if (!rule.disabled_at) draft.rules.push(ruleChange(rule, 'disabled'));
      draft.suggestions.reject.push(
        ...(
          db.prepare(`SELECT id FROM rule_suggestions WHERE category_id = ? AND status = 'pending' ORDER BY id`).all(id) as Array<{
            id: string;
          }>
        ).map((s) => s.id)
      );
      draft.categories.push({ id, change: 'archived', name: current.name, movedTo: fallback });
    } else if (change.change === 'renamed') {
      if (current.name !== change.name) draft.exceptions.push({ categoryId: id, reason: 'changed_since' });
      else if (nameTaken(change.fromName, id)) draft.exceptions.push({ categoryId: id, reason: 'name_taken' });
      else draft.categories.push({ id, change: 'renamed', name: change.fromName, fromName: current.name });
    } else if (change.change === 'archived' || change.change === 'merged') {
      if (!current.archived_at) {
        draft.exceptions.push({ categoryId: id, reason: 'changed_since' });
        continue;
      }
      unarchivedNow.add(id);
      draft.categories.push({ id, change: 'unarchived', name: current.name });
    }
  }
  const suggestionIds = payload.suggestions?.rejected ?? [];
  for (const id of suggestionIds) {
    const s = db.prepare('SELECT status FROM rule_suggestions WHERE id = ?').get(id) as { status: string } | undefined;
    if (s?.status === 'rejected') draft.suggestions.restore.push(id);
  }

  const ruleIds: string[] = [];
  const plannedRules = new Set(draft.rules.map((r) => r.id));
  for (const change of payload.rules) {
    const rule = change.id ? getRule(change.id) : undefined;
    if (!rule || plannedRules.has(rule.id)) continue;
    ruleIds.push(rule.id);
    if (change.change === 'created' || change.change === 'enabled') {
      if (rule.disabled_at) draft.exceptions.push({ ruleId: rule.id, reason: 'changed_since' });
      else draft.rules.push(ruleChange(rule, 'disabled'));
    } else if (change.change === 'disabled') {
      if (!rule.disabled_at || rule.disabled_change_set_id !== set.id) {
        draft.exceptions.push({ ruleId: rule.id, reason: 'changed_since' });
      } else if (getCategory(rule.category_id)?.archived_at && !unarchivedNow.has(rule.category_id)) {
        // A rule of a category out of use stays off (archived categories' rules are disabled).
        draft.exceptions.push({ ruleId: rule.id, reason: 'category_archived' });
      } else {
        draft.rules.push(ruleChange(rule, 'enabled'));
      }
    }
  }

  // Rows go back only where the set's decision is still the latest, and only
  // into a category that is in use once this undo is applied.
  const usable = (id: string) => {
    if (archivedNow.has(id)) return false;
    if (unarchivedNow.has(id)) return true;
    const c = getCategory(id);
    return Boolean(c && !c.archived_at);
  };
  const planned = new Set(draft.rows.map((r) => r.transactionId));
  for (const row of payload.rows) {
    const latest = latestDecision(row.transactionId);
    seenRows.push([row.transactionId, latest?.id ?? null]);
    if (planned.has(row.transactionId)) continue;
    if (latest?.id !== row.decisionId) {
      draft.exceptions.push({ transactionId: row.transactionId, reason: 'changed_since' });
    } else if (!row.fromCategoryId) {
      draft.exceptions.push({ transactionId: row.transactionId, reason: 'no_previous_category' });
    } else if (!usable(row.fromCategoryId)) {
      draft.exceptions.push({ transactionId: row.transactionId, reason: 'previous_category_archived' });
    } else {
      touchedCategories.add(row.fromCategoryId);
      draft.rows.push({ transactionId: row.transactionId, fromCategoryId: row.toCategoryId, toCategoryId: row.fromCategoryId, source: 'undo' });
    }
  }

  draft.deps = {
    set: [set.id, set.status],
    rows: seenRows.sort(),
    categories: [...touchedCategories].sort().map(categoryState),
    rules: [...new Set([...ruleIds, ...draft.rules.map((r) => r.id!)])].sort().map(ruleState),
    suggestions: suggestionIds.map((id) => [id, (db.prepare('SELECT status FROM rule_suggestions WHERE id = ?').get(id) as { status: string } | undefined)?.status ?? null]),
  };
  return draft;
}

function draftFor(op: Op): Draft {
  switch (op.kind) {
    case 'recategorize':
      return draftRecategorize(op);
    case 'create_category':
      return draftCreateCategory(op);
    case 'rename_category':
      return draftRenameCategory(op);
    case 'archive_category':
      return draftArchiveCategory(op);
    case 'merge_categories':
      return draftMergeCategories(op);
    case 'create_rule':
      return draftCreateRule(op);
    case 'disable_rule':
      return draftDisableRule(op);
    case 'undo':
      return draftUndo(op);
  }
}

/** JSON with object keys sorted, so equal values hash equally. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The operation as the token sees it: the order of explicit ids does not matter. */
function tokenOp(op: Op): Op {
  return op.kind === 'recategorize' ? { ...op, transactionIds: [...op.transactionIds].sort() } : op;
}

function tokenOf(draft: Draft): string {
  return crypto
    .createHash('sha256')
    .update(stableJson({ v: 1, op: tokenOp(draft.op), deps: draft.deps }))
    .digest('hex');
}

function summaryOf(p: { rows: unknown[]; categories: unknown[]; rules: unknown[]; exceptions: unknown[] }): ChangeSummary {
  return {
    rowsChanged: p.rows.length,
    categoriesChanged: p.categories.length,
    rulesChanged: p.rules.length,
    exceptions: p.exceptions.length,
  };
}

/** Works out what the operation would change now; writes nothing. */
export function plan(input: unknown, _actor?: string): CategorizationPlan {
  const op = categorizationOpSchema.parse(input);
  const draft = draftFor(op);
  return {
    kind: op.kind,
    op: draft.op,
    summary: summaryOf(draft),
    rows: draft.rows.slice(0, CHANGE_SET_MAX_LISTED_ROWS).map(publicRow),
    rowsTotal: draft.rows.length,
    categories: draft.categories,
    rules: draft.rules.map(publicRule),
    exceptions: draft.exceptions,
    planToken: tokenOf(draft),
  };
}

// ---------- applying ----------

let savepoints = 0;

/** Runs fn atomically; nests (savepoints), so callers may already be in a transaction. */
function inTransaction<T>(fn: () => T): T {
  const name = `categorization_${savepoints++}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  } finally {
    savepoints--;
  }
}

export type ApplyOptions = {
  /**
   * Only for the web UI's one-row pick (POST /transactions/:id/category): also
   * learn a rule from the row's counterparty, recorded in the same set.
   */
  learnRule?: boolean;
};

function execute(draft: Draft, token: string, actor: string, options: ApplyOptions): string {
  const setId = crypto.randomUUID();
  const now = new Date().toISOString();
  const reason = draft.op.reason ?? null;
  const categories: CategoryChange[] = [];
  const rules: RuleChange[] = [];

  // 1. Categories that must exist or be in use before rows move into them.
  for (const change of draft.categories) {
    if (change.change === 'created') {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO categories (id, created_at, name, built_in) VALUES (?, ?, ?, 0)').run(id, now, change.name);
      categories.push({ ...change, id });
    } else if (change.change === 'renamed') {
      db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(change.name, change.id);
      categories.push(change);
    } else if (change.change === 'unarchived') {
      db.prepare('UPDATE categories SET archived_at = NULL, merged_into_id = NULL WHERE id = ?').run(change.id);
      categories.push(change);
    }
  }

  // 2. Rules.
  let newRuleId: string | null = null;
  for (const change of draft.rules) {
    if (change.change === 'created') {
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO category_rules
           (id, created_at, category_id, pattern, match_field, priority, match_type, amount_sign, actor, change_set_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        now,
        change.categoryId,
        change.pattern,
        change.matchField,
        change.priority ?? USER_RULE_PRIORITY,
        change.matchType ?? 'contains',
        change.amountSign ?? null,
        actor,
        setId
      );
      newRuleId ??= id;
      rules.push(publicRule({ ...change, id }));
    } else if (change.change === 'enabled') {
      db.prepare('UPDATE category_rules SET disabled_at = NULL, disabled_change_set_id = NULL WHERE id = ?').run(change.id);
      newRuleId ??= change.id;
      rules.push(publicRule(change));
    } else {
      db.prepare('UPDATE category_rules SET disabled_at = ?, disabled_change_set_id = ? WHERE id = ?').run(now, setId, change.id);
      rules.push(publicRule(change));
    }
  }

  // 3. Rows: one new decision each; history stays.
  const rows: Payload['rows'] = [];
  for (const row of draft.rows) {
    const decisionId = appendDecision({
      transactionId: row.transactionId,
      categoryId: row.toCategoryId,
      source: row.source,
      ruleId: row.newRule ? newRuleId : (row.ruleId ?? null),
      createdAt: now,
      actor,
      reason,
      changeSetId: setId,
    });
    if (decisionId) rows.push({ ...publicRow(row), decisionId });
  }

  // 4. Categories taken out of use once their rows have moved.
  for (const change of draft.categories) {
    if (change.change === 'archived' || change.change === 'merged') {
      db.prepare('UPDATE categories SET archived_at = ?, merged_into_id = ? WHERE id = ?').run(
        now,
        change.change === 'merged' ? change.intoId : null,
        change.id
      );
      categories.push(change);
    }
  }
  // A pending suggestion for an archived category can no longer be accepted;
  // undo brings back what the set rejected.
  for (const id of draft.suggestions.reject) {
    db.prepare(`UPDATE rule_suggestions SET status = 'rejected', resolved_at = ? WHERE id = ?`).run(now, id);
  }
  for (const id of draft.suggestions.restore) {
    db.prepare(`UPDATE rule_suggestions SET status = 'pending', resolved_at = NULL WHERE id = ?`).run(id);
  }

  if (options.learnRule && draft.op.kind === 'recategorize' && draft.op.transactionIds.length === 1) {
    const tx = db
      .prepare('SELECT counterparty_name, description FROM normalized_transactions WHERE id = ?')
      .get(draft.op.transactionIds[0]) as { counterparty_name: string | null; description: string | null };
    const learned = learnRuleFromChoice({
      categoryId: draft.op.categoryId,
      counterparty: tx.counterparty_name,
      description: tx.description,
      actor,
      createdAt: now,
      changeSetId: setId,
    });
    if (learned) rules.push({ ...learned, change: 'created' });
  }

  const payload: Payload = {
    op: draft.op,
    rows,
    categories,
    rules,
    suggestions: { rejected: draft.suggestions.reject, restored: draft.suggestions.restore },
    exceptions: draft.exceptions,
  };
  db.prepare(
    `INSERT INTO change_sets (id, created_at, actor, kind, reason, plan_token, payload, status, undo_of_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', ?)`
  ).run(setId, now, actor, draft.op.kind, reason, token, JSON.stringify(payload), draft.undoOf ?? null);
  if (draft.undoOf) db.prepare(`UPDATE change_sets SET status = 'undone' WHERE id = ?`).run(draft.undoOf);
  return setId;
}

/**
 * Applies an operation planned with `plan`. Re-plans in the same transaction:
 * a token that no longer matches is refused (409 `plan_stale`); a token already
 * applied returns that change set without writing anything.
 */
export function apply(input: unknown, planToken: string, actor: string, options: ApplyOptions = {}): ChangeSet {
  const op = categorizationOpSchema.parse(input);
  return inTransaction(() => {
    const existing = db.prepare('SELECT id, payload FROM change_sets WHERE plan_token = ?').get(planToken) as
      | { id: string; payload: string }
      | undefined;
    if (existing) {
      const stored = (JSON.parse(existing.payload) as Payload).op;
      if (stableJson(tokenOp(stored)) !== stableJson(tokenOp(normalizeOp(op)))) throw DomainError.conflict('plan_stale');
      return getChangeSet(existing.id);
    }
    const draft = draftFor(op);
    if (tokenOf(draft) !== planToken) throw DomainError.conflict('plan_stale');
    return getChangeSet(execute(draft, planToken, actor, options));
  });
}

/** The operation as a plan normalizes it (rule patterns are stored lowercase). */
function normalizeOp(op: Op): Op {
  return op.kind === 'create_rule' ? { ...op, pattern: op.pattern.toLowerCase() } : op;
}

/** Plans and applies at once, for callers that act directly (the existing REST endpoints). */
export function applyNow(input: unknown, actor: string, options: ApplyOptions = {}): ChangeSet {
  return inTransaction(() => apply(input, plan(input).planToken, actor, options));
}

// ---------- reading change sets ----------

function listItem(row: ChangeSetRow, payload: Payload): ChangeSetListItem {
  const undoneBy = db.prepare('SELECT id FROM change_sets WHERE undo_of_id = ?').get(row.id) as { id: string } | undefined;
  return {
    id: row.id,
    createdAt: row.created_at,
    actor: row.actor,
    kind: row.kind as ChangeSetListItem['kind'],
    reason: row.reason,
    status: row.status,
    undoOfId: row.undo_of_id,
    undoneById: undoneBy?.id ?? null,
    summary: summaryOf(payload),
  };
}

export function getChangeSet(id: string): ChangeSet {
  const row = readChangeSet(id);
  const payload = JSON.parse(row.payload) as Payload;
  return {
    ...listItem(row, payload),
    op: payload.op,
    rows: payload.rows.slice(0, CHANGE_SET_MAX_LISTED_ROWS).map(publicRow),
    rowsTotal: payload.rows.length,
    categories: payload.categories,
    rules: payload.rules,
    exceptions: payload.exceptions,
  };
}

/** Newest first. */
export function listChangeSets(params: { limit: number; offset: number }): ChangeSetList {
  const total = Number((db.prepare('SELECT COUNT(*) AS n FROM change_sets').get() as { n: number }).n);
  const rows = db
    .prepare('SELECT * FROM change_sets ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?')
    .all(params.limit, params.offset)
    .map((r) => ({ ...r }) as ChangeSetRow);
  return { total, limit: params.limit, offset: params.offset, items: rows.map((r) => listItem(r, JSON.parse(r.payload))) };
}

// ---------- the step-1 helpers, now change sets ----------

export function createCategory(name: string, options: { actor?: string } = {}) {
  if (!String(name ?? '').trim()) throw new DomainError('name_required', 400);
  const set = applyNow({ kind: 'create_category', name }, options.actor ?? 'system');
  const created = set.categories[0] as Extract<CategoryChange, { change: 'created' }>;
  return { id: created.id!, name: created.name };
}

/** Renames any category in use, role categories included; id, role, decisions and rules stay. */
export function renameCategory(id: string, name: string, options: { actor?: string } = {}) {
  if (!String(name ?? '').trim()) throw new DomainError('name_required', 400);
  applyNow({ kind: 'rename_category', categoryId: id, name }, options.actor ?? 'system');
}

/**
 * Archives a category (categories are never deleted): its current transactions
 * move to `moveTo` (default: the fallback category) by new decisions, its rules
 * are disabled and its pending rule suggestions rejected. A category with a role
 * cannot be archived.
 */
export function archiveCategory(id: string, options: { moveTo?: string; actor?: string } = {}) {
  const set = applyNow({ kind: 'archive_category', categoryId: id, moveTo: options.moveTo }, options.actor ?? 'system');
  const archived = set.categories[0] as Extract<CategoryChange, { change: 'archived' }>;
  return { reassignedTo: archived.movedTo };
}
