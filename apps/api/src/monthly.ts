import { db } from './db.js';
import { getSettings } from './settings.js';

export function getMonthlyOverview(limit = 6) {
  const settings = getSettings();
  const { payday, paydayFlexDays } = settings;

  const rows = db
    .prepare(
      `WITH periods AS (
         -- generate last N months periods based on payday + flex window
         SELECT
           date('now', printf('-%d months', n)) AS anchor,
           n
         FROM (
           SELECT 0 as n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9
         )
       ),
       windowed AS (
         SELECT
           n,
           anchor,
           -- payday window start and end for each anchor month
           date(anchor, printf('start of month'), printf('+%d day', ? - 1 - ?)) AS period_start,
           date(anchor, printf('start of month'), printf('+%d day', ? - 1 + ?)) AS period_end,
           date(anchor, printf('start of month'), printf('+%d month', 1), printf('+%d day', ? - 1 - ?)) AS next_start
         FROM periods
       ),
       tx AS (
         SELECT
           w.n,
           SUM(CASE WHEN nt.amount > 0 THEN nt.amount ELSE 0 END) AS income,
           SUM(CASE WHEN nt.amount < 0 THEN nt.amount ELSE 0 END) AS expense,
           SUM(nt.amount) AS net
         FROM windowed w
         LEFT JOIN normalized_transactions nt
           ON date(nt.booking_date) > w.period_start
          AND date(nt.booking_date) <= w.next_start
          AND nt.id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
         GROUP BY w.n
       )
       SELECT
         strftime('%Y-%m', date('now', printf('-%d months', n))) AS label,
         income,
         expense,
         net
       FROM tx
       ORDER BY n ASC
       LIMIT ?`
    )
    .all(
      payday,
      paydayFlexDays,
      payday,
      paydayFlexDays,
      payday,
      paydayFlexDays,
      limit
    ) as Array<any>;

  return rows
    .map((r) => ({
      month: r.label,
      income: Number(r.income || 0),
      expense: Number(r.expense || 0),
      net: Number(r.net || 0),
      direction: Number(r.net || 0) > 0 ? 'up' : Number(r.net || 0) < 0 ? 'down' : 'flat',
    }))
    .reverse();
}
