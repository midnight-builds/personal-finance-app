import { db } from "./db.js";
import { accountBalances, daysBefore, ledgerEntries, today, type LedgerScope } from "./ledger.js";
import { annualSubscriptions, establishedSubscriptions } from "./patternDecisions.js";

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
  /** Monthly cost of subscriptions, yearly ones included at 1/12 (see the breakdown). */
  monthlySubscriptions: number;
  /** What `monthlySubscriptions` is made of: monthly/weekly ones and the 1/12 share of yearly ones. */
  monthlySubscriptionsBreakdown: { monthly: number; annualShare: number; annualCount: number };
  runwayMonths: number | null;
  accounts: AccountSignal[];
  dataAgeDays: number;
};

/**
 * Every account is listed. An account without any balance snapshot has
 * `balance: null` (unknown, not zero); `totalBalance` and `runwayMonths` then
 * cover known balances only and `isComplete` is false.
 *
 * "Monthly" net is the last 30 days up to and including `asOf`. Of it,
 * `monthlySaving` and `monthlyLoanRepayment` went to (negative) or came from
 * manual savings and loan accounts: cash that left, but not consumption.
 */
export function getSummary(asOf: string = today()) {
  const balances = accountBalances(asOf);
  const missingBalanceAccountCount = balances.filter((b) => b.balance === null).length;
  const totalBalance = cents(balances.reduce((sum, b) => sum + (b.balance ?? 0), 0));

  const last30Days = { from: daysBefore(asOf, 30), to: asOf };
  const last30 = ledgerEntries(last30Days);
  const monthlyNet = cents(last30.reduce((sum, e) => sum + e.amount, 0));
  const ownTransfers = (kind: string) =>
    cents(last30.filter((e) => e.ownTransfer?.kind === kind).reduce((sum, e) => sum + e.amount, 0));

  let runwayMonths: number | null = null;
  if (monthlyNet < 0) {
    runwayMonths = totalBalance / Math.abs(monthlyNet);
  }

  return {
    totalBalance,
    isComplete: missingBalanceAccountCount === 0,
    missingBalanceAccountCount,
    monthlyNet,
    monthlyNetWithTransfers: net({ ...last30Days, includeTransfers: true }),
    monthlySaving: ownTransfers('saving'),
    monthlyLoanRepayment: ownTransfers('loan_repayment'),
    runwayMonths,
    accounts: balances.map((b) => ({
      id: b.accountId,
      name: b.accountName,
      balance: b.balance,
      currency: b.currency,
      date: b.date,
      // Optional debug info (harmless):
      adjustmentSum: b.adjustmentSum,
    })),
  };
}

const cents = (n: number) => Math.round(n * 100) / 100;

function net(scope: LedgerScope): number {
  return cents(ledgerEntries(scope).reduce((sum, e) => sum + e.amount, 0));
}

export function getHouseholdSummary(asOf: string = today()): HouseholdSummary {
  const balanceOf = new Map(accountBalances(asOf).map((b) => [b.accountId, b]));
  const accountRows = db
    .prepare(
      `SELECT id, name, account_subtype, owner_label
       FROM accounts
       WHERE tracking = 'imported'
       ORDER BY created_at ASC, id ASC`
    )
    .all() as Array<{ id: string; name: string; account_subtype: string; owner_label: string | null }>;
  // The snapshot itself, before user corrections: credit debt is what the bank reports.
  const rawBalanceOf = (id: string) => {
    const b = balanceOf.get(id);
    return b?.balance == null ? 0 : cents(b.balance - b.adjustmentSum);
  };

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
    // Unknown balance (no snapshot) counts as zero here.
    const adjustedBalance = balanceOf.get(acct.id)?.balance ?? 0;

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

  const liquidAssets = cents(accounts
    .filter((a) => a.subtype === 'checking')
    .reduce((sum, a) => sum + a.balance, 0));

  const totalSavings = cents(accounts
    .filter((a) => a.subtype === 'savings')
    .reduce((sum, a) => sum + a.balance, 0));

  // Credit debt: sum of credit_card raw balances as positive
  const creditDebt = cents(accountRows
    .filter((a) => a.account_subtype === 'credit_card')
    .reduce((sum, a) => {
      const rawBalance = rawBalanceOf(a.id);
      return sum + Math.abs(rawBalance < 0 ? rawBalance : 0);
    }, 0));

  // Monthly subscriptions: confirmed or confident enough and not lapsed, weekly ones at
  // 52/12 charges a month, plus yearly subscriptions at 1/12 of their amount
  // (patternDecisions.ts). The breakdown keeps the yearly share visible.
  const monthlyOnes = cents(establishedSubscriptions().reduce((sum, p) => sum + (p.monthly_amount ?? 0), 0));
  const annual = annualSubscriptions();
  const annualShare = cents(annual.reduce((sum, p) => sum + Math.abs(p.typical_amount ?? 0) / 12, 0));
  const monthlySubscriptions = cents(monthlyOnes + annualShare);
  const monthlySubscriptionsBreakdown = { monthly: monthlyOnes, annualShare, annualCount: annual.length };

  // Monthly net spend (last 30 days, excluding transfers)
  const monthlyNet = net({ from: daysBefore(asOf, 30), to: asOf });

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
    monthlySubscriptionsBreakdown,
    runwayMonths,
    accounts,
    dataAgeDays,
  };
}
