import { daysBefore, ledgerEntries, today, type LedgerEntry } from './ledger.js';

export type Insight = {
  id: string;
  title: string;
  description: string;
  severity: 'info' | 'warn';
  transactionIds: string[];
  recommendation?: string;
};

// Every detector reads countable transactions from the Ledger. Windows are
// calendar days up to and including `asOf`: "last 30 days" starts 30 days
// before `asOf`.

const sumOf = (rows: LedgerEntry[]) => Math.round(rows.reduce((s, e) => s + e.amount * 100, 0)) / 100;
/** Largest spend first; ties keep Ledger order (oldest first). */
const byAbsAmountDesc = (a: LedgerEntry, b: LedgerEntry) => Math.abs(b.amount) - Math.abs(a.amount);
/** Binary string order, as SQLite compares text. */
const textAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** First day of the month `months` months after (negative: before) the month of `day`. */
function monthStart(day: string, months: number): string {
  const [y, m] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10);
}

function groupBy<T, K>(rows: T[], key: (e: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const e of rows) {
    const k = key(e);
    const list = groups.get(k);
    if (list) list.push(e);
    else groups.set(k, [e]);
  }
  return groups;
}

/** Named purchases (amount < 0, counterparty known) from `from` to `to`. */
function namedExpenses(from: string, to: string): Array<LedgerEntry & { counterparty: string }> {
  return ledgerEntries({ from, to }).filter(
    (e): e is LedgerEntry & { counterparty: string } => e.amount < 0 && e.counterparty !== null
  );
}

function repeatedSmallPurchases(asOf: string): Insight[] {
  const small = namedExpenses(daysBefore(asOf, 30), asOf).filter((e) => Math.abs(e.amount) < 25);
  const rows = [...groupBy(small, (e) => e.counterparty)]
    .map(([name, txs]) => ({ name, cnt: txs.length, total: sumOf(txs), ids: txs.map((e) => e.id) }))
    .filter((r) => r.cnt >= 3)
    .sort((a, b) => b.cnt - a.cnt || textAsc(a.name, b.name))
    .slice(0, 5);

  return rows.map((r) => ({
    id: `small-${r.name}`,
    title: `Pienet toistuvat ostot: ${r.name}`,
    description: `${r.cnt} ostosta 30 päivässä, yhteensä ${Math.abs(r.total).toFixed(2)} EUR`,
    severity: 'info',
    transactionIds: r.ids,
    recommendation:
      'Tarkista onko nämä tarpeellisia: voit niputtaa ne yhteen kategoriaan tai asettaa itsellesi kuukausirajan.',
  }));
}

function risingCategory(asOf: string): Insight[] {
  const categorized = (from: string, to: string) =>
    ledgerEntries({ from, to }).filter(
      (e): e is LedgerEntry & { categoryName: string } => e.categoryName !== null
    );
  const last3 = categorized(daysBefore(asOf, 90), asOf);
  const prev3 = groupBy(categorized(daysBefore(asOf, 180), daysBefore(asOf, 91)), (e) => e.categoryName);

  const rows = [...groupBy(last3, (e) => e.categoryName)]
    .map(([cat, txs]) => ({ cat, txs, lastSum: sumOf(txs), prevSum: prev3.has(cat) ? sumOf(prev3.get(cat)!) : null }))
    .filter(
      (r) =>
        r.lastSum < 0 &&
        Math.abs(r.lastSum) > 100 &&
        (r.prevSum === null || Math.abs(r.lastSum) > Math.abs(r.prevSum) * 1.2)
    )
    .sort((a, b) => Math.abs(b.lastSum) - Math.abs(a.lastSum) || textAsc(a.cat, b.cat))
    .slice(0, 5);

  return rows.map((r, idx) => ({
    id: `trend-${idx}-${r.cat}`,
    title: `Kategoria kasvaa: ${r.cat}`,
    description: `Kulut viime 3 kk ${Math.abs(r.lastSum).toFixed(2)} EUR, aiemmin ${Math.abs(
      r.prevSum || 0
    ).toFixed(2)} EUR`,
    severity: 'warn',
    transactionIds: r.txs
      .filter((e) => e.amount < 0)
      .sort(byAbsAmountDesc)
      .slice(0, 10)
      .map((e) => e.id),
    recommendation:
      'Avaa suurimmat tapahtumat ja varmista kategorisointi. Jos kasvu on ok, harkitse budjetin/puskurin nostoa tälle kategorialle.',
  }));
}

function newRecurringMerchant(asOf: string): Insight[] {
  // Detect a new recurring merchant that appears recently (e.g. new subscription) but wasn't present earlier.
  const prevCount = new Map(
    [...groupBy(namedExpenses(daysBefore(asOf, 365), daysBefore(asOf, 46)), (e) => e.counterparty)].map(
      ([name, txs]) => [name, txs.length]
    )
  );
  const rows = [...groupBy(namedExpenses(daysBefore(asOf, 45), asOf), (e) => e.counterparty)]
    .map(([name, txs]) => ({
      name,
      recentCnt: txs.length,
      recentTotal: sumOf(txs),
      ids: txs.map((e) => e.id),
      prevCnt: prevCount.get(name) ?? 0,
    }))
    .filter((r) => r.recentCnt >= 3 && r.prevCnt <= 1)
    .sort(
      (a, b) =>
        b.recentCnt - a.recentCnt ||
        Math.abs(b.recentTotal) - Math.abs(a.recentTotal) ||
        textAsc(a.name, b.name)
    )
    .slice(0, 5);

  return rows.map((r, idx) => ({
    id: `new-recurring-${idx}-${r.name}`,
    title: `Uusi toistuva maksu: ${r.name}`,
    description: `${r.recentCnt} ostosta 45 päivässä, yhteensä ${Math.abs(r.recentTotal).toFixed(
      2
    )} EUR (aiemmin ${r.prevCnt} krt / 12 kk)`,
    severity: 'warn',
    transactionIds: r.ids,
    recommendation: 'Onko tämä uusi tilaus/palvelu? Jos et käytä sitä, peruuta tai etsi halvempi vaihtoehto.',
  }));
}

/** Keys seen in at least 3 distinct months: known recurring payments. */
function recurringKeys(rows: LedgerEntry[], key: (e: LedgerEntry) => string): Set<string> {
  const months = new Map<string, Set<string>>();
  for (const e of rows) {
    const k = key(e);
    if (!months.has(k)) months.set(k, new Set());
    months.get(k)!.add(e.date.slice(0, 7));
  }
  return new Set([...months].filter(([, m]) => m.size >= 3).map(([k]) => k));
}

function monthlySpike(asOf: string): Insight[] {
  // Compare last full month vs the 3 full months before it, excluding known recurring monthly payments.
  const thisMonth = monthStart(asOf, 0);
  const lastDayOfLastMonth = daysBefore(thisMonth, 1);

  // Recurring = same merchant and amount in >= 3 of the 4 months.
  const tx = namedExpenses(monthStart(asOf, -4), lastDayOfLastMonth);
  const sameCharge = (e: LedgerEntry) => `${e.counterparty}\u0000${e.amount}`;
  const recurring = recurringKeys(tx, sameCharge);
  const rows = [...groupBy(tx.filter((e) => !recurring.has(sameCharge(e))), (e) => e.date.slice(0, 7))]
    .map(([ym, txs]) => ({ ym, s: sumOf(txs) }))
    .sort((a, b) => textAsc(a.ym, b.ym));

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

  // Recurring merchant heuristic: same merchant shows up in >= 3 distinct months of the last 13.
  // (Merchant only here; amount equality can be brittle with floats and price changes.)
  const txAll = namedExpenses(monthStart(asOf, -13), lastDayOfLastMonth);
  const recurringMerchants = recurringKeys(txAll, (e) => e.counterparty!);
  const lastMonthStart = monthStart(asOf, -1);
  const transactionIds = txAll
    .filter((e) => e.date >= lastMonthStart && !recurringMerchants.has(e.counterparty))
    .sort(byAbsAmountDesc)
    .slice(0, 10)
    .map((e) => e.id);

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

function largeSingleExpense(asOf: string): Insight[] {
  const rows = namedExpenses(daysBefore(asOf, 30), asOf)
    .filter((e) => Math.abs(e.amount) >= 200)
    .sort(byAbsAmountDesc)
    .slice(0, 5);

  return rows.map((r, idx) => {
    const absAmt = Math.abs(r.amount);
    const severity: Insight['severity'] = absAmt >= 500 ? 'warn' : 'info';

    return {
      id: `large-expense-${idx}-${r.counterparty}`,
      title: `Iso yksittäinen meno: ${r.counterparty}`,
      description: `${absAmt.toFixed(2)} EUR (30 pv)`,
      severity,
      transactionIds: [r.id],
      recommendation:
        'Avaa tapahtuma ja varmista kategoria. Jos tämä oli kertaluontoinen, kuukausipiikit ja trendit selittyvät usein tällä.',
    };
  });
}

function uncategorizedSpending(asOf: string): Insight[] {
  const rows = ledgerEntries({ from: daysBefore(asOf, 30), to: asOf }).filter(
    (e) => e.amount < 0 && e.categoryId === null
  );
  const cnt = rows.length;
  const totalAbs = Math.abs(sumOf(rows));

  // Keep it quiet unless it looks actionable.
  if (cnt < 10 && totalAbs < 150) return [];

  const transactionIds = rows
    .sort(byAbsAmountDesc)
    .slice(0, 15)
    .map((e) => e.id);

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

export function getInsights(asOf: string = today()): Insight[] {
  return [
    ...repeatedSmallPurchases(asOf),
    ...risingCategory(asOf),
    ...newRecurringMerchant(asOf),
    ...monthlySpike(asOf),
    ...largeSingleExpense(asOf),
    ...uncategorizedSpending(asOf),
  ];
}
