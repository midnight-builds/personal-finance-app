import './setup/testDb.js';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { ImportPreview } from '@finance-app/shared';

import { db } from '../src/db.js';
import { DEMO_CHECKING_IBAN, DEMO_SAVINGS_IBAN, demoExports } from '../src/demo/demoData.js';
import { checksum, processImport } from '../src/importer.js';
import { balanceBreaks, bookedRowsInTimeOrder, quietPeriods } from '../src/importPreview.js';
import { ledgerEntries } from '../src/ledger.js';
import { routes } from '../src/routes/index.js';
import { resetDb } from './setup/resetDb.js';

const app = Fastify();
await app.register(routes);
after(() => app.close());

beforeEach(() => resetDb());

const ANCHOR = '2026-11-05';
const CHECKING = 'FI11 1111 1111 1111 11';
const OTHER = 'FI99 9999 9999 9999 99';
const COLUMNS = ['Kirjauspäivä', 'Määrä', 'Maksaja', 'Maksunsaaja', 'Nimi', 'Otsikko', 'Viesti', 'Viitenumero', 'Saldo', 'Valuutta'];

type Row = { date: string; amount: number; name: string };
const fmt = (n: number) => n.toFixed(2).replace('.', ',');

/**
 * A Nordea export of oldest-first `rows`, newest first like the bank, with a
 * running balance. `own` fills the account's own side; `drop` leaves rows out
 * after the balance was computed, as if the export had lost them.
 */
function nordea(rows: Row[], opts: { own?: string; opening?: number; drop?: number[]; noSaldo?: boolean } = {}) {
  let balance = opts.opening ?? 1000;
  const records = rows.map((r, i) => {
    balance = Math.round((balance + r.amount) * 100) / 100;
    return {
      i,
      Kirjauspäivä: r.date.replace(/-/g, '/'),
      Määrä: fmt(r.amount),
      Maksaja: r.amount < 0 ? (opts.own ?? '') : r.name,
      Maksunsaaja: r.amount < 0 ? r.name : (opts.own ?? ''),
      Nimi: r.name,
      Otsikko: '',
      Viesti: '',
      Viitenumero: '',
      Saldo: opts.noSaldo ? '' : fmt(balance),
      Valuutta: 'EUR',
    };
  });
  return records
    .filter((r) => !opts.drop?.includes(r.i))
    .map(({ i: _i, ...r }) => r)
    .reverse();
}

function toCsv(records: Record<string, unknown>[]) {
  return [COLUMNS.join(';'), ...records.map((r) => COLUMNS.map((c) => String(r[c] ?? '')).join(';'))].join('\n');
}

/** A multipart body; fields go after the file when `fieldsLast`, to show the order does not matter. */
function form(filename: string, csv: string, fields: Record<string, string> = {}, fieldsLast = false) {
  const b = 'test-boundary-7d1f';
  const fieldParts = Object.entries(fields).map(
    ([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
  );
  const filePart = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n`;
  const body = (fieldsLast ? [filePart, ...fieldParts] : [...fieldParts, filePart]).join('') + `--${b}--\r\n`;
  return { payload: Buffer.from(body), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

async function preview(filename: string, records: Record<string, unknown>[], fields: Record<string, string> = {}) {
  const res = await app.inject({ method: 'POST', url: '/imports/nordea/preview', ...form(filename, toCsv(records), fields) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as ImportPreview;
}

function upload(filename: string, records: Record<string, unknown>[], fields: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/imports/nordea/csv', ...form(filename, toCsv(records), fields, true) });
}

let seq = 0;
const importDirect = (records: Record<string, unknown>[], accountName: string, accountIban: string) =>
  processImport({
    records,
    checksum: checksum(Buffer.from(`${seq++}${JSON.stringify(records)}`)),
    filename: 'x.csv',
    accountName,
    accountIban,
    sourceBank: 'nordea',
    format: 'csv',
  });

function tableCounts() {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all() as Array<{ name: string }>;
  return Object.fromEntries(
    tables.map(({ name }) => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)])
  );
}

const accounts = () => db.prepare('SELECT id, name, iban, account_subtype FROM accounts ORDER BY created_at, id').all() as Array<{
  id: string;
  name: string;
  iban: string | null;
  account_subtype: string;
}>;

const CARD_ROWS: Row[] = [
  { date: '2026-10-02', amount: -12.5, name: 'Kahvila Papu' },
  { date: '2026-10-05', amount: -80, name: 'Kauppa Oy' },
  { date: '2026-10-09', amount: -23.9, name: 'Ravintola' },
];

test('a preview writes nothing, not even the event log', async () => {
  const [first, second] = demoExports(ANCHOR);
  await importDirect(first.records, 'Käyttötili', DEMO_CHECKING_IBAN);
  const before = tableCounts();
  const changesBefore = Number((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);

  await preview(`Käyttötili ${DEMO_CHECKING_IBAN}.csv`, second.records);
  await preview('Luottokortti.csv', nordea(CARD_ROWS)); // previewed as a new account
  const counts = tableCounts();

  assert.deepEqual(counts, before);
  // The dry run did run the pipeline (total_changes counts rolled-back writes too).
  assert.ok(Number((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n) > changesBefore);
});

test('dry-run duplicates and transfers are what the import then does', async () => {
  const [first, second, savings] = demoExports(ANCHOR);
  await importDirect(first.records, 'Käyttötili', DEMO_CHECKING_IBAN);

  // The overlapping second checking export: the month in both files is grouped.
  const p2 = await preview(`Käyttötili ${DEMO_CHECKING_IBAN}.csv`, second.records);
  assert.equal(p2.guess.reason, 'iban');
  assert.ok(p2.analysis.duplicates > 0);
  const r2 = await upload(`Käyttötili ${DEMO_CHECKING_IBAN}.csv`, second.records, { accountId: p2.guess.accountId! });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.equal(r2.json().duplicateCount, p2.analysis.duplicates);
  assert.equal(r2.json().transferCount, p2.analysis.transfers);
  assert.equal(p2.analysis.newRows, r2.json().normalizedCount - r2.json().duplicateCount);

  // The savings export: its deposits link to the checking withdrawals.
  const ps = await preview(`Säästötili ${DEMO_SAVINGS_IBAN}.csv`, savings.records);
  assert.equal(ps.guess.reason, 'none');
  assert.equal(ps.guess.newAccount.subtype, 'savings');
  assert.equal(ps.analysis.accountId, null);
  assert.ok(ps.analysis.transfers > 0);
  const rs = await upload(`Säästötili ${DEMO_SAVINGS_IBAN}.csv`, savings.records);
  assert.equal(rs.statusCode, 200, rs.body);
  assert.equal(rs.json().transferCount, ps.analysis.transfers);
  assert.equal(rs.json().duplicateCount, ps.analysis.duplicates);
});

test('the guess: by IBAN, by overlap with an IBAN-less account, or none', async () => {
  await importDirect(nordea([{ date: '2026-10-01', amount: -10, name: 'Kauppa' }], { own: CHECKING }), 'Käyttötili', CHECKING);
  const byIban = await preview('Tapahtumat.csv', nordea([{ date: '2026-10-03', amount: -5, name: 'Kauppa' }], { own: CHECKING }));
  assert.equal(byIban.guess.reason, 'iban');
  assert.equal(byIban.guess.accountId, accounts()[0].id);
  assert.equal(byIban.file.ownIban, CHECKING.replace(/\s+/g, ''));
  assert.equal(byIban.analysis.accountId, byIban.guess.accountId);
  // The user may still pick "new account": the numbers follow the choice, the guess stays.
  const asNew = await preview('Tapahtumat.csv', nordea([{ date: '2026-10-01', amount: -10, name: 'Kauppa' }], { own: CHECKING }), {
    asNewAccount: '1',
  });
  assert.equal(asNew.guess.reason, 'iban');
  assert.equal(asNew.analysis.accountId, null);
  assert.equal(asNew.analysis.duplicates, 0);

  // Two cards; the file repeats card B's rows.
  const cardA = await upload('a.csv', nordea([{ date: '2026-10-02', amount: -99, name: 'Muu kauppa' }]), {
    newAccountName: 'Kortti A',
    newAccountSubtype: 'credit_card',
  });
  const cardB = await upload('b.csv', nordea(CARD_ROWS.slice(0, 2)), { newAccountName: 'Kortti B', newAccountSubtype: 'credit_card' });
  assert.equal(cardA.statusCode, 200, cardA.body);
  assert.equal(cardB.statusCode, 200, cardB.body);
  const byOverlap = await preview('Luottokortti.csv', nordea(CARD_ROWS));
  assert.equal(byOverlap.guess.reason, 'overlap');
  assert.equal(byOverlap.guess.accountId, cardB.json().accountId);
  assert.equal(byOverlap.guess.overlapCount, 2);
  assert.equal(byOverlap.analysis.duplicates, 2);
  assert.equal(byOverlap.analysis.newRows, 1);

  // One identical purchase among a card's many rows in the same period is a coincidence, not an overlap.
  const coincidence = await preview('Toinen kortti.csv', nordea([
    { date: '2026-10-02', amount: -12.5, name: 'Kahvila Papu' },
    { date: '2026-10-07', amount: -31, name: 'Apteekki' },
  ]));
  assert.equal(coincidence.guess.reason, 'none');

  const none = await preview('Luottokortti.csv', nordea([{ date: '2026-09-01', amount: -7, name: 'Kioski' }]));
  assert.equal(none.guess.reason, 'none');
  assert.equal(none.guess.accountId, null);
  assert.deepEqual(none.guess.newAccount, { name: 'Luottokortti', subtype: 'credit_card' });
  assert.equal(none.accounts.length, 3);
  assert.equal(none.accounts.find((a) => a.name === 'Kortti B')?.transactionCount, 2);
});

test('two credit cards with identical purchases stay separate', async () => {
  const rows = nordea(CARD_ROWS);
  for (const name of ['Kortti A', 'Kortti B']) {
    const res = await upload('Luottokortti.csv', rows, { newAccountName: name, newAccountSubtype: 'credit_card' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().duplicateCount, 0);
  }
  assert.deepEqual(
    accounts().map((a) => [a.name, a.iban, a.account_subtype]),
    [
      ['Kortti A', null, 'credit_card'],
      ['Kortti B', null, 'credit_card'],
    ]
  );
  assert.equal(ledgerEntries().length, 6);
});

test('an export without any IBAN needs an account: 400 account_required, nothing written', async () => {
  const before = tableCounts();
  const res = await upload('Luottokortti.csv', nordea(CARD_ROWS));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'account_required');
  assert.deepEqual(tableCounts(), before);
});

test('an explicit account is used as is; unknown is 404', async () => {
  const card = await upload('a.csv', nordea(CARD_ROWS.slice(0, 1)), { newAccountName: 'Kortti', newAccountSubtype: 'credit_card' });
  const id = card.json().accountId;
  // A file naming an IBAN goes into the chosen account, which keeps its name and IBAN.
  const res = await upload(`Muu ${OTHER}.csv`, nordea(CARD_ROWS.slice(1), { own: OTHER }), { accountId: id });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().accountId, id);
  assert.deepEqual(accounts().map((a) => [a.name, a.iban]), [['Kortti', null]]);

  const p = await preview(`Muu ${OTHER}.csv`, nordea(CARD_ROWS.slice(1), { own: OTHER }), { accountId: id });
  assert.equal(p.analysis.accountId, id);
  assert.equal(p.analysis.duplicates, 2);

  const missing = await upload('a.csv', nordea(CARD_ROWS), { accountId: 'nope' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, 'account_not_found');
  const missingPreview = await app.inject({
    method: 'POST',
    url: '/imports/nordea/preview',
    ...form('a.csv', toCsv(nordea(CARD_ROWS)), { accountId: 'nope' }),
  });
  assert.equal(missingPreview.statusCode, 404);
});

test('a new account: 409 on a taken name, takes the file IBAN only when free', async () => {
  const checking = await upload(`Käyttötili ${CHECKING}.csv`, nordea(CARD_ROWS.slice(0, 1), { own: CHECKING }));
  assert.equal(checking.statusCode, 200, checking.body);

  const taken = await upload('a.csv', nordea(CARD_ROWS), { newAccountName: 'käyttötili ', newAccountSubtype: 'checking' });
  assert.equal(taken.statusCode, 409);
  assert.equal(taken.json().error, 'account_name_exists');

  const fresh = await upload(`x ${OTHER}.csv`, nordea(CARD_ROWS, { own: OTHER }), { newAccountName: 'Uusi', newAccountSubtype: 'savings' });
  assert.equal(fresh.statusCode, 200, fresh.body);
  // The IBAN is already the checking account's: the new account gets none.
  const dupIban = await upload('y.csv', nordea(CARD_ROWS, { own: CHECKING }), { newAccountName: 'Toinen', newAccountSubtype: 'checking' });
  assert.equal(dupIban.statusCode, 200, dupIban.body);
  assert.deepEqual(
    accounts().map((a) => [a.name, a.iban, a.account_subtype]),
    [
      ['Käyttötili', CHECKING.replace(/\s+/g, ''), 'checking'],
      ['Uusi', OTHER.replace(/\s+/g, ''), 'savings'],
      ['Toinen', null, 'checking'],
    ]
  );

  const halfField = await upload('z.csv', nordea(CARD_ROWS), { newAccountName: 'Kolmas' });
  assert.equal(halfField.statusCode, 400);
  assert.equal(halfField.json().error, 'invalid_request');
});

test('gaps before and after the account’s data', async () => {
  await importDirect(
    nordea(
      [
        { date: '2026-03-01', amount: -10, name: 'Kauppa' },
        { date: '2026-03-31', amount: -10, name: 'Kauppa' },
      ],
      { own: CHECKING }
    ),
    'Käyttötili',
    CHECKING
  );
  const later = await preview('t.csv', nordea([{ date: '2026-05-01', amount: -5, name: 'Kauppa' }], { own: CHECKING }));
  assert.deepEqual(later.analysis.gapBefore, { from: '2026-04-01', to: '2026-04-30', days: 30 });
  assert.equal(later.analysis.gapAfter, null);

  const earlier = await preview('t.csv', nordea([{ date: '2026-02-20', amount: -5, name: 'Kauppa' }], { own: CHECKING }));
  assert.deepEqual(earlier.analysis.gapAfter, { from: '2026-02-21', to: '2026-02-28', days: 8 });
  assert.equal(earlier.analysis.gapBefore, null);

  const touching = await preview('t.csv', nordea([{ date: '2026-04-01', amount: -5, name: 'Kauppa' }], { own: CHECKING }));
  assert.equal(touching.analysis.gapBefore, null);
});

test('quiet periods: 14 or more days without rows inside the file', () => {
  const rows = bookedRowsInTimeOrder(
    nordea([
      { date: '2026-01-01', amount: -1, name: 'a' },
      { date: '2026-01-14', amount: -1, name: 'a' }, // 12 empty days: not quiet
      { date: '2026-02-01', amount: -1, name: 'a' }, // 17 empty days
      { date: '2026-02-16', amount: -1, name: 'a' }, // 14 empty days
    ])
  );
  assert.deepEqual(quietPeriods(rows), [
    { from: '2026-01-15', to: '2026-01-31', days: 17 },
    { from: '2026-02-02', to: '2026-02-15', days: 14 },
  ]);
});

test('balance breaks: a missing row shows where and how much', async () => {
  const rows: Row[] = [
    { date: '2026-03-10', amount: -20, name: 'Kauppa' },
    { date: '2026-03-11', amount: -45.2, name: 'Puuttuva' },
    { date: '2026-03-12', amount: -5, name: 'Kahvila' },
    { date: '2026-03-12', amount: -7, name: 'Kahvila' },
    { date: '2026-03-13', amount: 100, name: 'Palkka' },
  ];
  assert.deepEqual(balanceBreaks(bookedRowsInTimeOrder(nordea(rows))), []);
  const p = await preview('t.csv', nordea(rows, { drop: [1] }));
  assert.deepEqual(p.analysis.balanceBreaks, [{ date: '2026-03-12', expected: 968, actual: 922.8, difference: -45.2 }]);
  assert.equal(p.file.hasRunningBalance, true);

  // Oldest-first exports read the same way.
  assert.deepEqual(balanceBreaks(bookedRowsInTimeOrder(nordea(rows, { drop: [1] }).reverse())), p.analysis.balanceBreaks);
  // Without Saldo there is nothing to check.
  const noSaldo = await preview('t.csv', nordea(rows, { noSaldo: true }));
  assert.deepEqual(noSaldo.analysis.balanceBreaks, []);
  assert.equal(noSaldo.file.hasRunningBalance, false);
});

test('opening mismatch: the file does not start from the account’s balance', async () => {
  const first: Row[] = [
    { date: '2026-03-01', amount: -10, name: 'Kauppa' },
    { date: '2026-03-31', amount: -10, name: 'Kauppa' },
  ];
  await importDirect(nordea(first, { own: CHECKING, opening: 1000 }), 'Käyttötili', CHECKING); // closes at 980
  const next = [{ date: '2026-04-01', amount: -5, name: 'Kauppa' }];

  const ok = await preview('t.csv', nordea(next, { own: CHECKING, opening: 980 }));
  assert.equal(ok.analysis.openingMismatch, null);

  const off = await preview('t.csv', nordea(next, { own: CHECKING, opening: 950 }));
  assert.deepEqual(off.analysis.openingMismatch, { date: '2026-04-01', expected: 980, actual: 950, difference: -30 });

  // After a gap the balance is expected to differ: not reported.
  const gap = await preview('t.csv', nordea([{ date: '2026-05-01', amount: -5, name: 'Kauppa' }], { own: CHECKING, opening: 950 }));
  assert.equal(gap.analysis.openingMismatch, null);
});

test('file summary and IBAN mismatch', async () => {
  await importDirect(nordea([{ date: '2026-10-01', amount: -10, name: 'Kauppa' }], { own: CHECKING }), 'Käyttötili', CHECKING);
  const records = [
    ...nordea(CARD_ROWS, { own: OTHER }),
    { ...nordea(CARD_ROWS, { own: OTHER })[0], Kirjauspäivä: 'Varaus', Saldo: '' },
    { ...nordea(CARD_ROWS, { own: OTHER })[0], Määrä: '' },
  ];
  const id = accounts()[0].id;
  const p = await preview(`Matkakortti ${OTHER}.csv`, records, { accountId: id });
  assert.deepEqual(
    { ...p.file },
    {
      filename: `Matkakortti ${OTHER}.csv`,
      rowCount: 5,
      bookedCount: 3,
      pendingCount: 1,
      skippedCount: 1,
      firstDate: '2026-10-02',
      lastDate: '2026-10-09',
      ownIban: OTHER.replace(/\s+/g, ''),
      suggestedName: 'Matkakortti',
      hasRunningBalance: true,
    }
  );
  assert.equal(p.analysis.ibanMismatch, true);
  assert.equal(p.guess.reason, 'none');

  const same = await preview('t.csv', nordea(CARD_ROWS, { own: CHECKING }));
  assert.equal(same.analysis.ibanMismatch, false);
});
