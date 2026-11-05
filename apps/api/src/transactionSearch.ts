import {
  transactionSearchSchema,
  type TransactionSearchInput,
  type TransactionSearchParams,
  type TransactionSearchResult,
  type TransactionSearchRow,
} from '@finance-app/shared';
import { db } from './db.js';
import { ledgerEntries, type LedgerEntry } from './ledger.js';

// Filterable, paginated transaction lookup (GET /transactions/search).
// The Ledger decides which transactions count: booked only, one row per
// duplicate group and no transfers unless asked for.
// Returns only the fields needed for reasoning: no IBAN columns, no raw rows.
// Free-text fields may still contain account numbers; agent-facing layers redact them.

type Filter = (p: TransactionSearchParams) => ((e: LedgerEntry) => boolean) | null;

// SQLite LIKE semantics: case-insensitive for ASCII letters only.
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

// Filters beyond the Ledger scope; add new filters here.
const FILTERS: readonly Filter[] = [
  (p) => {
    if (!p.q) return null;
    const needle = asciiLower(p.q);
    return (e) =>
      (e.counterparty !== null && asciiLower(e.counterparty).includes(needle)) ||
      (e.description !== null && asciiLower(e.description).includes(needle));
  },
  (p) => (p.categoryId ? (e) => e.categoryId === p.categoryId : null),
  (p) => (p.minAmount !== undefined ? (e) => e.amount >= p.minAmount! : null),
  (p) => (p.maxAmount !== undefined ? (e) => e.amount <= p.maxAmount! : null),
];

// Newest first by the stored booking date, then id.
const newestFirst = (a: LedgerEntry, b: LedgerEntry) =>
  a.bookedAt < b.bookedAt ? 1 : a.bookedAt > b.bookedAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Throws `ZodError` on invalid input. */
export function searchTransactions(input: TransactionSearchInput): TransactionSearchResult {
  const params = transactionSearchSchema.parse(input);
  const filters = FILTERS.map((f) => f(params)).filter((f) => f !== null);
  const matches = ledgerEntries({
    from: params.from,
    to: params.to,
    accounts: params.accountId ? [params.accountId] : undefined,
    includeTransfers: params.includeTransfers,
    includeDuplicates: params.includeDuplicates,
  })
    .filter((e) => filters.every((f) => f(e)))
    .sort(newestFirst);

  const accountNames = new Map(
    (db.prepare('SELECT id, name FROM accounts').all() as Array<{ id: string; name: string }>).map((a) => [a.id, a.name])
  );
  const items: TransactionSearchRow[] = matches.slice(params.offset, params.offset + params.limit).map((e) => ({
    id: e.id,
    bookingDate: e.bookedAt,
    amount: e.amount,
    currency: e.currency,
    counterpartyName: e.counterparty,
    description: e.description,
    categoryId: e.categoryId,
    categoryName: e.categoryName,
    accountId: e.accountId,
    accountName: accountNames.get(e.accountId) ?? '',
    transactionGroupId: e.transactionGroupId,
    isTransfer: e.isTransfer,
  }));

  return { total: matches.length, limit: params.limit, offset: params.offset, items };
}
