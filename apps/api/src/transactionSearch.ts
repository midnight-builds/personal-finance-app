import {
  transactionSearchSchema,
  type TransactionSearchInput,
  type TransactionSearchParams,
  type TransactionSearchResult,
  type TransactionSearchRow,
} from '@finance-app/shared';
import { db } from './db.js';
import { isCanonicalGroupRow, latestCategoryDecisionJoin, transferLinkJoin } from './sql/transactions.js';

// Filterable, paginated transaction lookup (GET /transactions/search).
// Returns only the fields needed for reasoning: no IBAN columns, no raw rows.
// Free-text fields may still contain account numbers; agent-facing layers redact them.

type SqlValue = string | number;
type Clause = { sql: string; args?: SqlValue[] };
type Filter = (p: TransactionSearchParams) => Clause | null;

function escapeLike(text: string) {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// One entry per filter; add new filters here.
const FILTERS: readonly Filter[] = [
  () => ({ sql: 'nt.booking_date IS NOT NULL' }),
  (p) => (p.from ? { sql: 'date(nt.booking_date) >= ?', args: [p.from] } : null),
  (p) => (p.to ? { sql: 'date(nt.booking_date) <= ?', args: [p.to] } : null),
  (p) => {
    if (!p.q) return null;
    const like = `%${escapeLike(p.q)}%`;
    return {
      sql: `(nt.counterparty_name LIKE ? ESCAPE '\\' OR nt.description LIKE ? ESCAPE '\\')`,
      args: [like, like],
    };
  },
  (p) => (p.accountId ? { sql: 'nt.account_id = ?', args: [p.accountId] } : null),
  (p) => (p.categoryId ? { sql: 'cd.category_id = ?', args: [p.categoryId] } : null),
  (p) => (p.minAmount !== undefined ? { sql: 'nt.amount >= ?', args: [p.minAmount] } : null),
  (p) => (p.maxAmount !== undefined ? { sql: 'nt.amount <= ?', args: [p.maxAmount] } : null),
  (p) => (p.includeTransfers ? null : { sql: 'tl.id IS NULL' }),
  // Overlapping imports are grouped; keep one row per group so sums are not double-counted.
  (p) => (p.includeDuplicates ? null : { sql: isCanonicalGroupRow('nt') }),
];

const FROM = `
  FROM normalized_transactions nt
  JOIN accounts a ON a.id = nt.account_id
  ${latestCategoryDecisionJoin('nt', 'cd')}
  LEFT JOIN categories c ON c.id = cd.category_id
  ${transferLinkJoin('nt', 'tl')}`;

type Row = Omit<TransactionSearchRow, 'isTransfer'> & { transferLinkId: string | null };

/** Throws `ZodError` on invalid input. */
export function searchTransactions(input: TransactionSearchInput): TransactionSearchResult {
  const params = transactionSearchSchema.parse(input);
  const clauses = FILTERS.map((f) => f(params)).filter((c): c is Clause => c !== null);
  const where = `WHERE ${clauses.map((c) => c.sql).join(' AND ')}`;
  const args = clauses.flatMap((c) => c.args ?? []);

  const { total } = db.prepare(`SELECT COUNT(*) AS total ${FROM} ${where}`).get(...args) as { total: number };
  const rows = db
    .prepare(
      `SELECT nt.id, nt.booking_date AS bookingDate, nt.amount, nt.currency,
              nt.counterparty_name AS counterpartyName, nt.description,
              cd.category_id AS categoryId, c.name AS categoryName,
              a.id AS accountId, a.name AS accountName,
              tl.id AS transferLinkId, nt.transaction_group_id AS transactionGroupId
       ${FROM} ${where}
       ORDER BY nt.booking_date DESC, nt.id
       LIMIT ? OFFSET ?`
    )
    .all(...args, params.limit, params.offset) as Row[];

  return {
    total,
    limit: params.limit,
    offset: params.offset,
    items: rows.map(({ transferLinkId, ...row }) => ({ ...row, isTransfer: transferLinkId !== null })),
  };
}
