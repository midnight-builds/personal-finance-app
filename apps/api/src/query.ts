import { db } from "./db.js";
import { getSettings } from "./settings.js";
import { latestCategoryDecisionJoin } from "./sql/transactions.js";
import { ledgerEntries } from "./ledger.js";

type RecurringFlags = { daily: boolean; weekly: boolean; monthly: boolean };

const NO_FLAGS: RecurringFlags = { daily: false, weekly: false, monthly: false };

const flagKey = (counterparty: string, amount: number) => `${amount}\u0000${counterparty}`;

/**
 * How often each (counterparty, exact amount) recurs among countable
 * transactions: at least three of them, stepping daily, weekly, or spread
 * over three or more months.
 */
function recurringFlags(): Map<string, RecurringFlags> {
  const days = new Map<string, string[]>();
  for (const e of ledgerEntries()) {
    if (e.counterparty === null) continue;
    const key = flagKey(e.counterparty, e.amount);
    if (!days.has(key)) days.set(key, []);
    days.get(key)!.push(e.date); // oldest first
  }
  const flags = new Map<string, RecurringFlags>();
  for (const [key, ds] of days) {
    const n = ds.length;
    if (n < 3) continue;
    const steps = ds.slice(1).map((d, i) => (Date.parse(d) - Date.parse(ds[i])) / 86400_000);
    const avg = steps.reduce((s, v) => s + v, 0) / steps.length;
    const dailySteps = steps.filter((dd) => dd >= 0.5 && dd <= 1.5).length;
    const weeklySteps = steps.filter((dd) => dd >= 6 && dd <= 8).length;
    flags.set(key, {
      daily: n >= 6 && avg >= 0.8 && avg <= 1.2 && dailySteps >= (n - 1) * 0.6,
      weekly: n >= 5 && avg >= 5 && avg <= 9 && weeklySteps >= (n - 1) * 0.6,
      monthly: new Set(ds.map((d) => d.slice(0, 7))).size >= 3,
    });
  }
  return flags;
}

export function listTransactions() {
  const { payday, paydayFlexDays } = getSettings();
  const rows = db
    .prepare(
      `SELECT nt.id,
              ? AS payday,
              ? AS paydayFlex,
              nt.booking_date AS bookingDate,
              nt.amount,
              nt.currency,
              nt.counterparty_name AS counterpartyName,
              nt.description,
              nt.transaction_group_id AS transactionGroupId,
              (SELECT COUNT(*) FROM normalized_transactions ng WHERE ng.transaction_group_id = nt.transaction_group_id) AS groupSize,
              tl.from_transaction_id AS tlFrom,
              tl.to_transaction_id   AS tlTo,
              cd.category_id AS categoryId,
              c.name AS categoryName,
              a.id AS accountId,
              a.name AS accountName,
              a.iban AS accountIban
       FROM normalized_transactions nt
       JOIN accounts a ON a.id = nt.account_id
       ${latestCategoryDecisionJoin()}
       LEFT JOIN categories c ON c.id = cd.category_id
       LEFT JOIN transfer_links tl ON tl.from_transaction_id = nt.id OR tl.to_transaction_id = nt.id
       ORDER BY nt.booking_date DESC
       LIMIT 200`
    )
    .all(payday, paydayFlexDays) as Array<Record<string, any>>;

  const flags = recurringFlags();
  return rows.map((row) => {
    const rec = (row.counterpartyName !== null && flags.get(flagKey(row.counterpartyName, Number(row.amount)))) || NO_FLAGS;
    return {
      id: row.id,
      bookingDate: row.bookingDate,
      amount: row.amount,
      currency: row.currency,
      counterpartyName: row.counterpartyName,
      description: row.description,
      transactionGroupId: row.transactionGroupId,
      groupSize: row.transactionGroupId ? Number(row.groupSize) : null,
      transfer:
        row.tlFrom || row.tlTo
          ? {
              direction: row.tlFrom === row.id ? "out" : "in",
              otherId: row.tlFrom === row.id ? row.tlTo : row.tlFrom,
            }
          : null,
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      recurringDaily: rec.daily,
      recurringWeekly: rec.weekly,
      recurringMonthly: rec.monthly,
      isTransfer: Boolean(row.tlFrom || row.tlTo),
      payday,
      paydayFlex: paydayFlexDays,
      account: {
        id: row.accountId,
        name: row.accountName,
        iban: row.accountIban,
      },
    };
  });
}
