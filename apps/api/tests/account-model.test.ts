import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { isValidIban } from '@finance-app/shared';

import { db } from '../src/db.js';
import { routes } from '../src/routes/index.js';
import { checksum, processImport } from '../src/importer.js';
import { ledgerEntries } from '../src/ledger.js';
import { getSummary, getHouseholdSummary } from '../src/summary.js';
import { getMonthlyOverview } from '../src/monthly.js';
import { getInsights } from '../src/insights.js';
import { searchTransactions } from '../src/transactionSearch.js';
import { applyAccountChangeNow, planAccountChange } from '../src/accountChanges.js';
import { resetDb } from './setup/resetDb.js';
import { compact, testIban } from './setup/iban.js';

// The account model (GLOSSARY.md, "Account", "Transfer to a manual account"):
// manual accounts, their IBAN making payments to them one-sided transfers, and
// the change sets that create and edit accounts. Fictional accounts only.

const app = Fastify();
await app.register(routes);
after(() => app.close());

beforeEach(() => resetDb());

const CHECKING = testIban('12345600000001');
const SAVINGS = testIban('12345600000002');
const LOAN = testIban('12345600000003');
const JOINT = testIban('12345600000004');
const OTHER_PERSON = testIban('12345600000005');

type Row = { date: string; amount: number; other?: string; name: string };
const record = (r: Row) => ({
  Kirjauspäivä: r.date.replace(/-/g, '/'),
  Määrä: r.amount.toFixed(2).replace('.', ','),
  Maksaja: r.amount > 0 ? (r.other ?? '') : CHECKING,
  Maksunsaaja: r.amount < 0 ? (r.other ?? '') : CHECKING,
  Nimi: r.name,
  Otsikko: '',
  Viesti: '',
  Saldo: '',
  Valuutta: 'EUR',
});

let n = 0;
function importChecking(rows: Row[], iban = CHECKING) {
  const records = rows.map(record);
  return processImport({
    records,
    checksum: checksum(Buffer.from(`${n++}${JSON.stringify(records)}`)),
    filename: 'x.csv',
    accountName: 'Käyttötili',
    accountIban: iban,
    sourceBank: 'nordea',
    format: 'csv',
  });
}

const txId = (name: string, amount: number) =>
  (db.prepare('SELECT id FROM normalized_transactions WHERE counterparty_name = ? AND amount = ?').get(name, amount) as { id: string }).id;

function createManual(fields: Record<string, unknown>, actor = 'user') {
  const set = applyAccountChangeNow({ kind: 'create_account', ...fields }, actor);
  return set.accountId;
}

// The same person is paid on two accounts: only the one registered as own counts.
const STANDARD_ROWS: Row[] = [
  { date: '2026-10-01', amount: 3000, other: OTHER_PERSON, name: 'Palkka Oy' },
  { date: '2026-10-02', amount: -200, other: SAVINGS, name: 'Testi Henkilö' },
  { date: '2026-10-03', amount: -150, other: OTHER_PERSON, name: 'Testi Henkilö' },
  { date: '2026-10-04', amount: -400, other: LOAN, name: 'Lainanhoito' },
  { date: '2026-10-05', amount: -55.5, name: 'Kauppa' },
];

test('a payment to a manual savings account IBAN is saving: in cash flow, not in consumption', async () => {
  await importChecking(STANDARD_ROWS);
  const savingsId = createManual({ name: 'Yhteinen säästö', type: 'savings', iban: SAVINGS, ownershipShare: 50 });

  const saving = ledgerEntries().find((e) => e.id === txId('Testi Henkilö', -200))!;
  assert.deepEqual(saving.ownTransfer, { accountId: savingsId, kind: 'saving' });
  assert.equal(saving.isTransfer, false);
  // Same name, other IBAN: an ordinary payment.
  assert.equal(ledgerEntries().find((e) => e.id === txId('Testi Henkilö', -150))!.ownTransfer, null);
  // Loan account not registered yet: an ordinary payment.
  assert.equal(ledgerEntries().find((e) => e.id === txId('Lainanhoito', -400))!.ownTransfer, null);

  // Cash flow keeps it: the money left the imported accounts.
  assert.equal(ledgerEntries().length, 5);
  assert.ok(!ledgerEntries({ consumptionOnly: true }).some((e) => e.id === saving.id));
  assert.equal(ledgerEntries({ consumptionOnly: true }).length, 4);
});

test('loan and other types: loan_repayment is not consumption, a manual checking account is reported as usual', async () => {
  await importChecking([
    ...STANDARD_ROWS,
    { date: '2026-10-06', amount: -300, other: JOINT, name: 'Yhteistili' },
  ]);
  const loanId = createManual({ name: 'Asuntolaina', type: 'loan', iban: LOAN });
  const jointId = createManual({ name: 'Yhteinen käyttötili', type: 'checking', iban: JOINT });

  const byId = new Map(ledgerEntries().map((e) => [e.id, e]));
  assert.deepEqual(byId.get(txId('Lainanhoito', -400))!.ownTransfer, { accountId: loanId, kind: 'loan_repayment' });
  assert.deepEqual(byId.get(txId('Yhteistili', -300))!.ownTransfer, { accountId: jointId, kind: 'other' });
  const consumption = new Set(ledgerEntries({ consumptionOnly: true }).map((e) => e.id));
  assert.ok(!consumption.has(txId('Lainanhoito', -400)));
  assert.ok(consumption.has(txId('Yhteistili', -300)));
});

test('reports: net and the monthly overview keep saving and repayment, and show them apart', async () => {
  await importChecking(STANDARD_ROWS);
  const before = getSummary('2026-10-20');
  createManual({ name: 'Säästö', type: 'savings', iban: SAVINGS });
  createManual({ name: 'Laina', type: 'loan', iban: LOAN });

  const summary = getSummary('2026-10-20');
  assert.equal(summary.monthlyNet, before.monthlyNet);
  assert.equal(summary.monthlySaving, -200);
  assert.equal(summary.monthlyLoanRepayment, -400);
  // Manual accounts have no balance yet: they do not make the summary incomplete.
  assert.equal(summary.isComplete, before.isComplete);
  assert.equal(summary.missingBalanceAccountCount, before.missingBalanceAccountCount);
  assert.equal(getHouseholdSummary('2026-10-20').accounts.length, 1);

  const october = getMonthlyOverview(6, '2026-11-20').find((p) => p.from <= '2026-10-02' && p.to >= '2026-10-04')!;
  assert.equal(october.saving, -200);
  assert.equal(october.loanRepayment, -400);
});

test('insights never see saving or loan repayment as spending', async () => {
  await importChecking([
    { date: '2026-11-01', amount: -900, other: SAVINGS, name: 'Säästösiirto' },
    { date: '2026-11-02', amount: -20, name: 'Kauppa' },
  ]);
  const ids = () => getInsights('2026-11-10').flatMap((i) => i.transactionIds);
  assert.ok(ids().includes(txId('Säästösiirto', -900)));
  createManual({ name: 'Säästö', type: 'savings', iban: SAVINGS });
  assert.ok(!ids().includes(txId('Säästösiirto', -900)));
});

test('search returns the manual account name and type, never its IBAN', async () => {
  await importChecking(STANDARD_ROWS);
  const savingsId = createManual({ name: 'Lomasäästö', type: 'savings', iban: SAVINGS });
  const result = searchTransactions({});
  const row = result.items.find((i) => i.id === txId('Testi Henkilö', -200))!;
  assert.deepEqual(row.ownTransfer, { accountId: savingsId, accountName: 'Lomasäästö', accountType: 'savings', kind: 'saving' });
  assert.equal(JSON.stringify(result).includes(compact(SAVINGS)), false);
});

test('setting an IBAN later recognises stored transactions; removing it and undo restore them', async () => {
  await importChecking(STANDARD_ROWS);
  const id = createManual({ name: 'Säästö', type: 'savings' });
  const target = txId('Testi Henkilö', -200);
  const kindOf = () => ledgerEntries().find((e) => e.id === target)!.ownTransfer?.kind ?? null;
  assert.equal(kindOf(), null);

  const plan = planAccountChange({ kind: 'update_account', accountId: id, iban: SAVINGS });
  assert.equal(plan.transfers.recognizedTotal, 1);
  assert.equal(plan.transfers.recognized[0].transactionId, target);
  assert.deepEqual(plan.changes, [{ field: 'recognizesTransfers', from: false, to: true }]);
  const set = applyAccountChangeNow({ kind: 'update_account', accountId: id, iban: SAVINGS }, 'hermes');
  assert.equal(set.actor, 'hermes');
  assert.equal(kindOf(), 'saving');

  const cleared = applyAccountChangeNow({ kind: 'update_account', accountId: id, iban: null }, 'user');
  assert.equal(cleared.transfers.releasedTotal, 1);
  assert.equal(kindOf(), null);

  applyAccountChangeNow({ kind: 'undo', changeSetId: cleared.id }, 'user');
  assert.equal(kindOf(), 'saving');
  // Changing the type changes the reporting.
  applyAccountChangeNow({ kind: 'update_account', accountId: id, type: 'loan' }, 'user');
  assert.equal(kindOf(), 'loan_repayment');
});

test('new imports are recognised too; a pair link the import makes still wins', async () => {
  createManual({ name: 'Säästö', type: 'savings', iban: SAVINGS });
  await importChecking([{ date: '2026-10-02', amount: -200, other: SAVINGS, name: 'Testi Henkilö' }]);
  assert.equal(ledgerEntries().find((e) => e.counterparty === 'Testi Henkilö')!.ownTransfer?.kind, 'saving');
  // A card credit of the same amount: the import links it as a card repayment, as before
  // manual accounts existed; the linked pair stays a transfer, not a saving.
  await processImport({
    records: [
      { Kirjauspäivä: '2026/10/02', Määrä: '200,00', Maksaja: '', Maksunsaaja: '', Nimi: 'Suoritus', Otsikko: '', Viesti: '', Saldo: '', Valuutta: 'EUR' },
    ],
    checksum: checksum(Buffer.from('card')),
    filename: 'card.csv',
    sourceBank: 'nordea',
    format: 'csv',
    target: { newAccount: { name: 'Kortti', subtype: 'credit_card' } },
  });
  const payment = ledgerEntries({ includeTransfers: true }).find((e) => e.counterparty === 'Testi Henkilö')!;
  assert.equal(payment.isTransfer, true);
  assert.equal(payment.ownTransfer, null);
});

test('repeating an earlier change applies it again (no stale token returns an old set)', async () => {
  await importChecking(STANDARD_ROWS);
  const id = createManual({ name: 'A', type: 'savings' });
  const first = applyAccountChangeNow({ kind: 'update_account', accountId: id, iban: SAVINGS }, 'user');
  applyAccountChangeNow({ kind: 'update_account', accountId: id, iban: null }, 'user');
  const again = applyAccountChangeNow({ kind: 'update_account', accountId: id, iban: SAVINGS }, 'user');
  assert.notEqual(again.id, first.id);
  assert.equal(ledgerEntries().filter((e) => e.ownTransfer).length, 1);

  const archived = applyAccountChangeNow({ kind: 'archive_account', accountId: id }, 'user');
  applyAccountChangeNow({ kind: 'undo', changeSetId: archived.id }, 'user');
  const archivedAgain = applyAccountChangeNow({ kind: 'archive_account', accountId: id }, 'user');
  assert.notEqual(archivedAgain.id, archived.id);
  assert.ok((db.prepare('SELECT archived_at FROM accounts WHERE id = ?').get(id) as { archived_at: string | null }).archived_at);
});

test('an archived account, also one whose creation was undone, comes back with unarchive_account', async () => {
  await importChecking(STANDARD_ROWS);
  const created = applyAccountChangeNow({ kind: 'create_account', name: 'Laina', type: 'loan', iban: LOAN }, 'user');
  applyAccountChangeNow({ kind: 'undo', changeSetId: created.id }, 'user');
  assert.equal(ledgerEntries().filter((e) => e.ownTransfer).length, 0);
  const back = applyAccountChangeNow({ kind: 'unarchive_account', accountId: created.accountId }, 'user');
  assert.equal(back.transfers.recognizedTotal, 1);
  assert.equal(ledgerEntries().filter((e) => e.ownTransfer).length, 1);
  // Now it can be edited again, e.g. its IBAN removed.
  applyAccountChangeNow({ kind: 'update_account', accountId: created.accountId, iban: null }, 'user');
  assert.throws(() => planAccountChange({ kind: 'unarchive_account', accountId: created.accountId }), (err: any) => err.code === 'account_not_archived');
});

test('a type change that changes the reporting lists the transactions as reclassified', async () => {
  await importChecking(STANDARD_ROWS);
  const id = createManual({ name: 'Säästö', type: 'savings', iban: SAVINGS });
  const plan = planAccountChange({ kind: 'update_account', accountId: id, type: 'property' });
  assert.equal(plan.transfers.reclassifiedTotal, 1);
  assert.equal(plan.transfers.recognizedTotal, 0);
  assert.equal(planAccountChange({ kind: 'update_account', accountId: id, type: 'investment' }).transfers.reclassifiedTotal, 0);
});

test('household totals follow the new types of imported accounts', async () => {
  await importChecking([{ date: '2026-10-01', amount: 10, other: OTHER_PERSON, name: 'Palkka Oy' }]);
  const checkingId = (db.prepare("SELECT id FROM accounts WHERE tracking = 'imported'").get() as { id: string }).id;
  db.prepare("INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES ('s1', ?, ?, '2026-10-01', -300, 'EUR')").run(
    new Date().toISOString(),
    checkingId
  );
  applyAccountChangeNow({ kind: 'update_account', accountId: checkingId, type: 'other_liability' }, 'user');
  assert.equal(getHouseholdSummary('2026-10-20').creditDebt, 300);
});

test('a linked transfer between imported accounts stays a linked transfer', async () => {
  await importChecking([{ date: '2026-10-02', amount: -200, other: SAVINGS, name: 'Siirto' }]);
  // The savings account is imported: the pair links, and it cannot also be a manual account.
  await importChecking([{ date: '2026-10-02', amount: 200, other: CHECKING, name: 'Siirto' }].map((r) => r), SAVINGS);
  const entries = ledgerEntries({ includeTransfers: true });
  assert.ok(entries.every((e) => e.isTransfer && e.ownTransfer === null));
  assert.throws(
    () => createManual({ name: 'Säästö kopio', type: 'savings', iban: SAVINGS }),
    (err: any) => err.code === 'iban_in_use'
  );
});

test('archiving stops recognition; undoing the archive brings it back; undoing a creation archives', async () => {
  await importChecking(STANDARD_ROWS);
  const created = applyAccountChangeNow({ kind: 'create_account', name: 'Laina', type: 'loan', iban: LOAN }, 'user');
  const id = created.accountId;
  const target = txId('Lainanhoito', -400);
  const recognised = () => ledgerEntries().find((e) => e.id === target)!.ownTransfer !== null;
  assert.ok(recognised());

  const archived = applyAccountChangeNow({ kind: 'archive_account', accountId: id }, 'user');
  assert.equal(archived.transfers.releasedTotal, 1);
  assert.ok(!recognised());
  applyAccountChangeNow({ kind: 'undo', changeSetId: archived.id }, 'user');
  assert.ok(recognised());

  applyAccountChangeNow({ kind: 'undo', changeSetId: created.id }, 'user');
  assert.ok(!recognised());
  assert.ok((db.prepare('SELECT archived_at FROM accounts WHERE id = ?').get(id) as { archived_at: string | null }).archived_at);
});

test('undo leaves fields changed since alone and reports them', async () => {
  const id = createManual({ name: 'Säästö', type: 'savings' });
  const set = applyAccountChangeNow({ kind: 'update_account', accountId: id, name: 'Lomasäästö', ownershipShare: 50 }, 'user');
  applyAccountChangeNow({ kind: 'update_account', accountId: id, name: 'Kesäsäästö' }, 'user');
  const undo = applyAccountChangeNow({ kind: 'undo', changeSetId: set.id }, 'user');
  assert.deepEqual(undo.exceptions, [{ reason: 'changed_since', field: 'name' }]);
  const row = db.prepare('SELECT name, ownership_share FROM accounts WHERE id = ?').get(id) as { name: string; ownership_share: number };
  assert.deepEqual({ ...row }, { name: 'Kesäsäästö', ownership_share: 100 });
});

test('a plan goes stale when a new matching transaction arrives before apply', async () => {
  const id = createManual({ name: 'Säästö', type: 'savings' });
  await importChecking(STANDARD_ROWS);
  const op = { kind: 'update_account', accountId: id, iban: SAVINGS } as const;
  const plan = planAccountChange(op);
  await importChecking([{ date: '2026-10-09', amount: -75, other: SAVINGS, name: 'Testi Henkilö' }]);
  await app
    .inject({ method: 'POST', url: '/accounts/apply', payload: { op, planToken: plan.planToken } })
    .then((res) => {
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error, 'plan_stale');
    });
});

test('validation: imported accounts keep their IBAN and currency; IBANs are checked', async () => {
  await importChecking(STANDARD_ROWS);
  const checkingId = (db.prepare("SELECT id FROM accounts WHERE tracking = 'imported'").get() as { id: string }).id;
  assert.throws(
    () => planAccountChange({ kind: 'update_account', accountId: checkingId, iban: SAVINGS }),
    (err: any) => err.code === 'account_imported'
  );
  assert.throws(
    () => planAccountChange({ kind: 'update_account', accountId: checkingId, currency: 'SEK' }),
    (err: any) => err.code === 'account_imported'
  );
  assert.throws(() => planAccountChange({ kind: 'archive_account', accountId: checkingId }), (err: any) => err.code === 'account_imported');
  // Name, type and share of an imported account can change.
  applyAccountChangeNow({ kind: 'update_account', accountId: checkingId, type: 'savings', ownershipShare: 50 }, 'user');
  assert.throws(() => createManual({ name: 'x', type: 'savings', iban: 'FI00 1234 5600 0007 85' }), /iban_invalid/);
  assert.throws(() => createManual({ name: 'x', type: 'savings', ownershipShare: 101 }));
  assert.throws(() => createManual({ name: 'Käyttötili', type: 'savings' }), (err: any) => err.code === 'account_name_exists');
  assert.ok(isValidIban(SAVINGS));
});

test('nothing is imported into a manual account', async () => {
  const id = createManual({ name: 'Säästö', type: 'savings', iban: SAVINGS });
  await assert.rejects(() => importChecking([{ date: '2026-10-02', amount: 5, other: CHECKING, name: 'Korko' }], SAVINGS), (err: any) => err.code === 'account_manual');
  await assert.rejects(
    () =>
      processImport({
        records: [record({ date: '2026-10-02', amount: -5, name: 'Kauppa' })],
        checksum: checksum(Buffer.from('target')),
        filename: 'x.csv',
        sourceBank: 'nordea',
        format: 'csv',
        target: { accountId: id },
      }),
    (err: any) => err.code === 'account_manual'
  );
});

test('routes: create, patch and archive record the actor; no response carries the IBAN', async () => {
  await importChecking(STANDARD_ROWS);
  const headers = { 'x-finance-actor': 'agent-x' };
  const created = await app.inject({
    method: 'POST',
    url: '/accounts',
    headers,
    payload: { name: 'Lomasäästö', type: 'savings', iban: SAVINGS, currency: 'eur', updateIntervalDays: 90 },
  });
  assert.equal(created.statusCode, 200, created.body);
  const { id } = created.json();
  assert.equal(created.json().changeSet.actor, 'agent-x');
  assert.equal(created.json().changeSet.op.recognizesTransfers, true);

  const patched = await app.inject({ method: 'PATCH', url: `/accounts/${id}`, payload: { ownership_share: 50, iban: LOAN, owner_label: 'Yhteinen' } });
  assert.equal(patched.statusCode, 200, patched.body);
  const bad = await app.inject({ method: 'PATCH', url: `/accounts/${id}`, payload: { iban: 'FI12 3' } });
  assert.equal(bad.statusCode, 400);
  const badType = await app.inject({ method: 'PATCH', url: `/accounts/${id}`, payload: { account_subtype: 'boat' } });
  assert.equal(badType.json().error, 'invalid_account_subtype');
  assert.equal((await app.inject({ method: 'PATCH', url: '/accounts/missing', payload: { name: 'x' } })).statusCode, 404);

  const list = (await app.inject({ method: 'GET', url: '/accounts' })).json() as Array<Record<string, unknown>>;
  const manual = list.find((a) => a.id === id)!;
  assert.equal(manual.tracking, 'manual');
  assert.equal(manual.ownership_share, 50);
  assert.equal(manual.currency, 'EUR');
  assert.equal(manual.update_interval_days, 90);
  assert.equal(manual.owner_label, 'Yhteinen');
  assert.equal(manual.recognizes_transfers, true);

  const sets = (await app.inject({ method: 'GET', url: `/accounts/change-sets?accountId=${id}` })).json();
  assert.equal(sets.total, 2);
  const detail = await app.inject({ method: 'GET', url: `/accounts/change-sets/${sets.items[0].id}` });
  assert.deepEqual(
    detail.json().changes.find((c: { field: string }) => c.field === 'recognizesTransfers'),
    { field: 'recognizesTransfers', from: true, to: true, replaced: true }
  );
  // The IBAN moved from savings to the loan: both payments' reporting changed.
  assert.equal(detail.json().transfers.recognizedTotal, 1);
  assert.equal(detail.json().transfers.releasedTotal, 1);

  const plan = await app.inject({ method: 'POST', url: '/accounts/plan', payload: { op: { kind: 'update_account', accountId: id, iban: SAVINGS } } });
  const archived = await app.inject({ method: 'POST', url: `/accounts/${id}/archive`, headers });
  for (const res of [created, patched, plan, archived, detail]) {
    for (const iban of [SAVINGS, LOAN]) {
      assert.equal(res.body.includes(compact(iban)), false, res.body);
      assert.equal(res.body.includes(iban), false);
    }
  }
  // Categorization change sets do not list account sets, nor undo them.
  assert.equal((await app.inject({ method: 'GET', url: '/categorization/change-sets' })).json().total, 0);
  const undo = await app.inject({ method: 'POST', url: '/categorization/plan', payload: { op: { kind: 'undo', changeSetId: sets.items[0].id } } });
  assert.equal(undo.statusCode, 404);
});
