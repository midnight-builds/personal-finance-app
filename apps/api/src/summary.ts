import { db } from "./db.js";
import { getAdjustmentSumForAccountAtOrBeforeDate } from "./balanceAdjustments.js";

export function getSummary() {
  const latestBalances = db
    .prepare(
      `SELECT b.account_id AS accountId,
              a.name AS accountName,
              b.balance,
              b.currency,
              b.date
       FROM balance_snapshots b
       JOIN accounts a ON a.id = b.account_id
       JOIN (
         SELECT account_id, MAX(date) AS maxdate FROM balance_snapshots GROUP BY account_id
       ) latest ON latest.account_id = b.account_id AND latest.maxdate = b.date
       GROUP BY b.account_id`
    )
    .all() as Array<any>;

  const accountsWithAdjustments = latestBalances.map((b) => {
    const baseBalance = Number(b.balance) || 0;
    const adj = getAdjustmentSumForAccountAtOrBeforeDate(String(b.accountId), String(b.date));
    return {
      ...b,
      adjustedBalance: baseBalance + adj,
      adjustmentSum: adj,
    };
  });

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
    monthlyNet,
    monthlyNetWithTransfers: Number(monthlyNetAll.net || 0),
    runwayMonths,
    accounts: accountsWithAdjustments.map((b) => ({
      id: b.accountId,
      name: b.accountName,
      balance: Number(b.adjustedBalance),
      currency: b.currency,
      date: b.date,
      // Optional debug info (harmless):
      adjustmentSum: Number(b.adjustmentSum || 0),
    })),
  };
}
