import './setup/testDb.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import xlsx from 'xlsx';

import { db } from '../src/db.js';
import { checksum, parseAmount, parseCsv, parseDate, parseXlsx, processImport } from '../src/importer.js';
import { resetDb } from './setup/resetDb.js';

// The same export downloaded as CSV and as XLSX holds the same transactions,
// so importing both stores each transaction once.

beforeEach(() => resetDb());

const OWN = 'FI00 1234 5600 0000 01';
const OTHER = 'FI00 1234 5600 0000 02';
const HEADER = ['Kirjauspäivä', 'Määrä', 'Maksaja', 'Maksunsaaja', 'Nimi', 'Otsikko', 'Viesti', 'Viitenumero', 'Saldo', 'Valuutta'];

// Fictional rows, newest first like Nordea: [day, amount, payer, payee, name, title, message, saldo].
const ROWS: Array<[string, number, string, string, string, string, string, number | null]> = [
  ['Varaus', -3.9, OWN, '', 'Kahvila Papu', 'Kahvila Papu', '', null],
  ['2026/10/14', -1234.5, OWN, OTHER, '', '', '', 765.5],
  ['2026/10/13', -12.5, OWN, '', 'Kauppa Esimerkki', 'Kauppa Esimerkki', '', 2000],
  ['2026/10/12', 2012.5, OTHER, OWN, 'Työnantaja Oy', 'Palkka', '20261012', 2012.5],
];

const csvAmount = (n: number) => n.toFixed(2).replace('.', ',');
function csvBuffer(): Buffer {
  const lines = [HEADER.join(';') + ';'];
  for (const [day, amount, payer, payee, name, title, message, saldo] of ROWS) {
    lines.push([day, csvAmount(amount), payer, payee, name, title, message, '', saldo === null ? '' : csvAmount(saldo), 'EUR'].join(';') + ';');
  }
  return Buffer.from('﻿' + lines.join('\n'), 'utf8');
}

/** An XLSX as a spreadsheet program saves it: real date and number cells, a header with a stray space. */
function xlsxBuffer(): Buffer {
  const header = HEADER.map((h) => (h === 'Maksunsaaja' ? 'Maksunsaaja ' : h));
  const aoa: unknown[][] = [header];
  for (const [day, amount, payer, payee, name, title, message, saldo] of ROWS) {
    const date = day === 'Varaus' ? day : new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
    aoa.push([date, amount, payer, payee, name, title, message ? Number(message) : '', '', saldo ?? '', 'EUR']);
  }
  const ws = xlsx.utils.aoa_to_sheet(aoa, { cellDates: true });
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Tapahtumat');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const importFile = (format: 'CSV' | 'XLSX') => {
  const buffer = format === 'CSV' ? csvBuffer() : xlsxBuffer();
  return processImport({
    records: format === 'CSV' ? parseCsv(buffer) : parseXlsx(buffer),
    checksum: checksum(buffer),
    filename: `Tapahtumat.${format.toLowerCase()}`,
    sourceBank: 'Nordea',
    format,
  });
};

type Stored = { day: string | null; amount: number; counterparty_name: string | null; counterparty_iban: string | null; description: string | null };
const stored = () =>
  db
    .prepare(
      `SELECT substr(booking_date, 1, 10) AS day, amount, counterparty_name, counterparty_iban, description
       FROM normalized_transactions ORDER BY booking_date IS NULL, booking_date, amount`
    )
    .all()
    .map((r) => ({ ...r })) as Stored[];

test('an XLSX row is read as the same transaction as its CSV row', () => {
  const fromCsv = parseCsv(csvBuffer());
  const fromXlsx = parseXlsx(xlsxBuffer());
  assert.equal(fromXlsx.length, fromCsv.length);
  for (let i = 0; i < ROWS.length; i++) {
    assert.equal(parseAmount(fromXlsx[i]['Määrä'] as never), parseAmount(fromCsv[i]['Määrä'] as never), `amount of row ${i}`);
    assert.equal(parseDate(fromXlsx[i]['Kirjauspäivä'] as never), parseDate(fromCsv[i]['Kirjauspäivä'] as never), `day of row ${i}`);
  }
});

for (const [first, second] of [['CSV', 'XLSX'], ['XLSX', 'CSV']] as const) {
  test(`${first} then ${second} of the same export stores every transaction once`, async () => {
    const a = await importFile(first);
    assert.equal(a.normalizedCount, ROWS.length);
    const afterFirst = stored();
    const b = await importFile(second);
    assert.equal(b.normalizedCount, 0, 'nothing new');
    assert.equal(b.duplicateCount, ROWS.length - 1, 'every booked row is already stored');
    assert.equal(b.pendingSeenCount, 1, 'the pending row too');
    assert.deepEqual(stored(), afterFirst);
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n), 1);
  });
}

test('both formats normalize to the same fields', async () => {
  await importFile('CSV');
  const fromCsv = stored();
  resetDb();
  await importFile('XLSX');
  assert.deepEqual(stored(), fromCsv);
  assert.deepEqual(
    fromCsv.map((r) => [r.day, r.amount]),
    [
      ['2026-10-12', 2012.5],
      ['2026-10-13', -12.5],
      ['2026-10-14', -1234.5],
      [null, -3.9],
    ]
  );
});

test('amount and date strings in other notations', () => {
  assert.equal(parseAmount('-12,50'), -12.5);
  assert.equal(parseAmount('-1.234,50'), -1234.5);
  assert.equal(parseAmount('1 234,56'), 1234.56);
  assert.equal(parseAmount('-12.50'), -12.5);
  assert.equal(parseAmount('-1,234.50'), -1234.5);
  assert.equal(parseAmount('−7,00'), -7);
  assert.equal(parseAmount(-12.5), -12.5);
  assert.equal(parseAmount(-12.499999999999998), -12.5);
  assert.equal(parseDate('2026/10/12'), '2026-10-12T00:00:00.000Z');
  assert.equal(parseDate('12.10.2026'), '2026-10-12T00:00:00.000Z');
  assert.equal(parseDate('2026-10-12 00:00:00'), '2026-10-12T00:00:00.000Z');
  assert.equal(parseDate(46307), '2026-10-12T00:00:00.000Z');
  assert.equal(parseDate(46307.75), '2026-10-12T00:00:00.000Z', 'a time of day is not part of the booking day');
  assert.equal(parseDate('Varaus'), null);
});
