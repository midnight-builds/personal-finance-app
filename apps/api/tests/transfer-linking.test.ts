import './setup/testDb.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { db } from '../src/db.js';
import { checksum, processImport } from '../src/importer.js';
import { ledgerEntries } from '../src/ledger.js';
import { resetDb } from './setup/resetDb.js';

// Nordea-style rows: the other party is an IBAN on a transfer between
// accounts, a merchant's name on a card payment.
const CHECKING = 'FI11 1111 1111 1111 11';
const SAVINGS = 'FI22 2222 2222 2222 22';
const CARD = 'FI33 3333 3333 3333 33';
const FRIEND = 'FI44 4444 4444 4444 44';

type Row = { date: string; amount: number; other: string; name?: string };
const record = (r: Row) => ({
  Kirjauspäivä: r.date.replace(/-/g, '/'),
  Määrä: r.amount.toFixed(2).replace('.', ','),
  Maksaja: r.amount > 0 ? r.other : '',
  Maksunsaaja: r.amount < 0 ? r.other : '',
  Nimi: r.name ?? '',
  Otsikko: '',
  Viesti: '',
  Saldo: '',
  Valuutta: 'EUR',
});

let n = 0;
function importRows(accountIban: string, rows: Row[]) {
  const records = rows.map(record);
  return processImport({
    records,
    checksum: checksum(Buffer.from(`${n++}${JSON.stringify(records)}`)),
    filename: 'x.csv',
    accountName: accountIban,
    accountIban,
    sourceBank: 'nordea',
    format: 'csv',
  });
}

const links = () =>
  db.prepare('SELECT from_transaction_id AS f, to_transaction_id AS t, confidence FROM transfer_links').all() as Array<{
    f: string;
    t: string;
    confidence: number;
  }>;
const transfers = () => ledgerEntries({ includeTransfers: true }).filter((e) => e.isTransfer);

beforeEach(() => resetDb());

test('a transfer naming the other account by IBAN is linked', async () => {
  await importRows(CHECKING, [{ date: '2026-10-16', amount: -300, other: SAVINGS, name: 'Oma säästötili' }]);
  await importRows(SAVINGS, [{ date: '2026-10-16', amount: 300, other: CHECKING, name: 'Oma käyttötili' }]);
  assert.equal(links().length, 1);
  assert.equal(links()[0].confidence, 95);
  assert.equal(transfers().length, 2);
});

test('a card purchase and a refund of the same amount are not a transfer', async () => {
  // The checking export carries IBANs on its transfers, so a row without one is a card payment.
  await importRows(CHECKING, [
    { date: '2026-10-01', amount: -950, other: FRIEND, name: 'Vuokranantaja' },
    { date: '2026-10-10', amount: -20, other: 'Kauppa Oy', name: 'Kauppa Oy' },
  ]);
  // Both the card that has an IBAN and a real card export that has none.
  await importRows(CARD, [{ date: '2026-10-11', amount: 20, other: 'Kauppa Oy', name: 'Kauppa Oy' }]);
  await upload('Luottokortti.csv', [{ date: '2026-10-11', amount: 20, other: 'Kauppa Oy', name: 'Kauppa Oy' }]);
  assert.deepEqual(links(), []);
  assert.equal(ledgerEntries().filter((e) => e.counterparty === 'Kauppa Oy').length, 3);
});

test('a card purchase paid back by a friend is not a transfer', async () => {
  await importRows(CHECKING, [{ date: '2026-10-10', amount: 40, other: FRIEND, name: 'Kaveri' }]);
  await upload('Luottokortti.csv', [{ date: '2026-10-10', amount: -40, other: 'Ravintola', name: 'Ravintola' }]);
  assert.deepEqual(links(), []);
});

test('an IBAN in the file name stops at the IBAN', async () => {
  const res = await upload(`Tapahtumat ${SAVINGS} 2026 10.csv`, [{ date: '2026-10-01', amount: 5, other: 'Korko', name: 'Korko' }]);
  assert.equal(accountOf(res).iban, SAVINGS.replace(/\s+/g, ''));
});

test('an IBAN pointing elsewhere rules a pair out', async () => {
  await importRows(CHECKING, [{ date: '2026-10-05', amount: -300, other: FRIEND, name: 'Kaveri' }]);
  await importRows(SAVINGS, [{ date: '2026-10-05', amount: 300, other: 'FI55 5555 5555 5555 55', name: 'Mummo' }]);
  assert.deepEqual(links(), []);
});

test('each transaction is in at most one transfer', async () => {
  await importRows(CHECKING, [
    { date: '2026-10-16', amount: -100, other: SAVINGS, name: 'Oma säästötili' },
    { date: '2026-10-16', amount: -100, other: SAVINGS, name: 'Oma säästötili' },
  ]);
  await importRows(SAVINGS, [
    { date: '2026-10-16', amount: 100, other: CHECKING, name: 'Oma käyttötili' },
    { date: '2026-10-17', amount: 100, other: CHECKING, name: 'Oma käyttötili' },
    { date: '2026-10-17', amount: 100, other: CHECKING, name: 'Oma käyttötili' },
  ]);
  const ids = links().flatMap((l) => [l.f, l.t]);
  assert.equal(links().length, 2);
  assert.equal(new Set(ids).size, ids.length);
  // The third deposit has no partner left and stays income.
  assert.equal(ledgerEntries().filter((e) => e.amount === 100).length, 1);
});

test('the closest day wins', async () => {
  await importRows(SAVINGS, [
    { date: '2026-10-14', amount: 50, other: CHECKING },
    { date: '2026-10-16', amount: 50, other: CHECKING },
  ]);
  await importRows(CHECKING, [{ date: '2026-10-16', amount: -50, other: SAVINGS }]);
  const [link] = links();
  const day = (id: string) => (db.prepare('SELECT booking_date AS d FROM normalized_transactions WHERE id = ?').get(id) as { d: string }).d;
  assert.equal(day(link.t).slice(0, 10), '2026-10-16');
});

test('without IBANs, a tie between two accounts is left unlinked', async () => {
  // Two accounts received 50 € the same day; which one the withdrawal went to is a guess.
  await importRows('FI77 7777 7777 7777 77', [{ date: '2026-10-16', amount: 50, other: 'Siirto', name: 'Siirto' }]);
  await importRows('FI88 8888 8888 8888 88', [{ date: '2026-10-16', amount: 50, other: 'Siirto', name: 'Siirto' }]);
  await importRows('FI66 6666 6666 6666 66', [{ date: '2026-10-16', amount: -50, other: 'Siirto', name: 'Siirto' }]);
  assert.deepEqual(links(), []);
});

test('without IBANs anywhere, a unique opposite amount is a transfer', async () => {
  await importRows('FI66 6666 6666 6666 66', [{ date: '2026-10-16', amount: -50, other: 'Oma tili', name: 'Oma tili' }]);
  await importRows('FI77 7777 7777 7777 77', [{ date: '2026-10-17', amount: 50, other: 'Oma tili', name: 'Oma tili' }]);
  assert.equal(links().length, 1);
  assert.equal(links()[0].confidence, 70);
});

test('an overlapping export does not link the duplicate copy again', async () => {
  const out = { date: '2026-10-16', amount: -300, other: SAVINGS, name: 'Oma säästötili' };
  await importRows(CHECKING, [out]);
  await importRows(SAVINGS, [{ date: '2026-10-16', amount: 300, other: CHECKING, name: 'Oma käyttötili' }]);
  await importRows(CHECKING, [out, { date: '2026-10-20', amount: -12, other: 'Kahvila', name: 'Kahvila' }]);
  assert.equal(links().length, 1);
  // Both copies of the withdrawal are transfers; the purchase is spending.
  assert.equal(transfers().length, 2);
  assert.equal(ledgerEntries().length, 1);
});

test('a failed import leaves nothing behind', async () => {
  await importRows(SAVINGS, [{ date: '2026-10-16', amount: 300, other: CHECKING }]);
  const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  const before = ['accounts', 'import_sessions', 'raw_transactions', 'normalized_transactions'].map(count);
  // Fail at the very last step, transfer linking.
  db.exec(`CREATE TEMP TRIGGER fail_link BEFORE INSERT ON transfer_links BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  try {
    await assert.rejects(importRows(CHECKING, [{ date: '2026-10-16', amount: -300, other: SAVINGS }]), /boom/);
  } finally {
    db.exec('DROP TRIGGER fail_link');
  }
  assert.deepEqual(['accounts', 'import_sessions', 'raw_transactions', 'normalized_transactions'].map(count), before);
});

// Uploads name no account: the importer infers it from the file, as the routes do.
function upload(filename: string, rows: Array<Row & { own?: string }>) {
  const records = rows.map((r) => ({
    ...record(r),
    // A real export fills the account's own side too: payer when paying, payee when paid.
    ...(r.own ? (r.amount < 0 ? { Maksaja: r.own } : { Maksunsaaja: r.own }) : {}),
  }));
  return processImport({
    records,
    checksum: checksum(Buffer.from(`${n++}${JSON.stringify(records)}`)),
    filename,
    sourceBank: 'nordea',
    format: 'csv',
  });
}
const accountOf = (importResult: { accountId: string }) =>
  db.prepare('SELECT name, iban FROM accounts WHERE id = ?').get(importResult.accountId) as { name: string; iban: string | null };

test('a credit card repayment from checking is a transfer', async () => {
  // Checking carries IBANs; the card export has none and its account no IBAN.
  await importRows(CHECKING, [
    { date: '2026-10-01', amount: -950, other: FRIEND, name: 'Vuokranantaja' },
    { date: '2026-10-20', amount: -500, other: 'FI99 9999 9999 9999 99', name: 'Nordea Rahoitus' },
  ]);
  await upload('Luottokortti.csv', [{ date: '2026-10-21', amount: 500, other: '', name: 'Maksu, kiitos' }]);
  assert.equal(links().length, 1);
  assert.equal(links()[0].confidence, 70);
});

test('a savings export fed only from checking is filed under savings', async () => {
  // Every row names both accounts once: only the own side tells which file this is.
  const savings = await upload('Tapahtumat.csv', [
    { date: '2026-10-16', amount: 100, other: CHECKING, own: SAVINGS },
    { date: '2026-09-16', amount: 100, other: CHECKING, own: SAVINGS },
    { date: '2026-09-20', amount: -30, other: CHECKING, own: SAVINGS },
  ]);
  assert.equal(accountOf(savings).iban, SAVINGS.replace(/\s+/g, ''));
  const checking = await upload('Tapahtumat.csv', [
    { date: '2026-10-16', amount: -100, other: SAVINGS, own: CHECKING },
    { date: '2026-09-16', amount: -100, other: SAVINGS, own: CHECKING },
    { date: '2026-09-20', amount: 30, other: SAVINGS, own: CHECKING },
  ]);
  assert.equal(accountOf(checking).iban, CHECKING.replace(/\s+/g, ''));
  assert.equal(links().length, 3);
  assert.deepEqual(ledgerEntries(), []);
});

test('an export finds its account whether or not the IBAN has spaces', async () => {
  const first = await importRows(CHECKING, [{ date: '2026-10-01', amount: -10, other: 'Kauppa', name: 'Kauppa' }]);
  const second = await upload('Tapahtumat.csv', [{ date: '2026-10-02', amount: -10, other: 'Kauppa', name: 'Kauppa', own: CHECKING }]);
  assert.equal(second.accountId, first.accountId);
});

test('the account name comes from the file name before the IBAN', async () => {
  const res = await upload(`Käyttötili ${CHECKING}.csv`, [{ date: '2026-10-01', amount: -10, other: 'Kauppa', name: 'Kauppa' }]);
  assert.deepEqual({ ...accountOf(res) }, { name: 'Käyttötili', iban: CHECKING.replace(/\s+/g, '') });
});
