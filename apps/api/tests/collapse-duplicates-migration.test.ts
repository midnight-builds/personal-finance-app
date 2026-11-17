import './setup/testDb.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { db, initDb } from '../src/db.js';
import { applyNow, plan } from '../src/categorization.js';
import { ledgerEntries } from '../src/ledger.js';
import { listTransactions } from '../src/query.js';
import { resetDb } from './setup/resetDb.js';

// Databases from before "a transaction is stored once" hold every re-imported
// row a second time, grouped with the first copy through transaction_group_id.
// Starting the API collapses each group into its canonical row (the earliest
// imported) and drops the grouping columns.

const categoryId = (name: string) =>
  (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string }).id;
const FOOD = () => categoryId('Ruoka ja päivittäistavarat');
const FUN = () => categoryId('Viihde ja harrastukset');
const INSURANCE = () => categoryId('Vakuutukset');
const CAR = () => categoryId('Auto ja liikkuminen');

const T = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString();

/** Rebuilds the transaction tables as they were before the change (empty), foreign keys included. */
function oldSchema() {
  db.exec(`
    DROP TABLE normalized_transactions;
    CREATE TABLE normalized_transactions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      raw_transaction_id TEXT UNIQUE,
      import_session_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      booking_date TEXT,
      transaction_date TEXT,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      counterparty_name TEXT,
      counterparty_iban TEXT,
      description TEXT,
      transaction_group_id TEXT,
      FOREIGN KEY(raw_transaction_id) REFERENCES raw_transactions(id),
      FOREIGN KEY(import_session_id) REFERENCES import_sessions(id),
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    CREATE INDEX idx_normalized_group ON normalized_transactions(transaction_group_id);
    CREATE TABLE transaction_groups (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      canonical_transaction_id TEXT
    );
    CREATE INDEX idx_transaction_groups_canonical ON transaction_groups(canonical_transaction_id);
  `);
}

function account(name: string) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, type) VALUES (?, ?, ?, ?)').run(id, T(0), name, 'bank');
  return id;
}

function session(createdAt: string) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format) VALUES (?, ?, ?, ?)').run(id, createdAt, 'nordea', 'csv');
  return id;
}

function row(opts: { session: string; account: string; createdAt: string; day: string; amount: number; counterparty: string; group?: string }) {
  const id = crypto.randomUUID();
  const raw = crypto.randomUUID();
  const date = `${opts.day}T00:00:00.000Z`;
  db.prepare('INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    raw,
    opts.createdAt,
    opts.session,
    '{}',
    date,
    opts.amount,
    'EUR'
  );
  db.prepare(
    `INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date,
       amount, currency, counterparty_name, transaction_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?)`
  ).run(id, opts.createdAt, raw, opts.session, opts.account, date, date, opts.amount, opts.counterparty, opts.group ?? null);
  return id;
}

/** An overlapping import's pair: the first import's row (canonical) and its later copy. */
function pair(opts: { s1: string; s2: string; account: string; day: string; amount: number; counterparty: string }) {
  const group = crypto.randomUUID();
  const canonical = row({ ...opts, session: opts.s1, createdAt: T(1), group });
  const copy = row({ ...opts, session: opts.s2, createdAt: T(2), group });
  db.prepare('INSERT INTO transaction_groups (id, created_at, canonical_transaction_id) VALUES (?, ?, ?)').run(group, T(2), canonical);
  return { canonical, copy };
}

function decide(txId: string, category: string, source: string, createdAt: string) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO categorization_decisions (id, created_at, transaction_id, category_id, source) VALUES (?, ?, ?, ?, ?)').run(
    id,
    createdAt,
    txId,
    category,
    source
  );
  return id;
}

function link(from: string, to: string) {
  db.prepare('INSERT INTO transfer_links (id, created_at, from_transaction_id, to_transaction_id, confidence) VALUES (?, ?, ?, ?, 95)').run(
    crypto.randomUUID(),
    T(3),
    from,
    to
  );
}

const count = (sql: string, ...params: string[]) => Number((db.prepare(sql).get(...params) as { n: number }).n);
const history = (txId: string) =>
  db
    .prepare('SELECT id, category_id, source, created_at FROM categorization_decisions WHERE transaction_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(txId)
    .map((r) => ({ ...r })) as Array<{ id: string; category_id: string; source: string; created_at: string }>;
const columns = (table: string) =>
  (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name);

beforeEach(() => {
  resetDb();
  oldSchema();
});

test('a fresh database has no grouping columns', () => {
  resetDb();
  initDb();
  assert.ok(!columns('normalized_transactions').includes('transaction_group_id'));
  assert.equal(columns('transaction_groups').length, 0);
});

test('collapses every duplicate group into its canonical row, keeping categories, transfers and undo', () => {
  const checking = account('Käyttötili');
  const savings = account('Säästötili');
  const s1 = session(T(1));
  const s2 = session(T(2));

  // A rule chose the category on the first copy; later the user picked one
  // by hand on the second copy in the transaction list: manual beats rule.
  const shop = pair({ s1, s2, account: checking, day: '2026-09-03', amount: -12.5, counterparty: 'Kauppa Esimerkki' });
  const shopRule = decide(shop.canonical, FOOD(), 'rule', T(10));
  const shopCopyRule = decide(shop.copy, FOOD(), 'rule', T(11));
  const shopManual = decide(shop.copy, FUN(), 'user', T(20));

  // A manual choice on the canonical row; the copy has older history and a
  // newer rule decision, which must not win.
  const gym = pair({ s1, s2, account: checking, day: '2026-09-04', amount: -30, counterparty: 'Kuntosali Esimerkki' });
  const gymOld = decide(gym.copy, INSURANCE(), 'rule', T(5));
  const gymManual = decide(gym.canonical, FUN(), 'user', T(30));
  decide(gym.copy, INSURANCE(), 'rule', T(40));

  // A copy linked as a transfer; the other side is a single row.
  const out = pair({ s1, s2, account: checking, day: '2026-09-05', amount: -100, counterparty: 'Oma säästötili' });
  const into = row({ session: s1, account: savings, createdAt: T(1), day: '2026-09-05', amount: 100, counterparty: 'Oma käyttötili' });
  link(out.copy, into);

  // Both sides duplicated and both copies linked: one link remains.
  const out2 = pair({ s1, s2, account: checking, day: '2026-09-06', amount: -50, counterparty: 'Oma säästötili' });
  const into2 = pair({ s1, s2, account: savings, day: '2026-09-06', amount: 50, counterparty: 'Oma käyttötili' });
  link(out2.canonical, into2.canonical);
  link(out2.copy, into2.copy);

  // A transaction imported once is not touched.
  const single = row({ session: s2, account: checking, createdAt: T(2), day: '2026-09-07', amount: -8, counterparty: 'Kioski Esimerkki' });
  decide(single, FOOD(), 'rule', T(10));

  // A change set that moved both copies, and one that moved only the copy.
  const fuel = pair({ s1, s2, account: checking, day: '2026-09-08', amount: -60, counterparty: 'Asema Esimerkki' });
  decide(fuel.canonical, FOOD(), 'rule', T(10));
  decide(fuel.copy, FOOD(), 'rule', T(11));
  const both = applyNow({ kind: 'recategorize', transactionIds: [fuel.canonical, fuel.copy], categoryId: CAR() }, 'user');
  const kiosk = pair({ s1, s2, account: checking, day: '2026-09-09', amount: -3, counterparty: 'Kioski Toinen' });
  decide(kiosk.canonical, FOOD(), 'rule', T(10));
  const onlyCopy = applyNow({ kind: 'recategorize', transactionIds: [kiosk.copy], categoryId: FUN() }, 'user');
  // A set that moved only the copy, after which the canonical row got a newer manual choice.
  const tea = pair({ s1, s2, account: checking, day: '2026-09-10', amount: -2, counterparty: 'Teehuone Esimerkki' });
  decide(tea.canonical, FOOD(), 'rule', T(10));
  const teaCopySet = applyNow({ kind: 'recategorize', transactionIds: [tea.copy], categoryId: FUN() }, 'user');
  decide(tea.canonical, INSURANCE(), 'user', '2099-01-01T00:00:00.000Z');

  // A finding pointing at both copies.
  db.prepare(
    `INSERT INTO insight_findings (id, created_at, finding_type, title, description, transaction_ids)
     VALUES ('f1', ?, 'one_off', 'Iso osto', 'Kuvaus', ?)`
  ).run(T(3), JSON.stringify([shop.copy, shop.canonical, single]));

  const copies = [shop, gym, out, out2, into2, fuel, kiosk, tea].map((p) => p.copy);
  const rawOfCopies = copies.map(
    (id) => (db.prepare('SELECT raw_transaction_id AS r FROM normalized_transactions WHERE id = ?').get(id) as { r: string }).r
  );
  const rowsBefore = count('SELECT COUNT(*) AS n FROM normalized_transactions');

  initDb();

  // One row per real transaction; the copies and their raw rows are gone.
  assert.equal(count('SELECT COUNT(*) AS n FROM normalized_transactions'), rowsBefore - copies.length);
  for (const id of copies) assert.equal(count('SELECT COUNT(*) AS n FROM normalized_transactions WHERE id = ?', id), 0);
  for (const id of rawOfCopies) assert.equal(count('SELECT COUNT(*) AS n FROM raw_transactions WHERE id = ?', id), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM import_sessions'), 2, 'import sessions are kept');
  assert.ok(!columns('normalized_transactions').includes('transaction_group_id'));
  assert.equal(columns('transaction_groups').length, 0);

  // No decision points at a removed row.
  assert.equal(
    count('SELECT COUNT(*) AS n FROM categorization_decisions WHERE transaction_id NOT IN (SELECT id FROM normalized_transactions)'),
    0
  );
  // The manual choice made on the copy is kept, with its history on top and
  // the canonical row's older rule decision below it, timestamps intact.
  assert.deepEqual(
    history(shop.canonical).map((d) => [d.id, d.created_at]),
    [
      [shopManual, T(20)],
      [shopCopyRule, T(11)],
      [shopRule, T(10)],
    ]
  );
  // The canonical row's manual choice stays; the copy's older decision goes
  // below it and its newer rule decision is dropped.
  assert.deepEqual(
    history(gym.canonical).map((d) => [d.id, d.created_at]),
    [
      [gymManual, T(30)],
      [gymOld, T(5)],
    ]
  );
  // Manual still beats a rule: a rule run leaves the manual row alone.
  const rerun = plan({ kind: 'create_rule', categoryId: INSURANCE(), pattern: 'kuntosali', matchField: 'counterparty' });
  assert.equal(rerun.summary.rowsChanged, 0);
  assert.deepEqual(rerun.exceptions, [{ transactionId: gym.canonical, reason: 'manual_decision' }]);

  // Transfer links moved onto the canonical rows, without duplicates.
  const links = db.prepare('SELECT from_transaction_id AS f, to_transaction_id AS t FROM transfer_links ORDER BY rowid').all().map((r) => ({ ...r }));
  assert.deepEqual(links, [
    { f: out.canonical, t: into },
    { f: out2.canonical, t: into2.canonical },
  ]);
  const shown = ledgerEntries({ includeTransfers: true });
  assert.equal(shown.length, rowsBefore - copies.length);
  assert.deepEqual(
    shown.filter((e) => e.isTransfer).map((e) => e.id).sort(),
    [out.canonical, into, out2.canonical, into2.canonical].sort()
  );

  // The finding points at the canonical row once.
  const finding = db.prepare("SELECT transaction_ids AS ids FROM insight_findings WHERE id = 'f1'").get() as { ids: string };
  assert.deepEqual(JSON.parse(finding.ids), [shop.canonical, single]);

  // Change sets list each transaction once and can still be undone.
  const payload = (id: string) =>
    JSON.parse((db.prepare('SELECT payload FROM change_sets WHERE id = ?').get(id) as { payload: string }).payload);
  assert.deepEqual(payload(both.id).op.transactionIds, [fuel.canonical]);
  assert.deepEqual(payload(both.id).rows.map((r: { transactionId: string }) => r.transactionId), [fuel.canonical]);
  const undoBoth = plan({ kind: 'undo', changeSetId: both.id });
  assert.equal(undoBoth.summary.rowsChanged, 1);
  assert.deepEqual(undoBoth.exceptions, []);
  applyNow({ kind: 'undo', changeSetId: both.id }, 'user');
  assert.equal(history(fuel.canonical)[0].category_id, FOOD());

  // A set that moved only the copy by hand: its choice won, so the set's
  // decision is the row's latest; the copy had no category before.
  assert.deepEqual(payload(onlyCopy.id).rows.map((r: { transactionId: string }) => r.transactionId), [kiosk.canonical]);
  assert.equal(history(kiosk.canonical)[0].category_id, FUN());
  const undoCopy = plan({ kind: 'undo', changeSetId: onlyCopy.id });
  assert.equal(undoCopy.summary.rowsChanged, 0);
  assert.deepEqual(undoCopy.exceptions, [{ transactionId: kiosk.canonical, reason: 'no_previous_category' }]);
  // A set that moved only the copy, overtaken by a newer manual choice on
  // the canonical row: undo leaves the row alone and says why.
  assert.equal(history(tea.canonical)[0].category_id, INSURANCE());
  const undoTea = plan({ kind: 'undo', changeSetId: teaCopySet.id });
  assert.equal(undoTea.summary.rowsChanged, 0);
  assert.deepEqual(undoTea.exceptions, [{ transactionId: tea.canonical, reason: 'changed_since' }]);

  // What changed is on record.
  const logged = db.prepare("SELECT payload FROM event_log WHERE type = 'migration.collapse_duplicates'").get() as { payload: string };
  const report = JSON.parse(logged.payload);
  assert.equal(report.groups, 8);
  assert.equal(report.removedTransactions, 8);
  assert.deepEqual(
    report.manualFromCopy.map((m: { transactionId: string; categoryAfter: string }) => [m.transactionId, m.categoryAfter]).sort(),
    [
      [shop.canonical, FUN()],
      [kiosk.canonical, FUN()],
    ].sort()
  );
  assert.ok(report.droppedDecisions.every((d: { source: string; transactionId: string }) => d.source !== 'user' || d.transactionId === tea.copy || d.transactionId === fuel.copy));

  // Running again changes nothing.
  const snapshot = () =>
    JSON.stringify([
      db.prepare('SELECT * FROM normalized_transactions ORDER BY id').all(),
      db.prepare('SELECT * FROM categorization_decisions ORDER BY id').all(),
      db.prepare('SELECT * FROM transfer_links ORDER BY id').all(),
      db.prepare('SELECT * FROM change_sets ORDER BY id').all(),
    ]);
  const after = snapshot();
  initDb();
  assert.equal(snapshot(), after);
});

test('a canonical row without a decision takes a manual choice made on its copy, not a rule one', () => {
  const checking = account('Käyttötili');
  const s1 = session(T(1));
  const s2 = session(T(2));
  const manual = pair({ s1, s2, account: checking, day: '2026-09-03', amount: -5, counterparty: 'Kauppa Esimerkki' });
  decide(manual.copy, FOOD(), 'user', T(10));
  const rule = pair({ s1, s2, account: checking, day: '2026-09-04', amount: -6, counterparty: 'Kauppa Toinen' });
  decide(rule.copy, FOOD(), 'rule', T(10));
  initDb();
  assert.deepEqual(history(manual.canonical).map((d) => [d.category_id, d.source]), [[FOOD(), 'user']]);
  assert.deepEqual(history(rule.canonical), [], 'the reports showed it uncategorized');
});

test('a canonical row and its copy linked to different rows keep both links', () => {
  const checking = account('Käyttötili');
  const savings = account('Säästötili');
  const s1 = session(T(1));
  const s2 = session(T(2));
  const out = pair({ s1, s2, account: checking, day: '2026-09-05', amount: -100, counterparty: 'Oma säästötili' });
  const x = row({ session: s1, account: savings, createdAt: T(1), day: '2026-09-05', amount: 100, counterparty: 'Oma käyttötili' });
  const y = row({ session: s2, account: savings, createdAt: T(2), day: '2026-09-06', amount: 100, counterparty: 'Oma käyttötili' });
  link(out.canonical, x);
  link(out.copy, y);
  initDb();
  const links = db.prepare('SELECT from_transaction_id AS f, to_transaction_id AS t FROM transfer_links ORDER BY rowid').all().map((r) => ({ ...r }));
  assert.deepEqual(links, [
    { f: out.canonical, t: x },
    { f: out.canonical, t: y },
  ]);
  assert.ok(ledgerEntries({ includeTransfers: true }).every((e) => e.isTransfer));
  assert.equal(listTransactions().filter((t: { id: string }) => t.id === out.canonical).length, 1, 'listed once');
  const report = JSON.parse(
    (db.prepare("SELECT payload FROM event_log WHERE type = 'migration.collapse_duplicates'").get() as { payload: string }).payload
  );
  assert.equal(report.transactionsInSeveralLinks, 1);
});

test('a failing migration leaves the old state in place', () => {
  const checking = account('Käyttötili');
  const s1 = session(T(1));
  const s2 = session(T(2));
  const p = pair({ s1, s2, account: checking, day: '2026-09-03', amount: -5, counterparty: 'Kauppa Esimerkki' });
  // A change set whose payload is not JSON makes the migration throw.
  db.prepare(
    `INSERT INTO change_sets (id, created_at, actor, kind, plan_token, payload) VALUES ('bad', ?, 'user', 'recategorize', 'tok', 'not json')`
  ).run(T(3));
  assert.throws(() => initDb());
  assert.equal(count('SELECT COUNT(*) AS n FROM normalized_transactions WHERE id IN (?, ?)', p.canonical, p.copy), 2);
  assert.ok(columns('normalized_transactions').includes('transaction_group_id'));
  db.exec("DELETE FROM change_sets WHERE id = 'bad'");
});
