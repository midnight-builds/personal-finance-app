import { db } from "./db.js";
import { getAdjustmentSumForAccountAtOrBeforeDate } from "./balanceAdjustments.js";

export type AccountSignal = {
  id: string;
  name: string;
  subtype: string;
  ownerLabel: string | null;
  balance: number;
  trend: 'up' | 'down' | 'stable' | null;
  warningLevel: 'none' | 'warn' | 'alert';
};

export type HouseholdSummary = {
  liquidAssets: number;
  totalSavings: number;
  creditDebt: number;
  monthlySubscriptions: number;
  runwayMonths: number | null;
  accounts: AccountSignal[];
  dataAgeDays: number;
};

/**
 * Every account is listed. An account without any balance snapshot has
 * `balance: null` (unknown, not zero); `totalBalance` and `runwayMonths` then
 * cover known balances only and `isComplete` is false.
 */
export function getSummary() {
  const latestBalances = db
    .prepare(
      `SELECT a.id AS accountId,
              a.name AS accountName,
              b.balance,
              b.currency,
              b.date
       FROM accounts a
       LEFT JOIN (
         SELECT bs.account_id, bs.balance, bs.currency, bs.date
         FROM balance_snapshots bs
         JOIN (
           SELECT account_id, MAX(date) AS maxdate FROM balance_snapshots GROUP BY account_id
         ) latest ON latest.account_id = bs.account_id AND latest.maxdate = bs.date
         GROUP BY bs.account_id
       ) b ON b.account_id = a.id
       ORDER BY a.created_at ASC`
    )
    .all() as Array<any>;

  const accountsWithAdjustments = latestBalances.map((b) => {
    if (b.date == null) return { ...b, adjustedBalance: null, adjustmentSum: 0 };
    const baseBalance = Number(b.balance) || 0;
    const adj = getAdjustmentSumForAccountAtOrBeforeDate(String(b.accountId), String(b.date));
    return {
      ...b,
      adjustedBalance: baseBalance + adj,
      adjustmentSum: adj,
    };
  });

  const missingBalanceAccountCount = accountsWithAdjustments.filter((b) => b.adjustedBalance === null).length;
  const totalBalance = accountsWithAdjustments.reduce((sum, b) => sum + (Number(b.adjustedBalance) || 0), 0);

  const monthlyNetRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) AS net
       FROM normalized_transactions
       WHERE booking_date >= datetime('now', '-30 days')
         AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)`
    )
    .get() as { net: number };

  const monthlyNet = Number(monthlyNetRow.net || 0);

  const monthlyNetAll = db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) AS net
       FROM normalized_transactions
       WHERE booking_date >= datetime('now', '-30 days')`
    )
    .get() as { net: number };

  let runwayMonths: number | null = null;
  if (monthlyNet < 0) {
    runwayMonths = totalBalance / Math.abs(monthlyNet);
  }

  return {
    totalBalance,
    isComplete: missingBalanceAccountCount === 0,
    missingBalanceAccountCount,
    monthlyNet,
    monthlyNetWithTransfers: Number(monthlyNetAll.net || 0),
    runwayMonths,
    accounts: accountsWithAdjustments.map((b) => ({
      id: b.accountId,
      name: b.accountName,
      balance: b.adjustedBalance === null ? null : Number(b.adjustedBalance),
      currency: b.currency ?? null,
      date: b.date ?? null,
      // Optional debug info (harmless):
      adjustmentSum: Number(b.adjustmentSum || 0),
    })),
  };
}

export function getHouseholdSummary(): HouseholdSummary {
  // Fetch all accounts with their latest adjusted balance
  const accountRows = db
    .prepare(
      `SELECT a.id, a.name, a.account_subtype, a.owner_label,
              b.balance AS rawBalance,
              b.date AS snapshotDate
       FROM accounts a
       LEFT JOIN (
         SELECT bs.account_id, bs.balance, bs.date
         FROM balance_snapshots bs
         JOIN (
           SELECT account_id, MAX(date) AS maxdate FROM balance_snapshots GROUP BY account_id
         ) latest ON latest.account_id = bs.account_id AND latest.maxdate = bs.date
       ) b ON b.account_id = a.id
       ORDER BY a.created_at ASC`
    )
    .all() as Array<{
      id: string;
      name: string;
      account_subtype: string;
      owner_label: string | null;
      rawBalance: number | null;
      snapshotDate: string | null;
    }>;

  // Fetch the 2 most recent balance snapshots per account for trend computation
  const snapshotsByAccount = new Map<string, number[]>();
  const allSnapshotsRows = db
    .prepare(
      `SELECT account_id, balance, date
       FROM balance_snapshots
       ORDER BY account_id, date DESC`
    )
    .all() as Array<{ account_id: string; balance: number; date: string }>;

  for (const row of allSnapshotsRows) {
    const existing = snapshotsByAccount.get(row.account_id) ?? [];
    if (existing.length < 2) {
      existing.push(Number(row.balance));
      snapshotsByAccount.set(row.account_id, existing);
    }
  }

  const accounts: AccountSignal[] = accountRows.map((acct) => {
    const rawBalance = acct.rawBalance != null ? Number(acct.rawBalance) : 0;
    const adj = acct.snapshotDate
      ? getAdjustmentSumForAccountAtOrBeforeDate(acct.id, acct.snapshotDate)
      : 0;
    const adjustedBalance = rawBalance + adj;

    // Trend: compare 2nd-most-recent vs most-recent
    const snapshots = snapshotsByAccount.get(acct.id) ?? [];
    let trend: 'up' | 'down' | 'stable' | null = null;
    if (snapshots.length >= 2) {
      const newest = snapshots[0];
      const older = snapshots[1];
      if (older !== 0) {
        const pctChange = (newest - older) / Math.abs(older);
        if (pctChange > 0.01) trend = 'up';
        else if (pctChange < -0.01) trend = 'down';
        else trend = 'stable';
      } else {
        // older is 0: treat any positive change as up, negative as down
        if (newest > 0) trend = 'up';
        else if (newest < 0) trend = 'down';
        else trend = 'stable';
      }
    }

    // Warning level
    let warningLevel: 'none' | 'warn' | 'alert' = 'none';
    if (acct.account_subtype === 'credit_card') {
      const rawLatest = snapshots[0] ?? null;
      const rawPrev = snapshots[1] ?? null;
      // Credit card balances are negative — positive rawBalance means they owe
      // "balance > 0" in the task means owed (stored as negative in DB, so absolute > 0)
      if (rawLatest !== null && rawLatest < 0) {
        // balance > 0 means credit card debt exists
        if (rawPrev !== null && rawLatest < rawPrev) {
          // balance went more negative = debt increased
          warningLevel = 'alert';
        } else {
          warningLevel = 'warn';
        }
      }
    }

    return {
      id: acct.id,
      name: acct.name,
      subtype: acct.account_subtype,
      ownerLabel: acct.owner_label,
      balance: adjustedBalance,
      trend,
      warningLevel,
    };
  });

  const liquidAssets = accounts
    .filter((a) => a.subtype === 'checking')
    .reduce((sum, a) => sum + a.balance, 0);

  const totalSavings = accounts
    .filter((a) => a.subtype === 'savings')
    .reduce((sum, a) => sum + a.balance, 0);

  // Credit debt: sum of credit_card raw balances as positive
  const creditDebt = accountRows
    .filter((a) => a.account_subtype === 'credit_card')
    .reduce((sum, a) => {
      const rawBalance = a.rawBalance != null ? Number(a.rawBalance) : 0;
      return sum + Math.abs(rawBalance < 0 ? rawBalance : 0);
    }, 0);

  // Monthly subscriptions: sum typical_amount from active subscription patterns
  const subRow = db
    .prepare(
      `SELECT COALESCE(SUM(typical_amount), 0) AS total
       FROM recurring_patterns
       WHERE pattern_type = 'subscription' AND is_active = 1`
    )
    .get() as { total: number };
  const monthlySubscriptions = Number(subRow.total || 0);

  // Monthly net spend (last 30 days, excluding transfers)
  const monthlyNetRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS net
       FROM normalized_transactions
       WHERE booking_date >= datetime('now', '-30 days')
         AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)`
    )
    .get() as { net: number };
  const monthlyNet = Number(monthlyNetRow.net || 0);

  let runwayMonths: number | null = null;
  if (monthlyNet < 0) {
    runwayMonths = liquidAssets / Math.abs(monthlyNet);
  }

  // Data age days
  const ageRow = db
    .prepare(`SELECT MAX(created_at) AS maxCreatedAt FROM import_sessions`)
    .get() as { maxCreatedAt: string | null };
  let dataAgeDays = 0;
  if (ageRow.maxCreatedAt) {
    const maxTs = new Date(ageRow.maxCreatedAt).getTime();
    dataAgeDays = Math.floor((Date.now() - maxTs) / 86400000);
  }

  return {
    liquidAssets,
    totalSavings,
    creditDebt,
    monthlySubscriptions,
    runwayMonths,
    accounts,
    dataAgeDays,
  };
}
