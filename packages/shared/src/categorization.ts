import { z } from 'zod';

// Contract for categorization change sets (docs/CATEGORIES.md, "Operations"):
// POST /categorization/plan, POST /categorization/apply and the change-set
// listing. Shared by the API and the MCP tools, so both validate operations the
// same way.

/** Most transactions one `recategorize` may name. */
export const RECATEGORIZE_MAX_IDS = 500;
/** Most row changes a plan or a change set lists; `rowsTotal` gives the full count. */
export const CHANGE_SET_MAX_LISTED_ROWS = 200;
export const CHANGE_SET_LIST_MAX_LIMIT = 100;

const id = z.string().trim().min(1).max(100);
const categoryName = z.string().trim().min(1).max(100);
const reason = z.string().trim().min(1).max(500).optional().describe('Why the change is made; stored with the change set');

export const RULE_MATCH_FIELDS = ['counterparty', 'description'] as const;

export const categorizationOpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('recategorize'),
    transactionIds: z
      .array(id)
      .min(1)
      .max(RECATEGORIZE_MAX_IDS)
      .refine((ids) => new Set(ids).size === ids.length, 'transaction ids must be unique')
      .describe('Explicit transaction ids (never a search); each gets a manual decision'),
    categoryId: id.describe('Target category id (in use, not archived)'),
    reason,
  }),
  z.object({ kind: z.literal('create_category'), name: categoryName, reason }),
  z.object({ kind: z.literal('rename_category'), categoryId: id, name: categoryName, reason }),
  z.object({
    kind: z.literal('archive_category'),
    categoryId: id,
    moveTo: id.optional().describe('Where its current transactions go; default: the fallback category'),
    reason,
  }),
  z.object({ kind: z.literal('merge_categories'), fromId: id, intoId: id, reason }),
  z.object({
    kind: z.literal('create_rule'),
    pattern: z.string().trim().min(3).max(200).describe('Case-insensitive substring'),
    matchField: z.enum(RULE_MATCH_FIELDS),
    categoryId: id,
    reason,
  }),
  z.object({ kind: z.literal('disable_rule'), ruleId: id, reason }),
  z.object({ kind: z.literal('undo'), changeSetId: id, reason }),
]);

export type CategorizationOpInput = z.input<typeof categorizationOpSchema>;
export type CategorizationOp = z.output<typeof categorizationOpSchema>;
export type CategorizationOpKind = CategorizationOp['kind'];

export const PLAN_TOKEN = /^[0-9a-f]{64}$/;

export const categorizationPlanRequestSchema = z.object({ op: categorizationOpSchema });
export const categorizationApplyRequestSchema = z.object({
  op: categorizationOpSchema,
  planToken: z.string().regex(PLAN_TOKEN, 'planToken from POST /categorization/plan'),
});

export const changeSetListFields = {
  limit: z.number().int().min(1).max(CHANGE_SET_LIST_MAX_LIMIT).default(20),
  offset: z.number().int().min(0).default(0),
};

export const categoryRuleListFields = {
  includeDisabled: z.boolean().default(false).describe('Also list disabled rules (kept for history, never match)'),
};

/** A rule as `GET /categorization/rules` lists it, in match order. */
export type CategoryRuleListItem = {
  id: string;
  categoryId: string;
  categoryName: string;
  pattern: string;
  matchField: string;
  matchType: 'contains' | 'regex';
  amountSign: 'positive' | 'negative' | null;
  builtin: boolean;
  disabledAt: string | null;
  priority: number;
  createdAt: string;
  /** Who created it; null for built-in rules and rules from before actors existed. */
  actor: string | null;
};

export type RowChange ={ transactionId: string; fromCategoryId: string | null; toCategoryId: string };

export type CategoryChange =
  | { id: string | null; change: 'created'; name: string }
  | { id: string; change: 'renamed'; name: string; fromName: string }
  | { id: string; change: 'archived'; name: string; movedTo: string }
  | { id: string; change: 'merged'; name: string; intoId: string }
  | { id: string; change: 'unarchived'; name: string };

export type RuleChange = {
  /** null in a plan for a rule that does not exist yet. */
  id: string | null;
  change: 'created' | 'enabled' | 'disabled';
  categoryId: string;
  pattern: string;
  matchField: string;
};

/**
 * Something the operation leaves alone on purpose, e.g. `manual_decision` (a
 * rule never overrides a manual decision) or `changed_since` (undo leaves rows
 * changed after the set).
 */
export type ChangeException = {
  reason: string;
  transactionId?: string;
  categoryId?: string;
  ruleId?: string;
};

export type ChangeSummary = {
  rowsChanged: number;
  categoriesChanged: number;
  rulesChanged: number;
  exceptions: number;
};

export type CategorizationPlan = {
  kind: CategorizationOpKind;
  /** The operation as validated and normalized; apply it with the token. */
  op: CategorizationOp;
  summary: ChangeSummary;
  rows: RowChange[];
  rowsTotal: number;
  categories: CategoryChange[];
  rules: RuleChange[];
  exceptions: ChangeException[];
  planToken: string;
};

export type ChangeSetStatus = 'applied' | 'undone';

export type ChangeSetListItem = {
  id: string;
  createdAt: string;
  actor: string;
  kind: CategorizationOpKind;
  reason: string | null;
  status: ChangeSetStatus;
  undoOfId: string | null;
  undoneById: string | null;
  summary: ChangeSummary;
};

export type ChangeSet = ChangeSetListItem & {
  op: CategorizationOp;
  rows: RowChange[];
  rowsTotal: number;
  categories: CategoryChange[];
  rules: RuleChange[];
  exceptions: ChangeException[];
};

export type ChangeSetList = { total: number; limit: number; offset: number; items: ChangeSetListItem[] };
