import {
  BALANCE_HISTORY_MAX_POINTS,
  type BalanceHistory,
  type BalanceHistoryAccount,
  type BalanceHistoryParams,
  type BalanceHistoryPoint,
} from '@finance-app/shared';
import { db } from './db.js';
import { DomainError } from './http/errors.js';
import { accountBalances, daysBefore, today } from './ledger.js';
import { getDataStatus } from './dataStatus.js';

// Balances and net worth over time, read from the balance snapshots imports
// store (never reconstructed from cash flow). An account's balance on a day is
// known only between its first snapshot and the last day its imported data
// covers; elsewhere it is unknown (null), never zero, and the point says so.

/** Asset classes no account type covers, so net worth never includes them. */
const UNTRACKED_ASSET_CLASSES = ['investments'];

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
      `SELECT a.id, a.name, a.account_subtype AS subtype,
              (SELECT MIN(substr(s.date, 1, 10)) FROM balance_snapshots s WHERE s.account_id = a.id) AS first_snapshot,
              (SELECT MAX(substr(s.date, 1, 10)) FROM balance_snapshots s WHERE s.account_id = a.id) AS last_snapshot,
              (SELECT MAX(substr(t.booking_date, 1, 10)) FROM normalized_transactions t
               WHERE t.account_id = a.id AND t.booking_date IS NOT NULL) AS last_booking
       FROM accounts a
       ORDER BY a.created_at ASC, a.id ASC`
    )
    .all() as Array<{
    id: string;
    name: string;
    subtype: BalanceHistoryAccount['subtype'];
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
      knownFrom: r.first_snapshot,
      knownUntil: r.first_snapshot ? (ends.at(-1) ?? null) : null,
    };
  });
}

/** Balance of every account and net worth at the end of each period from `from` to `to`. */
export function balanceHistory(params: Partial<BalanceHistoryParams> & Pick<BalanceHistoryParams, 'interval'>): BalanceHistory {
  const to = params.to ?? getDataStatus().dataAsOf ?? today();
  const from = params.from ?? monthsBefore(to, 12);
  if (from > to) throw new DomainError('invalid_range', 400, { from, to });

  const accounts = accountsWithCoverage();
  const points = pointDates(from, to, params.interval).map((date): BalanceHistoryPoint => {
    const balances = new Map(accountBalances(date).map((b) => [b.accountId, b]));
    let assets = 0;
    let liabilities = 0;
    const includedAccountIds: string[] = [];
    const missingAccountIds: string[] = [];
    const perAccount = accounts.map((a) => {
      const b = balances.get(a.id);
      const known =
        b?.balance != null && a.knownFrom !== null && a.knownUntil !== null && date >= a.knownFrom && date <= a.knownUntil;
      if (!known) {
        missingAccountIds.push(a.id);
        return { accountId: a.id, balance: null, balanceDate: null };
      }
      const balance = b.balance!;
      includedAccountIds.push(a.id);
      if (a.subtype === 'credit_card' && balance < 0) liabilities += -balance;
      else assets += balance;
      return { accountId: a.id, balance, balanceDate: b.date };
    });
    return {
      date,
      accounts: perAccount,
      assets: cents(assets),
      liabilities: cents(liabilities),
      netWorth: cents(assets - liabilities),
      isComplete: missingAccountIds.length === 0,
      coverage: { includedAccountIds, missingAccountIds },
    };
  });

  return { from, to, interval: params.interval, accounts, untrackedAssetClasses: UNTRACKED_ASSET_CLASSES, points };
}
