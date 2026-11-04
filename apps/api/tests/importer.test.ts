import './setup/testDb.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { initDb, seedDefaultCategories, db } from '../src/db.js';
import { checksum, processImport } from '../src/importer.js';

function clearDb() {
  db.exec(`
    DELETE FROM insight_findings;
    DELETE FROM briefing_sessions;
    DELETE FROM recurring_patterns;
    DELETE FROM pattern_confirmations;
    DELETE FROM categorization_decisions;
    DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
    DELETE FROM balance_snapshots;
    DELETE FROM balance_adjustments;
    DELETE FROM transfer_links;
    DELETE FROM transaction_groups;
    DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions;
    DELETE FROM import_sessions;
    DELETE FROM accounts;
  `);
}

function makeRecord({
  date,
  amount,
  payer = '',
  payee = '',
  name = '',
  title = '',
  message = '',
  currency = 'EUR',
}: {
  date: string;
  amount: string;
  payer?: string;
  payee?: string;
  name?: string;
  title?: string;
  message?: string;
  currency?: string;
}) {
  return {
    Kirjauspäivä: date,
    Määrä: amount,
    Maksaja: payer,
    Maksunsaaja: payee,
    Nimi: name,
    Otsikko: title,
    Viesti: message,
    Valuutta: currency,
  } as Record<string, unknown>;
}

initDb();
seedDefaultCategories();
seedDefaultCategories();

beforeEach(() => {
  clearDb();
});

test('deduplicates overlapping imports and assigns transaction groups', async () => {
  const records = [
    makeRecord({ date: '2026/01/20', amount: '-10,00', payee: 'Test Shop', payer: 'FI0011223344556677' }),
  ];
  const buf = Buffer.from('dummy');
  const hash = checksum(buf);

  const first = await processImport({
    records,
    checksum: hash,
    filename: 'Kayttotili FI00 1122 3344 5566 77.csv',
    sourceBank: 'Nordea',
    format: 'CSV',
  });

  const second = await processImport({
    records,
    checksum: hash,
    filename: 'Kayttotili FI00 1122 3344 5566 77.csv',
    sourceBank: 'Nordea',
    format: 'CSV',
  });

  assert.equal(first.overlapDetected, false);
  assert.equal(second.overlapDetected, true);

  const { c: total } = db.prepare('SELECT COUNT(*) as c FROM normalized_transactions').get() as any;
  assert.equal(total, 2);

  const { c: grouped } = db
    .prepare('SELECT COUNT(*) as c FROM normalized_transactions WHERE transaction_group_id IS NOT NULL')
    .get() as any;
  assert.equal(grouped, 2);

  const groups = db
    .prepare('SELECT DISTINCT transaction_group_id as id FROM normalized_transactions WHERE transaction_group_id IS NOT NULL')
    .all() as Array<{ id: string }>;
  assert.equal(groups.length, 1);

  const { c: groupRows } = db
    .prepare('SELECT COUNT(*) as c FROM transaction_groups WHERE id = ?')
    .get(groups[0].id) as any;
  assert.equal(groupRows, 1);

  const expected = db
    .prepare(
      'SELECT id FROM normalized_transactions WHERE transaction_group_id = ? ORDER BY created_at ASC, id ASC LIMIT 1'
    )
    .get(groups[0].id) as any;

  const canonical = db
    .prepare('SELECT canonical_transaction_id as id FROM transaction_groups WHERE id = ?')
    .get(groups[0].id) as any;

  assert.equal(canonical.id, expected.id);
});

test('links transfers across accounts with opposite amounts', async () => {
  const outRecords = [
    makeRecord({
      date: '2026/01/10',
      amount: '-100,00',
      payee: 'Friend',
      payer: 'FI-DEBIT-IBAN',
    }),
  ];
  const inRecords = [
    makeRecord({
      date: '2026/01/10',
      amount: '100,00',
      payer: 'Me',
      payee: 'FI-SAV-IBAN',
    }),
  ];

  await processImport({
    records: outRecords,
    checksum: checksum(Buffer.from('out')),
    filename: 'Debit FI-DEBIT-IBAN.csv',
    sourceBank: 'Nordea',
    format: 'CSV',
  });

  await processImport({
    records: inRecords,
    checksum: checksum(Buffer.from('in')),
    filename: 'Savings FI-SAV-IBAN.csv',
    sourceBank: 'Nordea',
    format: 'CSV',
  });

  const links = db
    .prepare('SELECT from_transaction_id, to_transaction_id FROM transfer_links')
    .all() as Array<{ from_transaction_id: string; to_transaction_id: string }>;

  assert.equal(links.length, 1);

  const from = db
    .prepare('SELECT amount FROM normalized_transactions WHERE id = ?')
    .get(links[0].from_transaction_id) as { amount: number };
  const to = db
    .prepare('SELECT amount FROM normalized_transactions WHERE id = ?')
    .get(links[0].to_transaction_id) as { amount: number };

  assert.ok(from.amount < 0);
  assert.ok(to.amount > 0);
});

test('writes balance snapshots when saldo present', async () => {
  const records = [
    {
      Kirjauspäivä: '2026/01/20',
      Määrä: '-10,00',
      Maksaja: 'FI00 1122 3344 5566 77',
      Maksunsaaja: 'Shop',
      Valuutta: 'EUR',
      Saldo: '1234,56',
    } as Record<string, unknown>,
  ];

  await processImport({
    records,
    checksum: checksum(Buffer.from('bal')),
    filename: 'Kayttotili FI00 1122 3344 5566 77.csv',
    sourceBank: 'Nordea',
    format: 'CSV',
  });

  const count = db
    .prepare('SELECT COUNT(*) as c FROM balance_snapshots')
    .get() as { c: number };
  assert.equal(count.c, 1);
});
