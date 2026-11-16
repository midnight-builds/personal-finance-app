import './setup/testDb.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import { seedDemo } from '../src/demo/demoData.js';
import { checksum, dryRunImport, processImport, type ImportOptions } from '../src/importer.js';
import { resetDb } from './setup/resetDb.js';

// A transaction is stored once: a re-imported row that matches an existing
// one (same account, booking date, amount and counterparty) is not stored.

const ANCHOR = '2026-11-05';

beforeEach(() => resetDb());

function perDay(counterparty: string) {
  return db
    .prepare(
      `SELECT substr(booking_date, 1, 10) AS day, COUNT(*) AS n FROM normalized_transactions
       WHERE counterparty_name = ? GROUP BY day ORDER BY day`
    )
    .all(counterparty)
    .map((r) => ({ ...r })) as Array<{ day: string; n: number }>;
}

const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

const rec = (counterparty: string | null, amount = '-4,50') => ({
  Kirjauspäivä: '2026/10/12', Määrä: amount, Maksaja: '', Maksunsaaja: counterparty ?? '',
  Nimi: counterparty ?? '', Otsikko: '', Viesti: '', Valuutta: 'EUR',
});
const options = (records: Record<string, unknown>[], name: string): ImportOptions => ({
  records, checksum: checksum(Buffer.from(name)), filename: name,
  accountName: 'Käyttötili', accountIban: 'FI00 1234 5600 0000 01', sourceBank: 'nordea', format: 'csv',
});
const run = (records: Record<string, unknown>[], name: string) => processImport(options(records, name));

test('identical rows within one import are two transactions', async () => {
  await seedDemo(ANCHOR);
  // Two same-day coffees every month, October also in the second export.
  const days = perDay('Kahvila Papu');
  assert.ok(days.length >= 5);
  assert.ok(days.every((d) => d.n === 2), JSON.stringify(days));
});

test('the overlapping month is stored once', async () => {
  await seedDemo(ANCHOR);
  const rent = perDay('Asunto Oy Demokatu');
  assert.ok(rent.length >= 6);
  assert.ok(rent.every((d) => d.n === 1), JSON.stringify(rent));
  assert.equal(count('raw_transactions'), count('normalized_transactions'), 'no raw row without its transaction');
});

test('re-imported rows pair one-to-one with stored ones', async () => {
  const first = await run([rec('Kahvila Papu')], 'a.csv'); // first export cut after one coffee
  assert.equal(first.duplicateCount, 0);
  const second = await run([rec('Kahvila Papu'), rec('Kahvila Papu')], 'b.csv'); // second export has both
  assert.equal(second.duplicateCount, 1);
  assert.equal(second.normalizedCount, 1);
  assert.equal(count('normalized_transactions'), 2);
  // Three in the file, two stored: one is new.
  const third = await run([rec('Kahvila Papu'), rec('Kahvila Papu'), rec('Kahvila Papu')], 'c.csv');
  assert.equal(third.duplicateCount, 2);
  assert.equal(third.normalizedCount, 1);
  assert.equal(count('normalized_transactions'), 3);
  assert.equal(count('import_sessions'), 3);
});

test('a missing counterparty matches a missing counterparty only', async () => {
  await run([rec(null)], 'a.csv');
  const again = await run([rec(null), rec('Kahvila Papu')], 'b.csv');
  assert.equal(again.duplicateCount, 1);
  assert.equal(again.normalizedCount, 1);
  assert.equal(count('normalized_transactions'), 2);
});

test('another amount, day or account is another transaction', async () => {
  await run([rec('Kahvila Papu')], 'a.csv');
  const other = await run([rec('Kahvila Papu', '-4,60'), { ...rec('Kahvila Papu'), Kirjauspäivä: '2026/10/13' }], 'b.csv');
  assert.equal(other.duplicateCount, 0);
  const elsewhere = await processImport({ ...options([rec('Kahvila Papu')], 'c.csv'), accountName: 'Toinen', accountIban: 'FI00 1234 5600 0000 09' });
  assert.equal(elsewhere.duplicateCount, 0);
  assert.equal(count('normalized_transactions'), 4);
});

test('the dry run reports exactly what the import does, and writes nothing', async () => {
  await run([rec('Kahvila Papu'), { ...rec('Kahvila Papu'), Kirjauspäivä: '2026/10/14' }], 'a.csv');
  const records = [rec('Kahvila Papu'), rec('Kahvila Papu'), { ...rec('Kahvila Papu'), Kirjauspäivä: '2026/10/14' }, { ...rec('Kahvila Papu'), Kirjauspäivä: '2026/10/20' }];
  const before = [count('normalized_transactions'), count('raw_transactions'), count('import_sessions')];
  const dry = dryRunImport(options(records, 'b.csv'));
  assert.deepEqual([count('normalized_transactions'), count('raw_transactions'), count('import_sessions')], before);
  assert.equal(dry.duplicateCount, 2);
  assert.deepEqual(dry.overlap, { from: '2026-10-12', to: '2026-10-14' });
  assert.equal(dry.normalizedCount, 2);
  const real = await run(records, 'b.csv');
  assert.equal(real.duplicateCount, dry.duplicateCount);
  assert.equal(real.normalizedCount, dry.normalizedCount);
  assert.equal(count('normalized_transactions'), 4);
});
