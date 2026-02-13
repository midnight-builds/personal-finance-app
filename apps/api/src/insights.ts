import { db } from './db.js';

export type Insight = {
  id: string;
  title: string;
  description: string;
  severity: 'info' | 'warn';
  transactionIds: string[];
  recommendation?: string;
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
    recommendation:
      'Tarkista onko nämä tarpeellisia: voit niputtaa ne yhteen kategoriaan tai asettaa itsellesi kuukausirajan.',
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

  const topTransactionIdsForCategory = (cat: string): string[] => {
    const idsRows = db
      .prepare(
        `SELECT nt.id as id
         FROM normalized_transactions nt
         JOIN categorization_decisions cd ON cd.transaction_id = nt.id
         JOIN categories c ON c.id = cd.category_id
         WHERE nt.booking_date >= datetime('now', '-90 days')
           AND nt.amount < 0
           AND c.name = ?
           AND nt.id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
         ORDER BY ABS(nt.amount) DESC
         LIMIT 10`
      )
      .all(cat) as Array<any>;

    return idsRows.map((r) => String(r.id));
  };

  return rows.map((r, idx) => ({
    id: `trend-${idx}-${r.cat}`,
    title: `Kategoria kasvaa: ${r.cat}`,
    description: `Kulut viime 3 kk ${Math.abs(r.lastSum).toFixed(2)} EUR, aiemmin ${Math.abs(
      r.prevSum || 0
    ).toFixed(2)} EUR`,
    severity: 'warn',
    transactionIds: topTransactionIdsForCategory(String(r.cat)),
    recommendation:
      'Avaa suurimmat tapahtumat ja varmista kategorisointi. Jos kasvu on ok, harkitse budjetin/puskurin nostoa tälle kategorialle.',
  }));
}

function newRecurringMerchant(): Insight[] {
  // Detect a new recurring merchant that appears recently (e.g. new subscription) but wasn't present earlier.
  const rows = db
    .prepare(
      `WITH recent AS (
         SELECT counterparty_name AS name,
                COUNT(*) as cnt,
                SUM(amount) as total,
                group_concat(id) as ids
         FROM normalized_transactions
         WHERE booking_date >= datetime('now', '-45 days')
           AND amount < 0
           AND counterparty_name IS NOT NULL
           AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
         GROUP BY counterparty_name
         HAVING cnt >= 3
       ),
       prev AS (
         SELECT counterparty_name AS name,
                COUNT(*) as cnt
         FROM normalized_transactions
         WHERE booking_date < datetime('now', '-45 days')
           AND booking_date >= datetime('now', '-365 days')
           AND amount < 0
           AND counterparty_name IS NOT NULL
           AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
         GROUP BY counterparty_name
       )
       SELECT r.name as name, r.cnt as recentCnt, r.total as recentTotal, r.ids as ids, COALESCE(p.cnt, 0) as prevCnt
       FROM recent r
       LEFT JOIN prev p ON p.name = r.name
       WHERE COALESCE(p.cnt, 0) <= 1
       ORDER BY r.cnt DESC, ABS(r.total) DESC
       LIMIT 5`
    )
    .all() as Array<any>;

  return rows.map((r, idx) => ({
    id: `new-recurring-${idx}-${r.name}`,
    title: `Uusi toistuva maksu: ${r.name}`,
    description: `${r.recentCnt} ostosta 45 päivässä, yhteensä ${Math.abs(r.recentTotal).toFixed(
      2
    )} EUR (aiemmin ${r.prevCnt} krt / 12 kk)`,
    severity: 'warn',
    transactionIds: String(r.ids).split(','),
    recommendation: 'Onko tämä uusi tilaus/palvelu? Jos et käytä sitä, peruuta tai etsi halvempi vaihtoehto.',
  }));
}

function monthlySpike(): Insight[] {
  // Compare last full month vs the 3 full months before it, excluding known recurring monthly payments.
  const rows = db
    .prepare(
      `WITH tx AS (
         SELECT id,
                counterparty_name AS name,
                amount,
                date(booking_date) AS d,
                booking_date
         FROM normalized_transactions
         WHERE booking_date IS NOT NULL
           AND counterparty_name IS NOT NULL
           AND amount < 0
           AND booking_date < date('now', 'start of month')
           AND booking_date >= date('now', 'start of month', '-4 months')
           AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
       ),
       diffs AS (
         SELECT name,
                amount,
                d,
                (julianday(d) - julianday(LAG(d) OVER (PARTITION BY name, amount ORDER BY d))) AS dd
         FROM tx
       ),
       recurring AS (
         SELECT name,
                amount,
                COUNT(*) AS n,
                COUNT(DISTINCT strftime('%Y-%m', d)) AS monthCnt
         FROM diffs
         GROUP BY name, amount
         HAVING n >= 3
       )
       SELECT strftime('%Y-%m', tx.booking_date) as ym, SUM(tx.amount) as s
       FROM tx
       LEFT JOIN recurring rec ON rec.name = tx.name AND rec.amount = tx.amount
       WHERE COALESCE(rec.monthCnt, 0) < 3
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
      `WITH tx AS (
         SELECT id,
                counterparty_name AS name,
                amount,
                date(booking_date) AS d,
                booking_date
         FROM normalized_transactions
         WHERE booking_date IS NOT NULL
           AND counterparty_name IS NOT NULL
           AND amount < 0
           AND booking_date >= date('now', 'start of month', '-1 month')
           AND booking_date < date('now', 'start of month')
           AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
       ),
       diffs AS (
         SELECT name,
                amount,
                d,
                (julianday(d) - julianday(LAG(d) OVER (PARTITION BY name, amount ORDER BY d))) AS dd
         FROM tx
       ),
       recurring AS (
         SELECT name,
                amount,
                COUNT(*) AS n,
                COUNT(DISTINCT strftime('%Y-%m', d)) AS monthCnt
         FROM diffs
         GROUP BY name, amount
         HAVING n >= 3
       )
       SELECT tx.id as id
       FROM tx
       LEFT JOIN recurring rec ON rec.name = tx.name AND rec.amount = tx.amount
       WHERE COALESCE(rec.monthCnt, 0) < 3
       ORDER BY ABS(tx.amount) DESC
       LIMIT 10`
    )
    .all() as Array<any>;

  const transactionIds = idsRows.map((r) => String(r.id));

  return [
    {
      id: `monthly-spike-${last.ym}`,
      title: `Kuukausipiikki (ei toistuvat): ${last.ym}`,
      description: `Kulut ${last.ym}: ${lastAbs.toFixed(2)} EUR (edellisten 3 kk keskiarvo ${prevAvgAbs.toFixed(
        2
      )} EUR)`,
      severity: 'warn',
      transactionIds,
      recommendation:
        'Tämä piikki ei näytä selittyvän tunnetuilla kuukausittaisilla toistuvuuksilla. Katso top-kulut: usein taustalla on kertaerä (matka, vakuutus, iso hankinta) tai uusi palvelu.',
    },
  ];
}

function uncategorizedSpending(): Insight[] {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt, SUM(nt.amount) as total
       FROM normalized_transactions nt
       LEFT JOIN categorization_decisions cd ON cd.transaction_id = nt.id
       WHERE nt.booking_date >= datetime('now', '-30 days')
         AND nt.amount < 0
         AND cd.transaction_id IS NULL
         AND nt.id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)`
    )
    .get() as any;

  const cnt = Number(row?.cnt || 0);
  const total = Number(row?.total || 0);
  const totalAbs = Math.abs(total);

  // Keep it quiet unless it looks actionable.
  if (cnt < 10 && totalAbs < 150) return [];

  const idsRows = db
    .prepare(
      `SELECT nt.id as id
       FROM normalized_transactions nt
       LEFT JOIN categorization_decisions cd ON cd.transaction_id = nt.id
       WHERE nt.booking_date >= datetime('now', '-30 days')
         AND nt.amount < 0
         AND cd.transaction_id IS NULL
         AND nt.id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
       ORDER BY ABS(nt.amount) DESC
       LIMIT 15`
    )
    .all() as Array<any>;

  const transactionIds = idsRows.map((r) => String(r.id));

  return [
    {
      id: `uncategorized-30d`,
      title: 'Kategorisoimattomia menoja (30 pv)',
      description: `${cnt} tapahtumaa ilman kategoriaa, yhteensä ${totalAbs.toFixed(2)} EUR`,
      severity: totalAbs >= 300 ? 'warn' : 'info',
      transactionIds,
      recommendation:
        'Avaa top-tapahtumat ja aseta kategoriat. Tämä parantaa kuukausikatsausta ja trendi-insightteja (ja samalla syntyy sääntöjä).',
    },
  ];
}

export function getInsights(): Insight[] {
  return [
    ...repeatedSmallPurchases(),
    ...risingCategory(),
    ...newRecurringMerchant(),
    ...monthlySpike(),
    ...uncategorizedSpending(),
  ];
}
