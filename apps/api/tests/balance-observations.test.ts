import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import Fastify from 'fastify';

import { db } from '../src/db.js';
import { daysBefore, today } from '../src/ledger.js';
import { routes } from '../src/routes/index.js';
import { getSummary } from '../src/summary.js';
import { resetDb } from './setup/resetDb.js';

// Dated balance observations (GLOSSARY.md, "Balance observation"): a manual
// account's only balance, an imported account's anchor. Written through account
// change sets (plan/apply/undo) with the actor; read as a step function (the
// latest observation on or before a day), never estimated in between.

const app = Fastify();
await app.register(routes);
after(() => app.close());

beforeEach(() => resetDb());

const AS_AGENT = { 'x-finance-actor': 'agent-under-test' };
const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: AS_AGENT });

async function manualAccount(fields: Record<string, unknown>) {
  const res = await inject('POST', '/accounts', fields);
  assert.equal(res.statusCode, 200, res.body);
  return res.json().id as string;
}

function importedAccount(name: string, subtype = 'checking', extra: { share?: number } = {}) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO accounts (id, created_at, name, iban, type, account_subtype, ownership_share) VALUES (?, ?, ?, NULL, 'bank', ?, ?)`
  ).run(id, new Date().toISOString(), name, subtype, extra.share ?? 100);
  return id;
}

function importedSnapshot(accountId: string, date: string, balance: number) {
  db.prepare(
    `INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, 'EUR')`
  ).run(crypto.randomUUID(), new Date().toISOString(), accountId, date, balance);
}

function booked(accountId: string, date: string, amount: number) {
  const now = new Date().toISOString();
  const session = crypto.randomUUID();
  db.prepare(
    'INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(session, now, 'test', 'csv', session, 1, session);
  db.prepare(
    `INSERT INTO normalized_transactions (id, created_at, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR', 'Testikauppa')`
  ).run(crypto.randomUUID(), now, session, accountId, `${date}T00:00:00.000Z`, date, amount);
}

async function plan(op: Record<string, unknown>) {
  const res = await inject('POST', '/accounts/plan', { op });
  return res;
}

async function planAndApply(op: Record<string, unknown>) {
  const p = await plan(op);
  assert.equal(p.statusCode, 200, p.body);
  const res = await inject('POST', '/accounts/apply', { op, planToken: p.json().planToken });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

const observations = async (accountId: string) => (await inject('GET', `/accounts/${accountId}/balance-observations`)).json();
const history = async (query: string) => (await inject('GET', `/balances/history?${query}`)).json();
const netWorth = async () => (await inject('GET', '/net-worth')).json();
const snapshotCount = () => (db.prepare('SELECT COUNT(*) AS n FROM balance_snapshots').get() as { n: number }).n;

test('a loan debt is entered positive, stored negative, and only the plan token writes it', async () => {
  const loan = await manualAccount({ name: 'Testilaina', type: 'loan' });
  const op = { kind: 'add_balance_observation', accountId: loan, date: '2026-09-30', amount: 1000, note: 'lainan vuosikooste' };

  const p = await plan(op);
  assert.equal(p.statusCode, 200, p.body);
  assert.equal(snapshotCount(), 0, 'a plan writes nothing');
  assert.equal(p.json().observation.before, null);
  assert.equal(p.json().observation.after.balance, -1000);
  assert.equal(p.json().observation.after.debt, 1000);

  const set = await planAndApply(op);
  assert.equal(set.actor, 'agent-under-test');
  assert.equal(set.kind, 'add_balance_observation');
  assert.equal(set.accountId, loan);

  const list = await observations(loan);
  assert.equal(list.observations.length, 1);
  assert.equal(list.observations[0].balance, -1000);
  assert.equal(list.observations[0].debt, 1000);
  assert.equal(list.observations[0].note, 'lainan vuosikooste');
  assert.equal(list.observations[0].actor, 'agent-under-test');
  assert.deepEqual(list.latest, { date: '2026-09-30', balance: -1000, debt: 1000, source: 'manual' });

  // A negative debt is read as debt too: the sign can never turn a loan into an asset.
  const card = await manualAccount({ name: 'Testikortti', type: 'credit_card' });
  await planAndApply({ kind: 'add_balance_observation', accountId: card, date: '2026-09-30', amount: -50 });
  assert.equal((await observations(card)).observations[0].balance, -50);
});

test('an observation cannot be in the future, on a day that has one, or on an archived account', async () => {
  const savings = await manualAccount({ name: 'Testisäästö', type: 'savings' });
  const tomorrow = daysBefore(today(), -1);
  const future = await plan({ kind: 'add_balance_observation', accountId: savings, date: tomorrow, amount: 10 });
  assert.equal(future.statusCode, 400);
  assert.equal(future.json().error, 'date_in_future');

  await planAndApply({ kind: 'add_balance_observation', accountId: savings, date: '2026-09-30', amount: 10 });
  const again = await plan({ kind: 'add_balance_observation', accountId: savings, date: '2026-09-30', amount: 12 });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'observation_exists');
  assert.ok(again.json().details.observationId);

  const checking = importedAccount('Testikäyttötili');
  importedSnapshot(checking, '2026-09-30', 500);
  const onImported = await plan({ kind: 'add_balance_observation', accountId: checking, date: '2026-09-30', amount: 1 });
  assert.equal(onImported.statusCode, 409);
  assert.equal(onImported.json().error, 'snapshot_exists');

  await inject('POST', `/accounts/${savings}/archive`);
  const archived = await plan({ kind: 'add_balance_observation', accountId: savings, date: '2026-10-01', amount: 1 });
  assert.equal(archived.statusCode, 409);
  assert.equal(archived.json().error, 'account_archived');
});

test('the bank’s own balance cannot be corrected or deleted as an observation', async () => {
  const checking = importedAccount('Testikäyttötili');
  importedSnapshot(checking, '2026-09-30', 500);
  const id = (db.prepare('SELECT id FROM balance_snapshots').get() as { id: string }).id;
  const correct = await plan({ kind: 'correct_balance_observation', observationId: id, amount: 1 });
  assert.equal(correct.statusCode, 409);
  assert.equal(correct.json().error, 'snapshot_imported');
  const del = await plan({ kind: 'delete_balance_observation', observationId: id });
  assert.equal(del.statusCode, 409);
  const missing = await plan({ kind: 'delete_balance_observation', observationId: 'no-such' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, 'observation_not_found');
});

test('correcting and deleting an observation are undoable, and the deleted one is kept in the change set', async () => {
  const loan = await manualAccount({ name: 'Testilaina', type: 'loan' });
  await planAndApply({ kind: 'add_balance_observation', accountId: loan, date: '2026-09-30', amount: 1000 });
  const id = (await observations(loan)).observations[0].id;

  const corrected = await planAndApply({ kind: 'correct_balance_observation', observationId: id, amount: 900, note: 'korjattu' });
  assert.deepEqual(
    corrected.changes.map((c: { field: string }) => c.field).sort(),
    ['observationBalance', 'observationNote']
  );
  let obs = (await observations(loan)).observations[0];
  assert.equal(obs.balance, -900);
  assert.equal(obs.note, 'korjattu');

  await planAndApply({ kind: 'undo', changeSetId: corrected.id });
  obs = (await observations(loan)).observations[0];
  assert.equal(obs.balance, -1000);
  assert.equal(obs.note, null);

  const deleted = await planAndApply({ kind: 'delete_balance_observation', observationId: id, reason: 'väärä tili' });
  assert.equal(deleted.observation.before.balance, -1000);
  assert.equal(deleted.observation.after, null);
  assert.equal((await observations(loan)).observations.length, 0);
  assert.equal((await netWorth()).accounts.find((a: { accountId: string }) => a.accountId === loan).balance, null);

  await planAndApply({ kind: 'undo', changeSetId: deleted.id });
  obs = (await observations(loan)).observations[0];
  assert.equal(obs.id, id, 'the undo restores the same observation');
  assert.equal(obs.balance, -1000);

  const log = (await inject('GET', `/accounts/change-sets?accountId=${loan}`)).json();
  assert.equal(log.total, 6, 'create + add + correct + undo + delete + undo');
});

test('undoing an observation that changed since leaves it alone and says so', async () => {
  const savings = await manualAccount({ name: 'Testisäästö', type: 'savings' });
  const added = await planAndApply({ kind: 'add_balance_observation', accountId: savings, date: '2026-09-30', amount: 100 });
  const id = (await observations(savings)).observations[0].id;
  await planAndApply({ kind: 'correct_balance_observation', observationId: id, amount: 150 });

  const undo = await planAndApply({ kind: 'undo', changeSetId: added.id });
  assert.deepEqual(undo.exceptions, [{ reason: 'changed_since', field: 'observationBalance' }]);
  assert.equal((await observations(savings)).observations[0].balance, 150);
});

test("a manual account's balance is its latest observation: unknown before the first, never interpolated", async () => {
  const checking = importedAccount('Testikäyttötili');
  importedSnapshot(checking, '2026-07-31', 1000);
  booked(checking, '2026-09-30', -1);
  importedSnapshot(checking, '2026-09-30', 999);
  const savings = await manualAccount({ name: 'Testisäästö', type: 'savings' });
  await planAndApply({ kind: 'add_balance_observation', accountId: savings, date: '2026-08-15', amount: 100 });
  await planAndApply({ kind: 'add_balance_observation', accountId: savings, date: '2026-09-15', amount: 300 });

  const h = await history('from=2026-07-01&to=2026-09-30&interval=month');
  const at = (date: string) => h.points.find((p: { date: string }) => p.date === date);
  const bal = (date: string) => at(date).accounts.find((a: { accountId: string }) => a.accountId === savings).balance;
  assert.equal(bal('2026-07-31'), null, 'before the first observation: unknown, not zero');
  assert.equal(at('2026-07-31').isComplete, false);
  assert.deepEqual(at('2026-07-31').coverage.missingAccountIds, [savings]);
  assert.equal(at('2026-07-31').netWorth, 1000);
  assert.equal(bal('2026-08-31'), 100, 'the latest observation holds; no estimate towards the next one');
  assert.equal(bal('2026-09-30'), 300);
  assert.equal(at('2026-09-30').netWorth, 1299);
  assert.equal(at('2026-09-30').isComplete, true);
  const meta = h.accounts.find((a: { id: string }) => a.id === savings);
  assert.equal(meta.tracking, 'manual');
  assert.equal(meta.knownFrom, '2026-08-15');
  assert.equal(meta.knownUntil, null);
});

test('net worth counts the ownership share of assets and debts; cash flow does not', async () => {
  const checking = importedAccount('Testikäyttötili', 'checking', { share: 50 });
  importedSnapshot(checking, '2026-09-30', 2000);
  booked(checking, '2026-09-29', -100);
  const loan = await manualAccount({ name: 'Yhteislaina', type: 'loan', ownershipShare: 50 });
  const home = await manualAccount({ name: 'Yhteiskoti', type: 'property', ownershipShare: 50 });
  await planAndApply({ kind: 'add_balance_observation', accountId: loan, date: '2026-09-01', amount: 100000 });
  await planAndApply({ kind: 'add_balance_observation', accountId: home, date: '2026-09-01', amount: 150000 });

  const point = (await history('from=2026-09-30&to=2026-09-30&interval=day')).points[0];
  assert.equal(point.assets, 1000 + 75000);
  assert.equal(point.liabilities, 50000);
  assert.equal(point.netWorth, 26000);
  const loanRow = point.accounts.find((a: { accountId: string }) => a.accountId === loan);
  assert.equal(loanRow.balance, -100000, 'the account’s balance is whole');
  assert.equal(loanRow.ownedBalance, -50000);

  const nw = await netWorth();
  assert.equal(nw.netWorth, 26000);
  assert.equal(nw.currency, 'EUR');

  // Cash flow and the runway ignore shares, loans and property.
  const summary = getSummary('2026-09-30');
  assert.equal(summary.monthlyNet, -100);
  assert.equal(summary.totalBalance, 2000);
  assert.equal(summary.runwayMonths, 20);
});

test('accounts in another currency are never converted or added to the EUR totals', async () => {
  const savings = await manualAccount({ name: 'Testisäästö', type: 'savings' });
  const foreign = await manualAccount({ name: 'Ulkomaantili', type: 'savings', currency: 'SEK' });
  await planAndApply({ kind: 'add_balance_observation', accountId: savings, date: '2026-09-01', amount: 100 });
  await planAndApply({ kind: 'add_balance_observation', accountId: foreign, date: '2026-09-01', amount: 5000 });

  const nw = await netWorth();
  assert.equal(nw.netWorth, 100);
  assert.deepEqual(nw.coverage.includedAccountIds, [savings]);
  assert.equal(nw.otherCurrencies.length, 1);
  assert.equal(nw.otherCurrencies[0].currency, 'SEK');
  assert.equal(nw.otherCurrencies[0].netWorth, 5000);
  assert.equal(nw.isComplete, true);

  const point = (await history('from=2026-09-30&to=2026-09-30&interval=day')).points[0];
  assert.equal(point.netWorth, 100);
  assert.equal(point.otherCurrencies[0].netWorth, 5000);
});

test('an account whose balance is older than its update interval is stale, and still counted', async () => {
  const loan = await manualAccount({ name: 'Testilaina', type: 'loan', updateIntervalDays: 30 });
  const fresh = await manualAccount({ name: 'Testisäästö', type: 'savings', updateIntervalDays: 30 });
  const noInterval = await manualAccount({ name: 'Testiasunto', type: 'property' });
  await planAndApply({ kind: 'add_balance_observation', accountId: loan, date: daysBefore(today(), 40), amount: 500 });
  await planAndApply({ kind: 'add_balance_observation', accountId: fresh, date: daysBefore(today(), 30), amount: 50 });
  await planAndApply({ kind: 'add_balance_observation', accountId: noInterval, date: daysBefore(today(), 400), amount: 1 });

  const nw = await netWorth();
  const row = (id: string) => nw.accounts.find((a: { accountId: string }) => a.accountId === id);
  assert.equal(row(loan).stale, true);
  assert.equal(row(loan).ageDays, 40);
  assert.equal(row(fresh).stale, false);
  assert.equal(row(noInterval).stale, false);
  assert.deepEqual(nw.staleAccountIds, [loan]);
  assert.equal(nw.netWorth, -500 + 50 + 1);

  const list = (await inject('GET', '/accounts')).json();
  const listed = list.find((a: { id: string }) => a.id === loan);
  assert.equal(listed.balance, -500);
  assert.equal(listed.stale, true);
  assert.equal(listed.balance_age_days, 40);
  assert.equal(listed.balance_source, 'manual');
  assert.equal((await observations(loan)).stale, true);
});

test("an observation anchors an imported card's balance and is never added to the bank's", async () => {
  const card = importedAccount('Testikortti', 'credit_card');
  booked(card, '2026-09-10', -200);
  await planAndApply({ kind: 'add_balance_observation', accountId: card, date: '2026-09-10', amount: 700, note: 'korttilasku' });
  booked(card, '2026-09-20', -50);
  await planAndApply({ kind: 'add_balance_observation', accountId: card, date: '2026-09-20', amount: 760 });

  const h = await history('from=2026-09-10&to=2026-09-20&interval=day');
  const bal = (date: string) => h.points.find((p: { date: string }) => p.date === date).accounts[0].balance;
  assert.equal(bal('2026-09-10'), -700);
  assert.equal(bal('2026-09-15'), -700);
  assert.equal(bal('2026-09-20'), -760);
  assert.equal(h.points.at(-1).liabilities, 760);

  // The bookings between explain 50 of the 60 the debt grew: 10 is unexplained.
  const list = await observations(card);
  assert.equal(list.observations[0].date, '2026-09-20');
  assert.deepEqual(list.observations[0].reconciliation, {
    previousDate: '2026-09-10',
    previousBalance: -700,
    bookedSum: -50,
    bookedCount: 1,
    difference: -10,
  });
  assert.equal(list.observations[1].reconciliation, null, 'nothing before the first balance');
});

test('an import of the same day replaces the observation, and its undo then reports it', async () => {
  const checking = importedAccount('Testikäyttötili');
  const added = await planAndApply({ kind: 'add_balance_observation', accountId: checking, date: '2026-09-30', amount: 10 });
  // What the importer does for a day with a Saldo (importer.ts, INSERT OR REPLACE).
  db.prepare(
    `INSERT OR REPLACE INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, '2026-09-30', 12, 'EUR')`
  ).run(crypto.randomUUID(), new Date().toISOString(), checking);
  const undo = await planAndApply({ kind: 'undo', changeSetId: added.id });
  assert.deepEqual(undo.exceptions, [{ reason: 'observation_missing' }]);
  assert.equal((db.prepare('SELECT balance FROM balance_snapshots').get() as { balance: number }).balance, 12);
});

test('an account with observations keeps its currency and the sign meaning of its type', async () => {
  const asset = await manualAccount({ name: 'Testierä', type: 'other_asset' });
  await planAndApply({ kind: 'add_balance_observation', accountId: asset, date: '2026-09-01', amount: 100 });

  const toLoan = await plan({ kind: 'update_account', accountId: asset, type: 'loan' });
  assert.equal(toLoan.statusCode, 409);
  assert.equal(toLoan.json().error, 'account_has_observations');
  assert.equal(toLoan.json().details.field, 'type');
  const currency = await plan({ kind: 'update_account', accountId: asset, currency: 'SEK' });
  assert.equal(currency.statusCode, 409);
  assert.equal(currency.json().details.field, 'currency');
  // A type on the same side of the sign is fine.
  assert.equal((await plan({ kind: 'update_account', accountId: asset, type: 'property' })).statusCode, 200);
});

test("a manual account's balance is only corrected by observations, never by an adjustment", async () => {
  const savings = await manualAccount({ name: 'Testisäästö', type: 'savings' });
  await planAndApply({ kind: 'add_balance_observation', accountId: savings, date: '2026-09-01', amount: 100 });
  const res = await inject('POST', '/balance-adjustments', { accountId: savings, date: '2026-09-01', amount: 5 });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'account_manual');
});

test('the web UI adds, corrects and deletes observations as change sets with its actor', async () => {
  const card = await manualAccount({ name: 'Testikortti', type: 'credit_card' });
  const add = await app.inject({ method: 'POST', url: `/accounts/${card}/balance-observations`, payload: { date: '2026-09-01', amount: 300 } });
  assert.equal(add.statusCode, 200, add.body);
  assert.equal(add.json().actor, 'user');
  const id = (await observations(card)).observations[0].id;
  assert.equal((await observations(card)).observations[0].balance, -300);

  const patch = await app.inject({ method: 'PATCH', url: `/balance-observations/${id}`, payload: { amount: 250, date: '2026-09-02' } });
  assert.equal(patch.statusCode, 200, patch.body);
  const obs = (await observations(card)).observations[0];
  assert.equal(obs.balance, -250);
  assert.equal(obs.date, '2026-09-02');

  const del = await app.inject({ method: 'DELETE', url: `/balance-observations/${id}` });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal((await observations(card)).observations.length, 0);
});

test('an archived account is out of net worth', async () => {
  const savings = await manualAccount({ name: 'Testisäästö', type: 'savings' });
  await planAndApply({ kind: 'add_balance_observation', accountId: savings, date: '2026-09-01', amount: 100 });
  await inject('POST', `/accounts/${savings}/archive`);
  const nw = await netWorth();
  assert.equal(nw.accounts.length, 0);
  assert.equal(nw.netWorth, null);
  const point = (await history('from=2026-09-30&to=2026-09-30&interval=day')).points[0];
  assert.equal(point.accounts.length, 0);
});

test('the runway counts only cash accounts, whatever an imported account is typed', async () => {
  const checking = importedAccount('Testikäyttötili');
  importedSnapshot(checking, '2026-09-30', 1000);
  booked(checking, '2026-09-29', -500);
  const mortgage = importedAccount('Testiasuntolaina', 'loan');
  importedSnapshot(mortgage, '2026-09-30', -90000);
  const fund = importedAccount('Testirahasto', 'investment');
  importedSnapshot(fund, '2026-09-30', 50000);

  const summary = getSummary('2026-09-30');
  assert.equal(summary.totalBalance, 1000);
  assert.equal(summary.runwayMonths, 2);
  assert.equal(summary.accounts.length, 3, 'every imported account is still listed');
});
