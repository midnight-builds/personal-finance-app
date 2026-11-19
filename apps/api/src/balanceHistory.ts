import {
  BALANCE_HISTORY_MAX_POINTS,
  balanceStaleness,
  isLiabilityType,
  type BalanceHistory,
  type BalanceHistoryAccount,
  type BalanceHistoryParams,
  type BalanceHistoryPoint,
  type NetWorth,
  type NetWorthAccount,
  type NetWorthTotals,
} from '@finance-app/shared';
import { db } from './db.js';
import { DomainError } from './http/errors.js';
import { accountBalances, daysBefore, today, type AccountBalance } from './ledger.js';
import { getDataStatus } from './dataStatus.js';

// Balances and net worth over time (GLOSSARY.md, "Net worth"), read from balance
// snapshots: the bank's (imports) and balance observations (an actor's dated
// balance); never reconstructed from cash flow, never estimated between two.
//
// An imported account's balance on a day is known only between its first
// snapshot and the last day its imported data covers, and only while no booking
// came after the snapshot it rests on. A manual account's balance is its latest
// observation on or before the day, from its first observation on (stale or not:
// staleness is reported, not hidden). Elsewhere a balance is unknown (null),
// never zero, and the totals say which accounts they leave out.
//
// Net worth counts each account's ownership share of its balance (cash flow
// never does). EUR accounts make the totals; an account in another currency is
// never converted and counts in a total of its own currency. Archived accounts
// are left out.

/** The currency of the main totals; other currencies are never converted into it. */
const BASE_CURRENCY = 'EUR';

const cents = (n: number) => Math.round(n * 100) / 100;

/** Calendar day `months` months before `day`, clamped to the month's last day. */
function monthsBefore(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m - 1 - months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 - months, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

const nextDay = (day: string) => daysBefore(day, -1);
const isPeriodEnd = (day: string, interval: BalanceHistoryParams['interval']) =>
  interval === 'day' ||
  (interval === 'week' && new Date(`${day}T00:00:00Z`).getUTCDay() === 0) ||
  (interval === 'month' && nextDay(day).endsWith('-01'));

/** Period ends from `from` to `to`, and `to` itself as the last point. */
function pointDates(from: string, to: string, interval: BalanceHistoryParams['interval']): string[] {
  const dates: string[] = [];
  for (let day = from; day < to; day = nextDay(day)) {
    if (isPeriodEnd(day, interval)) {
      dates.push(day);
      if (dates.length >= BALANCE_HISTORY_MAX_POINTS) throw new DomainError('too_many_points', 400, { max: BALANCE_HISTORY_MAX_POINTS });
    }
  }
  dates.push(to);
  return dates;
}

function accountsWithCoverage(): BalanceHistoryAccount[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.account_subtype AS subtype, a.tracking, a.currency, a.ownership_share,
              (SELECT MIN(substr(s.date, 1, 10)) FROM balance_snapshots s WHERE s.account_id = a.id) AS first_snapshot,
              (SELECT MAX(substr(s.date, 1, 10)) FROM balance_snapshots s WHERE s.account_id = a.id) AS last_snapshot,
              (SELECT MAX(substr(t.booking_date, 1, 10)) FROM normalized_transactions t
               WHERE t.account_id = a.id AND t.booking_date IS NOT NULL) AS last_booking
       FROM accounts a
       WHERE a.archived_at IS NULL
       ORDER BY a.created_at ASC, a.id ASC`
    )
    .all() as Array<{
    id: string;
    name: string;
    subtype: BalanceHistoryAccount['subtype'];
    tracking: BalanceHistoryAccount['tracking'];
    currency: string;
    ownership_share: number;
    first_snapshot: string | null;
    last_snapshot: string | null;
    last_booking: string | null;
  }>;
  return rows.map((r) => {
    const ends = [r.last_snapshot, r.last_booking].filter((d): d is string => d !== null).sort();
    return {
      id: r.id,
      name: r.name,
      subtype: r.subtype,
      tracking: r.tracking,
      currency: r.currency,
      ownershipShare: Number(r.ownership_share),
      knownFrom: r.first_snapshot,
      knownUntil: r.tracking === 'manual' || !r.first_snapshot ? null : (ends.at(-1) ?? null),
    };
  });
}

const lastBookingStmt = () =>
  db.prepare(
    `SELECT MAX(substr(booking_date, 1, 10)) AS day FROM normalized_transactions
     WHERE account_id = ? AND booking_date IS NOT NULL AND (? IS NULL OR substr(booking_date, 1, 10) <= ?)`
  );

/** True when bookings on the account after the snapshot's day (up to `upTo`) make its balance stale. */
function bookedAfter(stmt: ReturnType<typeof lastBookingStmt>, accountId: string, balanceDate: string, upTo: string | null): boolean {
  return ((stmt.get(accountId, upTo, upTo) as { day: string | null }).day ?? '') > balanceDate;
}

const owned = (balance: number, share: number) => cents((balance * share) / 100);

type Known = { account: BalanceHistoryAccount; balance: number | null };

/** Totals of one currency's accounts: the owned share of known balances; unknown ones listed as missing. */
function totalsOf(currency: string, rows: Known[]): NetWorthTotals {
  let assets = 0;
  let liabilities = 0;
  const includedAccountIds: string[] = [];
  const missingAccountIds: string[] = [];
  for (const { account, balance } of rows) {
    if (balance === null) {
      missingAccountIds.push(account.id);
      continue;
    }
    includedAccountIds.push(account.id);
    const value = (balance * account.ownershipShare) / 100;
    // Debt is the negative balance of a liability; a card in credit is an asset.
    if (isLiabilityType(account.subtype) && value < 0) liabilities += -value;
    else assets += value;
  }
  const anyKnown = includedAccountIds.length > 0;
  return {
    currency,
    assets: anyKnown ? cents(assets) : null,
    liabilities: anyKnown ? cents(liabilities) : null,
    netWorth: anyKnown ? cents(assets - liabilities) : null,
    isComplete: anyKnown && missingAccountIds.length === 0,
    coverage: { includedAccountIds, missingAccountIds },
  };
}

/** The EUR totals and one group per other currency (sorted by code). */
function totalsByCurrency(rows: Known[]): { base: NetWorthTotals; others: NetWorthTotals[] } {
  const groups = new Map<string, Known[]>();
  for (const row of rows) {
    const list = groups.get(row.account.currency) ?? [];
    list.push(row);
    groups.set(row.account.currency, list);
  }
  const others = [...groups.keys()]
    .filter((c) => c !== BASE_CURRENCY)
    .sort()
    .map((c) => totalsOf(c, groups.get(c)!));
  return { base: totalsOf(BASE_CURRENCY, groups.get(BASE_CURRENCY) ?? []), others };
}

/** Balance of every account and net worth at the end of each period from `from` to `to`. */
export function balanceHistory(params: Partial<BalanceHistoryParams> & Pick<BalanceHistoryParams, 'interval'>): BalanceHistory {
  const to = params.to ?? getDataStatus().dataAsOf ?? today();
  const from = params.from ?? monthsBefore(to, 12);
  if (from > to) throw new DomainError('invalid_range', 400, { from, to });

  const accounts = accountsWithCoverage();
  const lastBooking = lastBookingStmt();
  const points = pointDates(from, to, params.interval).map((date): BalanceHistoryPoint => {
    const balances = new Map(accountBalances(date, { includeManual: true }).map((b) => [b.accountId, b]));
    const known: Known[] = accounts.map((a) => {
      const b = balances.get(a.id);
      const hasBalance = b?.balance != null && b.date !== null && a.knownFrom !== null && date >= a.knownFrom;
      // An imported account's balance ends with its data, and a booking after the
      // snapshot (a row with a blank Saldo) makes that balance stale.
      const ok =
        hasBalance &&
        (a.tracking === 'manual' ||
          (a.knownUntil !== null && date <= a.knownUntil && !bookedAfter(lastBooking, a.id, b!.date!, date)));
      return { account: a, balance: ok ? b!.balance! : null };
    });
    const { base, others } = totalsByCurrency(known);
    const { currency: _currency, ...totals } = base;
    return {
      date,
      accounts: known.map(({ account, balance }) => ({
        accountId: account.id,
        balance,
        ownedBalance: balance === null ? null : owned(balance, account.ownershipShare),
        balanceDate: balance === null ? null : balances.get(account.id)!.date,
      })),
      ...totals,
      otherCurrencies: others,
    };
  });

  return { from, to, interval: params.interval, accounts, points };
}

/**
 * Net worth now: every account at its latest balance (each at its own date, with
 * its age and staleness). An imported account with bookings after the balance it
 * rests on is unknown, as in the history: its balance has moved since.
 */
export function netWorth(): NetWorth {
  const asOf = today();
  const accounts = accountsWithCoverage();
  const balances = new Map(accountBalances(undefined, { includeManual: true }).map((b) => [b.accountId, b]));
  const intervals = new Map(
    (db.prepare('SELECT id, update_interval_days FROM accounts').all() as Array<{ id: string; update_interval_days: number | null }>).map(
      (r) => [r.id, r.update_interval_days == null ? null : Number(r.update_interval_days)]
    )
  );
  const lastBooking = lastBookingStmt();
  const rows = accounts.map((a): NetWorthAccount => {
    const b: AccountBalance | undefined = balances.get(a.id);
    const base = {
      accountId: a.id,
      name: a.name,
      type: a.subtype,
      tracking: a.tracking,
      currency: a.currency,
      ownershipShare: a.ownershipShare,
    };
    if (b?.balance == null || b.date === null) {
      return { ...base, balance: null, ownedBalance: null, balanceDate: null, source: null, ageDays: null, stale: false, unknownReason: 'no_balance' };
    }
    if (a.tracking === 'imported' && bookedAfter(lastBooking, a.id, b.date, null)) {
      return { ...base, balance: null, ownedBalance: null, balanceDate: b.date, source: b.source, ageDays: null, stale: false, unknownReason: 'bookings_after_balance' };
    }
    const { ageDays, stale } = balanceStaleness(b.date, intervals.get(a.id) ?? null, asOf);
    return {
      ...base,
      balance: b.balance,
      ownedBalance: owned(b.balance, a.ownershipShare),
      balanceDate: b.date,
      source: b.source,
      ageDays,
      stale,
      unknownReason: null,
    };
  });
  const byId = new Map(rows.map((r) => [r.accountId, r]));
  const { base, others } = totalsByCurrency(accounts.map((a) => ({ account: a, balance: byId.get(a.id)!.balance })));
  return {
    ...base,
    asOf,
    accounts: rows,
    staleAccountIds: rows.filter((r) => r.stale).map((r) => r.accountId),
    otherCurrencies: others,
  };
}
