import { z } from 'zod';
import {
  CHANGE_SET_MAX_LISTED_ROWS,
  RECATEGORIZE_MAX_IDS,
  categorizationApplyRequestSchema,
  categorizationPlanRequestSchema,
  categoryRuleListFields,
  changeSetListFields,
} from '@finance-app/shared';
import { READ_ONLY, UNDOABLE_WRITE, defineTool, type ToolDefinition } from './types.js';

// Category management (docs/CATEGORIES.md): every change is planned first,
// applied with the plan's token and undoable as a whole. The API records this
// server's actor (MCP_ACTOR) on each change set; no user confirmation is asked.
// None of these tools carries a freshness block: they read and change
// categorization state, not imported bank data.

const ERROR_CODES =
  'Errors come back as "Finance API error <status>: {"error": <code>, "details": ...}": 400 invalid_request, ' +
  'unknown_transactions, category_archived, category_has_role, invalid_move_target, invalid_merge_target, ' +
  'name_exists; 404 category_not_found, rule_not_found, change_set_not_found; 409 plan_stale, rule_exists, ' +
  'rule_disabled, already_undone, cannot_undo_undo.';

export const categorizationTools: ToolDefinition[] = [
  defineTool({
    name: 'list_category_rules',
    title: 'Category rules',
    description:
      'Categorization rules in match order: the first enabled rule that matches a transaction gives its category ' +
      '(rules made by the user or an agent, priority 10, come before built-in ones). Fields: id, categoryId, ' +
      'categoryName, pattern, matchField (counterparty, description, or text = both), matchType (contains; regex ' +
      'only for built-in rules), amountSign (positive, negative, or null = any), builtin, disabledAt, priority, ' +
      'createdAt, actor. Disabled rules (kept for history, never match) are listed only with includeDisabled. ' +
      'Check here before create_rule to avoid a duplicate; disable_rule takes an id from here.',
    inputSchema: categoryRuleListFields,
    annotations: READ_ONLY,
    run: (args, { api }) => api.get('/categorization/rules', args),
  }),
  defineTool({
    name: 'plan_categorization',
    title: 'Plan a categorization change',
    description:
      'Work out a categorization change WITHOUT writing anything (a dry run). op.kind is one of: ' +
      `recategorize (explicit transactionIds, at most ${RECATEGORIZE_MAX_IDS}, e.g. from search_transactions, ` +
      'into one categoryId as manual decisions; never by free-text search; creates no rule); ' +
      'create_category (name); ' +
      'rename_category (categoryId, name; id, role, decisions and rules stay); ' +
      'archive_category (categoryId, optional moveTo: its transactions move there, default the fallback-role ' +
      'category, and its rules are disabled; a category with a role cannot be archived; nothing is deleted); ' +
      'merge_categories (fromId into intoId: like archiving fromId into intoId, and its rules are re-created for intoId); ' +
      'create_rule (pattern, a case-insensitive substring of at least 3 characters, matchField counterparty or ' +
      'description, categoryId; it also moves existing matches unless their latest decision is manual, which are ' +
      'listed as exceptions); ' +
      'disable_rule (ruleId from list_category_rules; the rule stops matching, history unchanged); ' +
      'undo (changeSetId from list_category_changes: reverts that change set as a whole; rows changed again since ' +
      'are left alone and reported as exceptions; an undo cannot be undone). ' +
      'Every op takes an optional reason, stored with the change set. Category ids come from list_categories. ' +
      `Returns { kind, op, summary, rows (transactionId, fromCategoryId -> toCategoryId; at most ${CHANGE_SET_MAX_LISTED_ROWS} ` +
      'listed, rowsTotal counts all), rowsTotal, categories, rules, exceptions, planToken }. Review it, then call ' +
      'apply_categorization with the same op and the planToken. ' +
      ERROR_CODES,
    inputSchema: categorizationPlanRequestSchema.shape,
    annotations: READ_ONLY,
    run: (args, { api }) => api.post('/categorization/plan', args),
  }),
  defineTool({
    name: 'apply_categorization',
    title: 'Apply a planned categorization change',
    description:
      'Apply a change worked out with plan_categorization: pass the identical op and its planToken. The API plans ' +
      'again and refuses with 409 plan_stale if anything the plan rests on has changed since; then plan again and ' +
      'review the new plan. Applying the same token twice returns the same change set, so a retry is safe. ' +
      'Returns the change set (id, actor, kind, reason, status, summary, rows, categories, rules, exceptions). It is ' +
      'recorded under this server\'s actor and can be reverted as a whole with an undo op (plan_categorization, then ' +
      'apply_categorization). A rule never overrides a manual decision. Only categorization changes: amounts, dates, ' +
      'accounts, counterparties, balances, transfers and imports are never touched, and nothing is deleted. ' +
      ERROR_CODES,
    inputSchema: categorizationApplyRequestSchema.shape,
    annotations: UNDOABLE_WRITE,
    run: (args, { api }) => api.post('/categorization/apply', args),
  }),
  defineTool({
    name: 'list_category_changes',
    title: 'Category change log',
    description:
      'Applied categorization change sets, newest first, from every actor: user = the web UI, hermes (or another ' +
      'name) = an agent, system = before actors were recorded. Each item: id, createdAt, actor, kind, reason, ' +
      'status (applied or undone), undoOfId (set when the item is itself an undo), undoneById, and summary counts. ' +
      'Returns { total, limit, offset, items }; page with limit/offset. Details with get_category_change; revert ' +
      'with an undo op through plan_categorization and apply_categorization.',
    inputSchema: changeSetListFields,
    annotations: READ_ONLY,
    run: (args, { api }) => api.get('/categorization/change-sets', args),
  }),
  defineTool({
    name: 'get_category_change',
    title: 'Category change set',
    description:
      'One change set by id (from list_category_changes or apply_categorization): its op, actor, reason, status, ' +
      `rows (transactionId, fromCategoryId -> toCategoryId; at most ${CHANGE_SET_MAX_LISTED_ROWS} listed, rowsTotal ` +
      'counts all), categories and rules it changed, and exceptions (left alone on purpose, e.g. manual_decision ' +
      'or changed_since).',
    inputSchema: { id: z.string().trim().min(1).max(100).describe('Change set id') },
    annotations: READ_ONLY,
    run: ({ id }, { api }) => api.get(`/categorization/change-sets/${encodeURIComponent(id)}`),
  }),
];
