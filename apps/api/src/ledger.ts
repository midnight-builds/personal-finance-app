// The Ledger answers the two questions every report, insight and AI tool asks:
// which transactions count (and in which category), and what an account's
// balance was. The rules behind those answers live here and nowhere else:
//
// - Pending rows (no booking date) never count.
// - Of a duplicate group only the canonical row counts (`includeDuplicates`).
// - Transfers between own accounts are left out (`includeTransfers`); a
//   duplicate of a linked transfer is a transfer too.
// - A transaction's category is its most recent categorization decision.
// - Dates are calendar days (YYYY-MM-DD); "today" is today in Helsinki.
// - An account's balance is its latest snapshot on or before the day, plus
//   balance adjustments dated on or before that snapshot.
import { db } from './db.js';
import { isCanonicalGroupRow, latestCategoryDecisionJoin } from './sql/transactions.js';

export type LedgerScope = {
  /** First day included, YYYY-MM-DD. */
  from?: string;
  /** Last day included, YYYY-MM-DD. */
  to?: string;
  /** Only these account ids. */
  accounts?: string[];
  includeTransfers?: boolean;
  includeDuplicates?: boolean;
};

export type LedgerEntry = {
  id: string;
  accountId: string;
  /** Booking day, YYYY-MM-DD. */
  date: string;
  /** Booking date as stored (ISO timestamp); `date` is its day. For output that must keep the stored form. */
  bookedAt: string;
  amount: number;
  currency: string;
  counterparty: string | null;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  isTransfer: boolean;
  transactionGroupId: string | null;
};

export type LedgerTotal = {
  /** Category id, month (YYYY-MM), counterparty or account id; null = uncategorized / unknown. */
  key: string | null;
  label: string | null;
  income: number;
  expense: number;
  net: number;
  count: number;
};

export type AccountBalance = {
  accountId: string;
  accountName: string;
  /** Null when the account has no snapshot on or before the day: unknown, not zero. */
  balance: number | null;
  currency: string | null;
  /** Day of the snapshot the balance is based on. */
  date: string | null;
  adjustmentSum: number;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today's calendar day in Helsinki, YYYY-MM-DD. */
export function today(now: Date = new Date()): string {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Helsinki' });
}

/** The day `days` days before (negative: after) `day`. */
export function daysBefore(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function assertDay(name: string, value: string | undefined) {
  if (value !== undefined && !DAY.test(value)) throw new Error(`ledger: ${name} must be YYYY-MM-DD, got ${value}`);
}

// Transfer-ness belongs to the duplicate group: the linker pairs one copy of an
// overlapping transfer, and the other copies are the same money movement.
// Linked rows and their groups are collected once, so each row costs two
// indexed lookups instead of a scan of every link.
const TRANSFER_SETS = `linked(id) AS (
    SELECT from_transaction_id FROM transfer_links
    UNION SELECT to_transaction_id FROM transfer_links),
  linked_groups(g) AS (
    SELECT DISTINCT n.transaction_group_id FROM normalized_transactions n
    JOIN linked l ON l.id = n.id
    WHERE n.transaction_group_id IS NOT NULL)`;

/** Transactions that count, oldest first. */
export function ledgerEntries(scope: LedgerScope = {}): LedgerEntry[] {
  assertDay('from', scope.from);
  assertDay('to', scope.to);
  // booking_date is an ISO timestamp; plain string bounds keep its index usable.
  const where = ['t.booking_date IS NOT NULL'];
  const params: string[] = [];
  if (scope.from) {
    where.push('t.booking_date >= ?');
    params.push(scope.from);
  }
  if (scope.to) {
    where.push('t.booking_date < ?');
    params.push(daysBefore(scope.to, -1));
  }
  if (scope.accounts) {
    if (scope.accounts.length === 0) return [];
    where.push(`t.account_id IN (${scope.accounts.map(() => '?').join(', ')})`);
    params.push(...scope.accounts);
  }
  const outer: string[] = [];
  if (!scope.includeTransfers) outer.push('NOT nt.is_transfer');
  if (!scope.includeDuplicates) outer.push(isCanonicalGroupRow('nt'));

  const rows = db
    .prepare(
      `WITH ${TRANSFER_SETS},
       scoped AS (
         SELECT t.*,
                (t.id IN (SELECT id FROM linked)
                 OR (t.transaction_group_id IS NOT NULL
                     AND t.transaction_group_id IN (SELECT g FROM linked_groups))) AS is_transfer
         FROM normalized_transactions t
         WHERE ${where.join('\n           AND ')})
       SELECT nt.id, nt.account_id, substr(nt.booking_date, 1, 10) AS day, nt.booking_date, nt.amount, nt.currency,
              nt.counterparty_name, nt.description, nt.transaction_group_id,
              cd.category_id, c.name AS category_name, nt.is_transfer
       FROM scoped nt
       ${latestCategoryDecisionJoin('nt', 'cd')}
       LEFT JOIN categories c ON c.id = cd.category_id
       ${outer.length ? `WHERE ${outer.join('\n         AND ')}` : ''}
       ORDER BY nt.booking_date ASC, nt.created_at ASC, nt.id ASC`
    )
    .all(...params) as Array<{
      id: string;
      account_id: string;
      day: string;
      booking_date: string;
      amount: number;
      currency: string;
      counterparty_name: string | null;
      description: string | null;
      transaction_group_id: string | null;
      category_id: string | null;
      category_name: string | null;
      is_transfer: number;
    }>;

  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    date: r.day,
    bookedAt: r.booking_date,
    amount: Number(r.amount),
    currency: r.currency,
    counterparty: r.counterparty_name,
    description: r.description,
    categoryId: r.category_id,
    categoryName: r.category_name,
    isTransfer: Boolean(r.is_transfer),
    transactionGroupId: r.transaction_group_id,
  }));
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** Income, expense and net per category, month, counterparty or account; largest spend first. */
export function ledgerTotals(
  by: 'category' | 'month' | 'counterparty' | 'account',
  scope: LedgerScope = {}
): LedgerTotal[] {
  const buckets = new Map<string | null, LedgerTotal>();
  for (const e of ledgerEntries(scope)) {
    const [key, label] =
      by === 'category' ? [e.categoryId, e.categoryName]
      : by === 'month' ? [e.date.slice(0, 7), e.date.slice(0, 7)]
      : by === 'counterparty' ? [e.counterparty, e.counterparty]
      : [e.accountId, e.accountId];
    let t = buckets.get(key);
    if (!t) {
      t = { key, label, income: 0, expense: 0, net: 0, count: 0 };
      buckets.set(key, t);
    }
    if (e.amount > 0) t.income += e.amount;
    else t.expense += e.amount;
    t.net += e.amount;
    t.count += 1;
  }
  const totals = [...buckets.values()].map((t) => ({
    ...t,
    income: cents(t.income),
    expense: cents(t.expense),
    net: cents(t.net),
  }));
  return by === 'month'
    ? totals.sort((a, b) => String(a.key).localeCompare(String(b.key)))
    : totals.sort((a, b) => a.expense - b.expense || String(a.key).localeCompare(String(b.key)));
}

/** Every account's balance at the end of `asOf` (default: no limit, i.e. latest), in account creation order. */
export function accountBalances(asOf?: string): AccountBalance[] {
  assertDay('asOf', asOf);
  const rows = db
    .prepare(
      `SELECT a.id, a.name, bs.balance, bs.currency, bs.date
       FROM accounts a
       LEFT JOIN balance_snapshots bs ON bs.id = (
         SELECT s.id FROM balance_snapshots s
         WHERE s.account_id = a.id AND (? IS NULL OR substr(s.date, 1, 10) <= ?)
         ORDER BY s.date DESC, s.created_at DESC
         LIMIT 1)
       ORDER BY a.created_at ASC, a.id ASC`
    )
    .all(asOf ?? null, asOf ?? null) as Array<{
      id: string;
      name: string;
      balance: number | null;
      currency: string | null;
      date: string | null;
    }>;

  const adjustmentSum = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM balance_adjustments
     WHERE account_id = ? AND substr(date, 1, 10) <= ?`
  );

  return rows.map((r) => {
    if (r.date == null) {
      return { accountId: r.id, accountName: r.name, balance: null, currency: null, date: null, adjustmentSum: 0 };
    }
    const day = r.date.slice(0, 10);
    const adj = Number((adjustmentSum.get(r.id, day) as { s: number }).s);
    return {
      accountId: r.id,
      accountName: r.name,
      balance: cents(Number(r.balance) + adj),
      currency: r.currency,
      date: day,
      adjustmentSum: cents(adj),
    };
  });
}
