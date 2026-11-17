import './setup/testDb.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { db, initDb } from '../src/db.js';
import { checksum, dryRunImport, processImport, type ImportOptions } from '../src/importer.js';
import { ledgerEntries } from '../src/ledger.js';
import { listTransactions } from '../src/query.js';
import { appendDecision } from '../src/rules.js';
import { resetDb } from './setup/resetDb.js';

// A pending row ("Varaus") is one transaction through its whole life: seen
// again it is not stored again, booked it is promoted in place (same id), and
// dropped from a newer export without being booked it is void.

beforeEach(() => resetDb());

const IBAN = 'FI00 1234 5600 0000 01';

type Row = Record<string, unknown>;
/** A file row: `day` is YYYY/MM/DD, or 'Varaus' for a pending row. */
const rec = (day: string, counterparty: string | null, amount = '-4,50', message = ''): Row => ({
  Kirjauspäivä: day, Määrä: amount, Maksaja: '', Maksunsaaja: '',
  Nimi: counterparty ?? '', Otsikko: counterparty ?? '', Viesti: message, Valuutta: 'EUR',
});
const pending = (counterparty: string | null, amount?: string) => rec('Varaus', counterparty, amount);

let seq = 0;
const options = (records: Row[]): ImportOptions => {
  seq += 1;
  return {
    records, checksum: checksum(Buffer.from(`file-${seq}`)), filename: `export-${seq}.csv`,
    accountName: 'Käyttötili', accountIban: IBAN, sourceBank: 'nordea', format: 'csv',
  };
};
const run = (records: Row[]) => processImport(options(records));

const count = (sql: string, ...params: Array<string | number>) =>
  Number((db.prepare(sql).get(...params) as { n: number }).n);
const txCount = () => count('SELECT COUNT(*) AS n FROM normalized_transactions');

type Tx = { id: string; booking_date: string | null; raw_transaction_id: string; status: string | null; description: string | null };
function rowsOf(counterparty: string): Tx[] {
  return db
    .prepare(
      `SELECT t.id, t.booking_date, t.raw_transaction_id, t.description, p.status
       FROM normalized_transactions t LEFT JOIN pending_transactions p ON p.transaction_id = t.id
       WHERE t.counterparty_name = ? ORDER BY t.booking_date IS NULL, t.booking_date, t.rowid`
    )
    .all(counterparty)
    .map((r) => ({ ...r })) as Tx[];
}

// A background of booked rows so a file covers a period like a real export.
const filler = (from: number, to: number) => {
  const out: Row[] = [];
  for (let d = to; d >= from; d--) out.push(rec(`2026/10/${String(d).padStart(2, '0')}`, `Kauppa ${d}`, '-1,00'));
  return out;
};

test('re-importing a still-pending row does not add a row', async () => {
  const first = await run([pending('Kahvila Papu'), ...filler(1, 10)]);
  assert.equal(first.normalizedCount, 11);
  const again = await run([pending('Kahvila Papu'), ...filler(1, 11)]);
  assert.equal(again.normalizedCount, 1, 'only the new booked day');
  assert.equal(again.pendingSeenCount, 1);
  assert.equal(rowsOf('Kahvila Papu').length, 1);
  assert.equal(rowsOf('Kahvila Papu')[0].status, 'pending');
  // Rows within one file are separate: two pending coffees are two rows.
  await run([pending('Kahvila Papu'), pending('Kahvila Papu'), ...filler(1, 11)]);
  assert.equal(rowsOf('Kahvila Papu').length, 2);
});

test('the booked version promotes the pending row in place', async () => {
  await run([pending('Kahvila Papu'), ...filler(1, 10)]);
  const [p] = rowsOf('Kahvila Papu');
  const category = (db.prepare(`SELECT id FROM categories WHERE name = 'Viihde ja harrastukset'`).get() as { id: string }).id;
  appendDecision({ transactionId: p.id, categoryId: category, source: 'user', actor: 'user' });

  const result = await run([rec('2026/10/12', 'Kahvila Papu', '-4,50', 'booked text'), ...filler(1, 12)]);
  assert.equal(result.bookedPendingCount, 1);
  assert.equal(result.duplicateCount, 10);
  assert.equal(result.normalizedCount, 2, 'filler days 11 and 12 only');

  const rows = rowsOf('Kahvila Papu');
  assert.equal(rows.length, 1, 'no second transaction next to the pending one');
  assert.equal(rows[0].id, p.id, 'same id');
  assert.equal(rows[0].booking_date?.slice(0, 10), '2026-10-12');
  assert.equal(rows[0].status, 'booked');
  assert.equal(rows[0].description, 'booked text');
  // Audit trail: the booked raw row is linked, the pending raw row is kept.
  assert.notEqual(rows[0].raw_transaction_id, p.raw_transaction_id);
  assert.equal(count('SELECT COUNT(*) AS n FROM raw_transactions WHERE id IN (?, ?)', p.raw_transaction_id, rows[0].raw_transaction_id), 2);
  const side = db.prepare('SELECT pending_raw_transaction_id AS r FROM pending_transactions WHERE transaction_id = ?').get(p.id) as { r: string };
  assert.equal(side.r, p.raw_transaction_id);
  // The manual category survives and the Ledger counts it once.
  const entries = ledgerEntries().filter((e) => e.counterparty === 'Kahvila Papu');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].categoryId, category);

  // Importing the same booked export again stores nothing more.
  const again = await run([rec('2026/10/12', 'Kahvila Papu', '-4,50', 'booked text'), ...filler(1, 12)]);
  assert.equal(again.normalizedCount, 0);
  assert.equal(again.bookedPendingCount, 0);
  assert.equal(again.duplicateCount, 13);
});

const latestCategory = (id: string) =>
  (db.prepare('SELECT category_id AS c, source FROM categorization_decisions WHERE transaction_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(id) as { c: string; source: string });
const categoryNamed = (name: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string }).id;

test('a booking is categorized again from its booked text, unless the user chose', async () => {
  await run([pending('Kortti 1234'), pending('Kortti 5678'), ...filler(1, 10)]);
  const [auto] = rowsOf('Kortti 1234');
  const [manual] = rowsOf('Kortti 5678');
  const leisure = categoryNamed('Viihde ja harrastukset');
  appendDecision({ transactionId: manual.id, categoryId: leisure, source: 'user', actor: 'user' });
  // The booked rows name the shop in their text: a built-in rule knows it.
  await run([
    rec('2026/10/11', 'Kortti 1234', '-4,50', 'K-Market Esimerkki'),
    rec('2026/10/11', 'Kortti 5678', '-4,50', 'K-Market Esimerkki'),
    ...filler(1, 11),
  ]);
  assert.equal(latestCategory(auto.id).c, categoryNamed('Ruoka ja päivittäistavarat'));
  assert.equal(latestCategory(manual.id).c, leisure, 'manual beats rule');
});

test('an older export imported again after the booking adds no pending row', async () => {
  const older = [pending('Kahvila Papu'), ...filler(1, 10)];
  await run(older);
  await run([rec('2026/10/12', 'Kahvila Papu'), ...filler(1, 12)]);
  const again = await run(older);
  assert.equal(again.normalizedCount, 0);
  assert.equal(again.pendingSeenCount, 1);
  assert.deepEqual(rowsOf('Kahvila Papu').map((x) => x.status), ['booked']);
  // A newer export listing such a reservation is another one.
  const newer = await run([pending('Kahvila Papu'), ...filler(1, 13)]);
  assert.equal(newer.normalizedCount, 2);
});

test('a file of reservations only is dated by the account, so a later export books them', async () => {
  await run(filler(1, 10));
  await run([pending('Kahvila Papu')]);
  const r = await run([rec('2026/10/11', 'Kahvila Papu'), ...filler(1, 11)]);
  assert.equal(r.bookedPendingCount, 1);
  assert.deepEqual(rowsOf('Kahvila Papu').map((x) => x.status), ['booked']);
});

test('one of two identical pending rows booked: one booked, one still pending', async () => {
  await run([pending('Kahvila Papu'), pending('Kahvila Papu'), ...filler(1, 10)]);
  const r = await run([pending('Kahvila Papu'), rec('2026/10/11', 'Kahvila Papu'), ...filler(1, 11)]);
  assert.equal(r.pendingSeenCount, 1);
  assert.equal(r.bookedPendingCount, 1);
  const rows = rowsOf('Kahvila Papu');
  assert.deepEqual(rows.map((x) => x.status), ['booked', 'pending']);
  assert.equal(txCount(), 2 + 11);
});

test('a booked row the account already has is a duplicate, not a promotion', async () => {
  await run([rec('2026/10/10', 'Kahvila Papu'), ...filler(1, 9)]);
  await run([pending('Kahvila Papu'), rec('2026/10/10', 'Kahvila Papu'), ...filler(1, 9)]); // second coffee, pending
  const r = await run([rec('2026/10/10', 'Kahvila Papu'), rec('2026/10/11', 'Kahvila Papu'), ...filler(1, 11)]);
  assert.equal(r.bookedPendingCount, 1, 'the new day promotes the pending coffee');
  assert.equal(rowsOf('Kahvila Papu').length, 2);
  assert.ok(rowsOf('Kahvila Papu').every((x) => x.booking_date !== null));
});

test('another amount or counterparty does not promote; the pending row goes void instead', async () => {
  await run([pending('Huoltoasema', '-50,00'), ...filler(1, 10)]);
  // The station books less than it reserved; the reservation is gone from the newer export.
  const r = await run([rec('2026/10/11', 'Huoltoasema', '-43,20'), ...filler(1, 11)]);
  assert.equal(r.bookedPendingCount, 0);
  assert.equal(r.voidedPendingCount, 1);
  const rows = rowsOf('Huoltoasema');
  assert.deepEqual(rows.map((x) => x.status), [null, 'void']);
  // Void rows stay stored but count nowhere and are not listed.
  assert.equal(ledgerEntries().filter((e) => e.counterparty === 'Huoltoasema').length, 1);
  assert.equal(listTransactions().filter((t) => t.counterpartyName === 'Huoltoasema').length, 1);
});

test('a pending row dropped from a newer export of the same period is void, not deleted', async () => {
  await run([pending('Hotelli'), ...filler(1, 10)]);
  const r = await run(filler(1, 12));
  assert.equal(r.voidedPendingCount, 1);
  assert.equal(rowsOf('Hotelli')[0].status, 'void');
  assert.equal(listTransactions().filter((t) => t.counterpartyName === 'Hotelli').length, 0);
  // Seen pending again in a later export: it is pending again, still one row.
  await run([pending('Hotelli'), ...filler(1, 13)]);
  assert.deepEqual(rowsOf('Hotelli').map((x) => x.status), ['pending']);
  // And then booked: promoted.
  const booked = await run([rec('2026/10/14', 'Hotelli'), ...filler(1, 14)]);
  assert.equal(booked.bookedPendingCount, 1);
  assert.deepEqual(rowsOf('Hotelli').map((x) => x.status), ['booked']);
});

test('an older or shorter export does not void a pending row', async () => {
  await run([pending('Hotelli'), ...filler(1, 10)]);
  const older = await run(filler(1, 8)); // ends before the pending row was seen
  assert.equal(older.voidedPendingCount, 0);
  const shorter = await run(filler(9, 12)); // newer, but does not reach back to when it was seen
  assert.equal(shorter.voidedPendingCount, 0);
  assert.equal(rowsOf('Hotelli')[0].status, 'pending');
});

test('a booked row long after the reservation was last seen is another transaction', async () => {
  await run([pending('Kahvila Papu'), ...filler(1, 3)]);
  // Same coffee price, but booked weeks after the last export that listed the reservation.
  const r = await run([rec('2026/11/20', 'Kahvila Papu'), rec('2026/11/19', 'Kauppa x', '-1,00')]);
  assert.equal(r.bookedPendingCount, 0);
  assert.equal(rowsOf('Kahvila Papu').length, 2);
  // Nor is a booked row dated well before the export that first listed it.
  await run([pending('Leipomo'), ...filler(1, 20)]);
  const early = await run([rec('2026/10/02', 'Leipomo'), ...filler(1, 21)]);
  assert.equal(early.bookedPendingCount, 0);
});

test('several candidates: the oldest reservation is booked first, deterministically', async () => {
  await run([pending('Kahvila Papu'), ...filler(1, 5)]);
  await run([pending('Kahvila Papu'), pending('Kahvila Papu'), ...filler(1, 7)]);
  const [older] = rowsOf('Kahvila Papu');
  const ids = rowsOf('Kahvila Papu').map((x) => x.id);
  assert.equal(ids.length, 2);
  await run([pending('Kahvila Papu'), rec('2026/10/08', 'Kahvila Papu'), ...filler(1, 8)]);
  const rows = rowsOf('Kahvila Papu');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, older.id, 'the first-seen reservation took the booking');
  assert.deepEqual(rows.map((x) => x.status), ['booked', 'pending']);
});

test('two bookings and two reservations pair in day order', async () => {
  await run([pending('Kahvila Papu'), ...filler(1, 5)]);
  await run([pending('Kahvila Papu'), pending('Kahvila Papu'), ...filler(1, 9)]);
  const ids = rowsOf('Kahvila Papu').map((x) => x.id);
  const r = await run([rec('2026/10/11', 'Kahvila Papu'), rec('2026/10/10', 'Kahvila Papu'), ...filler(1, 11)]);
  assert.equal(r.bookedPendingCount, 2);
  const rows = rowsOf('Kahvila Papu');
  assert.deepEqual(rows.map((x) => x.id).sort(), [...ids].sort());
  assert.equal(rows.length, 2);
});

test('the dry run reports exactly what the import does', async () => {
  await run([pending('Kahvila Papu'), pending('Hotelli'), pending('Leipomo'), ...filler(1, 10)]);
  const records = [pending('Leipomo'), rec('2026/10/11', 'Kahvila Papu'), ...filler(1, 11)];
  const before = [txCount(), count('SELECT COUNT(*) AS n FROM pending_transactions WHERE status = ?', 'pending')];
  const dry = dryRunImport(options(records));
  assert.deepEqual([txCount(), count('SELECT COUNT(*) AS n FROM pending_transactions WHERE status = ?', 'pending')], before);
  const real = await run(records);
  for (const key of ['normalizedCount', 'duplicateCount', 'pendingSeenCount', 'bookedPendingCount', 'voidedPendingCount'] as const) {
    assert.equal(real[key], dry[key], key);
  }
  assert.deepEqual([real.pendingSeenCount, real.bookedPendingCount, real.voidedPendingCount], [1, 1, 1]);
});

test('pending rows stored before the lifecycle existed are picked up at start', async () => {
  await run([pending('Kahvila Papu'), pending('Kahvila Papu'), ...filler(1, 10)]);
  await run([pending('Kahvila Papu'), ...filler(1, 10)]); // stores nothing new
  // Simulate an older database: the copies a re-import used to store, no lifecycle rows.
  const session = (db.prepare('SELECT import_session_id AS s FROM normalized_transactions WHERE booking_date IS NULL LIMIT 1').get() as { s: string }).s;
  db.prepare(
    `INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name)
     SELECT 'legacy-copy', created_at, NULL, import_session_id, account_id, NULL, NULL, amount, currency, counterparty_name
     FROM normalized_transactions WHERE booking_date IS NULL LIMIT 1`
  ).run();
  db.exec('DELETE FROM pending_transactions');
  initDb();
  initDb();
  assert.equal(count('SELECT COUNT(*) AS n FROM pending_transactions'), 3);
  const legacy = db.prepare('SELECT first_seen_day AS d, first_seen_session_id AS s FROM pending_transactions WHERE transaction_id = ?').get('legacy-copy') as { d: string; s: string };
  assert.equal(legacy.s, session);
  assert.equal(legacy.d, '2026-10-10', 'the latest booked day of its import');
  // The next current export pairs the reservations one-to-one; the extra copy goes void.
  const r = await run([pending('Kahvila Papu'), pending('Kahvila Papu'), ...filler(1, 11)]);
  assert.equal(r.pendingSeenCount, 2);
  assert.equal(r.voidedPendingCount, 1);
  assert.equal(listTransactions().filter((t) => t.counterpartyName === 'Kahvila Papu').length, 2);
});
