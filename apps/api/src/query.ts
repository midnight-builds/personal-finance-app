import { db } from "./db.js";
import { getSettings } from "./settings.js";

export function listTransactions() {
  const { payday, paydayFlexDays } = getSettings();
  const rows = db
    .prepare(
      `WITH tx AS (
         SELECT counterparty_name,
                amount,
                date(booking_date) AS d
         FROM normalized_transactions
         WHERE booking_date IS NOT NULL
           AND counterparty_name IS NOT NULL
           AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
       ),
       diffs AS (
         SELECT counterparty_name,
                amount,
                d,
                (julianday(d) - julianday(LAG(d) OVER (PARTITION BY counterparty_name, amount ORDER BY d))) AS dd
         FROM tx
       ),
       recurring AS (
         SELECT counterparty_name,
                amount,
                COUNT(*) AS n,
                COUNT(DISTINCT strftime('%Y-%m', d)) AS monthCnt,
                AVG(dd) AS avgDiff,
                SUM(CASE WHEN dd BETWEEN 0.5 AND 1.5 THEN 1 ELSE 0 END) AS dailySteps,
                SUM(CASE WHEN dd BETWEEN 6.0 AND 8.0 THEN 1 ELSE 0 END) AS weeklySteps
         FROM diffs
         GROUP BY counterparty_name, amount
         HAVING n >= 3
       )
       SELECT nt.id,
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
              CASE
                WHEN rec.n >= 6 AND rec.avgDiff BETWEEN 0.8 AND 1.2 AND rec.dailySteps >= (rec.n - 1) * 0.6 THEN 1
                ELSE 0
              END AS recurringDaily,
              CASE
                WHEN rec.n >= 5 AND rec.avgDiff BETWEEN 5.0 AND 9.0 AND rec.weeklySteps >= (rec.n - 1) * 0.6 THEN 1
                ELSE 0
              END AS recurringWeekly,
              CASE
                WHEN rec.monthCnt >= 3 THEN 1
                ELSE 0
              END AS recurringMonthly,
              cd.category_id AS categoryId,
              c.name AS categoryName,
              a.id AS accountId,
              a.name AS accountName,
              a.iban AS accountIban
       FROM normalized_transactions nt
       JOIN accounts a ON a.id = nt.account_id
       LEFT JOIN categorization_decisions cd ON cd.id = (
         SELECT id FROM categorization_decisions
         WHERE transaction_id = nt.id
         ORDER BY created_at DESC
         LIMIT 1
       )
       LEFT JOIN categories c ON c.id = cd.category_id
       LEFT JOIN transfer_links tl ON tl.from_transaction_id = nt.id OR tl.to_transaction_id = nt.id
       LEFT JOIN recurring rec ON rec.counterparty_name = nt.counterparty_name AND rec.amount = nt.amount
       ORDER BY nt.booking_date DESC
       LIMIT 200`
    )
    .all(payday, paydayFlexDays) as Array<Record<string, any>>;

  return rows.map((row) => ({
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
    recurringDaily: Boolean(row.recurringDaily),
    recurringWeekly: Boolean(row.recurringWeekly),
    recurringMonthly: Boolean(row.recurringMonthly),
    isTransfer: Boolean(row.tlFrom || row.tlTo),
    payday,
    paydayFlex: paydayFlexDays,
    account: {
      id: row.accountId,
      name: row.accountName,
      iban: row.accountIban,
    },
  }));
}
