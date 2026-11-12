import './setup/testDb.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { checksum, processImport } from '../src/importer.js';
import { accountBalances } from '../src/ledger.js';
import { resetDb } from './setup/resetDb.js';

beforeEach(() => resetDb());

const row = (date: string, amount: string, saldo: string) => ({
  Kirjauspäivä: date, Määrä: amount, Maksaja: '', Maksunsaaja: 'Kauppa', Nimi: 'Kauppa',
  Otsikko: '', Viesti: '', Saldo: saldo, Valuutta: 'EUR',
});

function run(records: Record<string, unknown>[]) {
  return processImport({
    records, checksum: checksum(Buffer.from(JSON.stringify(records))), filename: 'x.csv',
    accountName: 'Käyttötili', accountIban: 'FI00 1234 5600 0000 01', sourceBank: 'nordea', format: 'csv',
  });
}

test("a newest-first export keeps the day's closing balance", async () => {
  // Nordea order: the day's latest purchase comes first.
  await run([
    row('2026/10/12', '-4,50', '91,00'),
    row('2026/10/12', '-4,50', '95,50'),
    row('2026/10/11', '-10,00', '100,00'),
  ]);
  assert.equal(accountBalances('2026-10-12')[0].balance, 91);
  assert.equal(accountBalances('2026-10-11')[0].balance, 100);
});

test("an oldest-first export keeps the day's closing balance", async () => {
  await run([
    row('2026/10/11', '-10,00', '100,00'),
    row('2026/10/12', '-4,50', '95,50'),
    row('2026/10/12', '-4,50', '91,00'),
  ]);
  assert.equal(accountBalances('2026-10-12')[0].balance, 91);
});

test('a day with a row missing its Saldo keeps the file-order closing balance', async () => {
  // Review case: without the blank row, the chain would wrongly end at 85.
  await run([
    row('2026/10/12', '-5,00', '100,00'),
    row('2026/10/12', '20,00', ''),
    row('2026/10/12', '-15,00', '85,00'),
    row('2026/10/11', '-10,00', '100,00'),
  ]);
  assert.equal(accountBalances('2026-10-12')[0].balance, 100);
});
