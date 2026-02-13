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

function monthlySpike(): Insight[] {
  // Compare last full month vs the 3 full months before it.
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m', booking_date) as ym, SUM(amount) as s
       FROM normalized_transactions
       WHERE amount < 0
         AND booking_date < date('now', 'start of month')
         AND booking_date >= date('now', 'start of month', '-4 months')
         AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
       GROUP BY ym
       ORDER BY ym ASC`
    )
    .all() as Array<any>;

  if (rows.length < 4) return [];

  const last = rows[rows.length - 1];
  const prev3 = rows.slice(-4, -1);
  const lastAbs = Math.abs(Number(last.s || 0));
  const prevAvgAbs = prev3.reduce((acc, r) => acc + Math.abs(Number(r.s || 0)), 0) / 3;

  if (!Number.isFinite(lastAbs) || !Number.isFinite(prevAvgAbs) || prevAvgAbs <= 0) return [];

  const ratio = lastAbs / prevAvgAbs;
  const delta = lastAbs - prevAvgAbs;

  // Gate to avoid noise: must be meaningfully larger and over an absolute threshold.
  if (ratio < 1.3 || delta < 150) return [];

  const idsRows = db
    .prepare(
      `SELECT id
       FROM normalized_transactions
       WHERE amount < 0
         AND booking_date >= date('now', 'start of month', '-1 month')
         AND booking_date < date('now', 'start of month')
         AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
       ORDER BY ABS(amount) DESC
       LIMIT 10`
    )
    .all() as Array<any>;

  const transactionIds = idsRows.map((r) => String(r.id));

  return [
    {
      id: `monthly-spike-${last.ym}`,
      title: `Kuukausipiikki: ${last.ym}`,
      description: `Kulut ${last.ym}: ${lastAbs.toFixed(2)} EUR (edellisten 3 kk keskiarvo ${prevAvgAbs.toFixed(
        2
      )} EUR)`,
      severity: 'warn',
      transactionIds,
    },
  ];
}

export function getInsights(): Insight[] {
  return [...repeatedSmallPurchases(), ...risingCategory(), ...monthlySpike()];
}
