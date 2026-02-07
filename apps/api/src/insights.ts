import { db } from './db.js';

export type Insight = {
  id: string;
  title: string;
  description: string;
  severity: 'info' | 'warn';
  transactionIds: string[];
};

function repeatedSmallPurchases(): Insight[] {
  const rows = db
    .prepare(
      `SELECT counterparty_name AS name,
              COUNT(*) as cnt,
              SUM(amount) as total,
              group_concat(id) as ids
       FROM normalized_transactions
       WHERE booking_date >= datetime('now', '-30 days')
         AND amount < 0
         AND ABS(amount) < 25
         AND counterparty_name IS NOT NULL
         AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
       GROUP BY counterparty_name
       HAVING cnt >= 3
       ORDER BY cnt DESC
       LIMIT 5`
    )
    .all() as Array<any>;

  return rows.map((r) => ({
    id: `small-${r.name}`,
    title: `Pienet toistuvat ostot: ${r.name}`,
    description: `${r.cnt} ostosta 30 päivässä, yhteensä ${Math.abs(r.total).toFixed(2)} EUR`,
    severity: 'info',
    transactionIds: (r.ids as string).split(','),
  }));
}

function risingCategory(): Insight[] {
  const rows = db
    .prepare(
      `WITH last3 AS (
         SELECT c.name as cat, SUM(nt.amount) as s
         FROM normalized_transactions nt
         JOIN categorization_decisions cd ON cd.transaction_id = nt.id
         JOIN categories c ON c.id = cd.category_id
         WHERE nt.booking_date >= datetime('now', '-90 days')
           AND nt.id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
         GROUP BY c.name
       ),
       prev3 AS (
         SELECT c.name as cat, SUM(nt.amount) as s
         FROM normalized_transactions nt
         JOIN categorization_decisions cd ON cd.transaction_id = nt.id
         JOIN categories c ON c.id = cd.category_id
         WHERE nt.booking_date < datetime('now', '-90 days')
           AND nt.booking_date >= datetime('now', '-180 days')
           AND nt.id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
         GROUP BY c.name
       )
       SELECT l.cat as cat, l.s as lastSum, p.s as prevSum
       FROM last3 l
       LEFT JOIN prev3 p ON p.cat = l.cat
       WHERE l.s < 0 AND ABS(l.s) > 100 AND (p.s IS NULL OR ABS(l.s) > ABS(COALESCE(p.s,0)) * 1.2)
       ORDER BY ABS(l.s) DESC
       LIMIT 5`
    )
    .all() as Array<any>;

  return rows.map((r, idx) => ({
    id: `trend-${idx}-${r.cat}`,
    title: `Kategoria kasvaa: ${r.cat}`,
    description: `Kulut viime 3 kk ${Math.abs(r.lastSum).toFixed(2)} EUR, aiemmin ${Math.abs(
      r.prevSum || 0
    ).toFixed(2)} EUR`,
    severity: 'warn',
    transactionIds: [],
  }));
}

export function getInsights(): Insight[] {
  return [...repeatedSmallPurchases(), ...risingCategory()];
}
