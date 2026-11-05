import './setup/testDb.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import { seedDemo } from '../src/demo/demoData.js';
import { checksum, processImport } from '../src/importer.js';
import { resetDb } from './setup/resetDb.js';

const ANCHOR = '2026-11-05';

beforeEach(() => resetDb());

function grouped(counterparty: string) {
  return db
    .prepare(
      `SELECT booking_date, transaction_group_id FROM normalized_transactions
       WHERE counterparty_name = ? AND transaction_group_id IS NOT NULL`
    )
    .all(counterparty) as Array<{ booking_date: string; transaction_group_id: string }>;
}

test('identical rows within one import are not duplicates', async () => {
  await seedDemo(ANCHOR);
  // Two same-day coffees every month; only October arrives in both exports.
  const rows = grouped('Kahvila Papu');
  assert.ok(rows.every((r) => r.booking_date.startsWith('2026-10-')), JSON.stringify(rows));
});

test('the overlapping month is grouped across imports', async () => {
  await seedDemo(ANCHOR);
  const rent = grouped('Asunto Oy Demokatu');
  assert.equal(rent.length, 2);
  assert.equal(rent[0].transaction_group_id, rent[1].transaction_group_id);
});

test('duplicates pair one-to-one with earlier rows', async () => {
  const rec = (n: number) => ({
    Kirjauspäivä: '2026/10/12', Määrä: '-4,50', Maksaja: '', Maksunsaaja: 'Kahvila Papu',
    Nimi: 'Kahvila Papu', Otsikko: '', Viesti: '', Saldo: String(100 - n * 4.5).replace('.', ','), Valuutta: 'EUR',
  });
  const run = (records: Record<string, unknown>[], name: string) =>
    processImport({
      records, checksum: checksum(Buffer.from(name)), filename: name,
      accountName: 'Käyttötili', accountIban: 'FI00 1234 5600 0000 01', sourceBank: 'nordea', format: 'csv',
    });
  await run([rec(1)], 'a.csv'); // first export cut after one coffee
  await run([rec(1), rec(2)], 'b.csv'); // second export has both
  const groups = db
    .prepare(`SELECT transaction_group_id g, COUNT(*) n FROM normalized_transactions GROUP BY transaction_group_id`)
    .all() as Array<{ g: string | null; n: number }>;
  // One pair (a1, b1) and the second coffee on its own: two purchases in total.
  assert.deepEqual(groups.map((r) => r.n).sort(), [1, 2]);
});
