// Fictional household data for demos and tests: two Nordea-style exports of a
// checking account that overlap by one month, a savings account fed by monthly
// transfers, and the usual recurring bills. Fully deterministic for a given
// anchor date, so tests can assert exact figures. Names and IBANs are made up.
import { processImport, checksum } from '../importer.js';
import { db } from '../db.js';
import { upsertDecision } from '../rules.js';
import { createBalanceAdjustment } from '../balanceAdjustments.js';

export const DEMO_CHECKING_IBAN = 'FI00 1234 5600 0000 01';
export const DEMO_SAVINGS_IBAN = 'FI00 1234 5600 0000 02';

export type DemoRow = { date: string; amount: number; counterparty: string; message?: string };

export type DemoExport = {
  filename: string;
  accountName: string;
  accountIban: string;
  records: Record<string, unknown>[];
};

/** Months covered by the checking account history, ending at the anchor month. */
export const DEMO_MONTHS = 6;

function ymd(year: number, month: number, day: number) {
  const d = new Date(Date.UTC(year, month, day));
  return d.toISOString().slice(0, 10);
}

/** First day of the month `offset` months before the anchor's month (offset 0 = anchor month). */
function monthStart(anchor: string, offset: number) {
  const [y, m] = anchor.split('-').map(Number);
  return { year: y, month: m - 1 - offset };
}

/**
 * Checking account rows, oldest first, for the DEMO_MONTHS months up to and
 * including `anchor` (YYYY-MM-DD). Rows dated after the anchor are dropped.
 */
export function demoCheckingRows(anchor: string): DemoRow[] {
  const rows: DemoRow[] = [];
  const groceryShops = ['K-Market Demokylä', 'S-Market Esimerkki', 'Lidl Testikatu'];
  for (let offset = DEMO_MONTHS - 1; offset >= 0; offset--) {
    const { year, month } = monthStart(anchor, offset);
    const at = (day: number) => ymd(year, month, day);
    const monthIndex = DEMO_MONTHS - 1 - offset; // 0 = oldest month

    rows.push({ date: at(1), amount: -950, counterparty: 'Asunto Oy Demokatu', message: 'Vuokra' });
    rows.push({ date: at(3), amount: -24.9, counterparty: 'Elisa Oyj', message: 'Puhelinlasku' });
    rows.push({ date: at(5), amount: -13.99, counterparty: 'Netflix' });
    rows.push({ date: at(8), amount: -(55 + monthIndex * 4), counterparty: 'Helen Oy', message: 'Sähkö' });
    rows.push({ date: at(15), amount: 3200, counterparty: 'Esimerkki Oy', message: 'Palkka' });
    rows.push({ date: at(16), amount: -300, counterparty: 'Oma säästötili', message: 'Säästö' });

    // Weekly groceries; the fourth month is a spike month.
    const spike = monthIndex === 3 ? 2.2 : 1;
    for (const [i, day] of [2, 9, 16, 23].entries()) {
      rows.push({
        date: at(day),
        amount: -Math.round((48 + i * 11 + monthIndex * 3) * spike * 100) / 100,
        counterparty: groceryShops[i % groceryShops.length],
      });
    }
    // Two genuinely identical coffees on the same day: not duplicates.
    rows.push({ date: at(12), amount: -4.5, counterparty: 'Kahvila Papu' });
    rows.push({ date: at(12), amount: -4.5, counterparty: 'Kahvila Papu' });

    if (monthIndex % 2 === 1) rows.push({ date: at(20), amount: -62.4, counterparty: 'Ravintola Esimerkki' });
    // A subscription that only started in the last two months.
    if (monthIndex >= DEMO_MONTHS - 2) rows.push({ date: at(6), amount: -11.99, counterparty: 'Spotify' });
    // One annual bill and one large one-off purchase.
    if (monthIndex === 1) rows.push({ date: at(10), amount: -420, counterparty: 'If Vahinkovakuutus', message: 'Kotivakuutus' });
    if (monthIndex === 4) rows.push({ date: at(19), amount: -899, counterparty: 'Verkkokauppa.com', message: 'Kannettava' });
  }
  return rows.filter((r) => r.date <= anchor).sort((a, b) => a.date.localeCompare(b.date));
}

/** Savings account: the other side of every monthly transfer. */
export function demoSavingsRows(anchor: string): DemoRow[] {
  return demoCheckingRows(anchor)
    .filter((r) => r.counterparty === 'Oma säästötili')
    .map((r) => ({ date: r.date, amount: -r.amount, counterparty: 'Oma käyttötili', message: 'Säästö' }));
}

/** Nordea export rows for oldest-first `rows`: running balance, newest row first like the bank. */
function toRecords(rows: DemoRow[], openingBalance: number): Record<string, unknown>[] {
  let balance = openingBalance;
  const records = rows.map((r) => {
    balance = Math.round((balance + r.amount) * 100) / 100;
    const fmt = (n: number) => n.toFixed(2).replace('.', ',');
    return {
      Kirjauspäivä: r.date.replace(/-/g, '/'),
      Määrä: fmt(r.amount),
      Maksaja: r.amount > 0 ? r.counterparty : '',
      Maksunsaaja: r.amount < 0 ? r.counterparty : '',
      Nimi: r.counterparty,
      Otsikko: '',
      Viesti: r.message ?? '',
      Viitenumero: '',
      Saldo: fmt(balance),
      Valuutta: 'EUR',
    };
  });
  return records.reverse();
}

export const DEMO_CHECKING_OPENING = 1500;
export const DEMO_SAVINGS_OPENING = 5000;

/**
 * The exports a user would upload, in upload order. The second checking
 * export starts one month before the first one ends, so that month's rows
 * arrive twice and must be grouped as duplicates.
 */
export function demoExports(anchor: string): DemoExport[] {
  const checking = toRecords(demoCheckingRows(anchor), DEMO_CHECKING_OPENING);
  const { year, month } = monthStart(anchor, 1);
  const overlapStart = ymd(year, month, 1);
  const firstEnd = ymd(year, month + 1, 0); // last day of the previous month
  const isoOf = (rec: Record<string, unknown>) => String(rec['Kirjauspäivä']).replace(/\//g, '-');

  return [
    {
      filename: 'demo-kayttotili-1.csv',
      accountName: 'Käyttötili',
      accountIban: DEMO_CHECKING_IBAN,
      records: checking.filter((r) => isoOf(r) <= firstEnd),
    },
    {
      filename: 'demo-kayttotili-2.csv',
      accountName: 'Käyttötili',
      accountIban: DEMO_CHECKING_IBAN,
      records: checking.filter((r) => isoOf(r) >= overlapStart),
    },
    {
      filename: 'demo-saastotili.csv',
      accountName: 'Säästötili',
      accountIban: DEMO_SAVINGS_IBAN,
      records: toRecords(demoSavingsRows(anchor), DEMO_SAVINGS_OPENING),
    },
  ];
}

export type DemoSeedResult = { accountIds: { checking: string; savings: string }; importSessionIds: string[] };

/**
 * Runs the demo exports through the real import pipeline, then adds what a
 * user would do by hand: one manual recategorization and one balance correction.
 * Expects an initialized database with default categories.
 */
export async function seedDemo(anchor: string): Promise<DemoSeedResult> {
  const importSessionIds: string[] = [];
  for (const exp of demoExports(anchor)) {
    const result = await processImport({
      records: exp.records,
      checksum: checksum(Buffer.from(JSON.stringify(exp.records))),
      filename: exp.filename,
      accountName: exp.accountName,
      accountIban: exp.accountIban,
      sourceBank: 'nordea',
      format: 'csv',
    });
    importSessionIds.push(result.importSessionId);
  }

  const accountId = (iban: string) =>
    (db.prepare('SELECT id FROM accounts WHERE iban = ?').get(iban) as { id: string }).id;
  const checking = accountId(DEMO_CHECKING_IBAN);
  const savings = accountId(DEMO_SAVINGS_IBAN);

  // The user files the restaurant visits under a category of their choosing.
  const restaurant = db
    .prepare(`SELECT id FROM categories WHERE name = 'Viihde ja harrastukset'`)
    .get() as { id: string } | undefined;
  if (restaurant) {
    const txs = db
      .prepare(`SELECT id FROM normalized_transactions WHERE counterparty_name = 'Ravintola Esimerkki'`)
      .all() as Array<{ id: string }>;
    for (const tx of txs) upsertDecision({ transactionId: tx.id, categoryId: restaurant.id, source: 'user' });
  }

  // A cash withdrawal the bank export missed, corrected by hand. Dated on the
  // latest snapshot day: adjustments after the latest snapshot do not count.
  const checkingRows = demoCheckingRows(anchor);
  const lastCheckingDate = checkingRows[checkingRows.length - 1].date;
  createBalanceAdjustment({ accountId: checking, date: lastCheckingDate, amount: -40, reason: 'Käteisnosto, puuttui otteelta' });

  return { accountIds: { checking, savings }, importSessionIds };
}
