import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
import { initDb, seedDefaultCategories, db } from '../src/db.js';
import { checksum, processImport } from '../src/importer.js';
function clearDb() {
    db.exec(`
    DELETE FROM categorization_decisions;
    DELETE FROM category_rules;
    DELETE FROM categories WHERE built_in = 0;
    DELETE FROM transfer_links;
    DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions;
    DELETE FROM import_sessions;
    DELETE FROM accounts;
  `);
}
function makeRecord({ date, amount, payer = '', payee = '', name = '', title = '', message = '', currency = 'EUR', }) {
    return {
        Kirjauspäivä: date,
        Määrä: amount,
        Maksaja: payer,
        Maksunsaaja: payee,
        Nimi: name,
        Otsikko: title,
        Viesti: message,
        Valuutta: currency,
    };
}
initDb();
seedDefaultCategories();
seedDefaultCategories();
beforeEach(() => {
    clearDb();
});
test('deduplicates overlapping imports and assigns transaction groups', () => {
    const records = [
        makeRecord({ date: '2026/01/20', amount: '-10,00', payee: 'Test Shop', payer: 'FI0011223344556677' }),
    ];
    const buf = Buffer.from('dummy');
    const hash = checksum(buf);
    const first = processImport({
        records,
        checksum: hash,
        filename: 'Kayttotili FI00 1122 3344 5566 77.csv',
        sourceBank: 'Nordea',
        format: 'CSV',
    });
    const second = processImport({
        records,
        checksum: hash,
        filename: 'Kayttotili FI00 1122 3344 5566 77.csv',
        sourceBank: 'Nordea',
        format: 'CSV',
    });
    assert.equal(first.overlapDetected, false);
    assert.equal(second.overlapDetected, true);
    const { c: total } = db.prepare('SELECT COUNT(*) as c FROM normalized_transactions').get();
    assert.equal(total, 2);
    const { c: grouped } = db
        .prepare('SELECT COUNT(*) as c FROM normalized_transactions WHERE transaction_group_id IS NOT NULL')
        .get();
    assert.equal(grouped, 2);
});
test('links transfers across accounts with opposite amounts', () => {
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
    processImport({
        records: outRecords,
        checksum: checksum(Buffer.from('out')),
        filename: 'Debit FI-DEBIT-IBAN.csv',
        sourceBank: 'Nordea',
        format: 'CSV',
    });
    processImport({
        records: inRecords,
        checksum: checksum(Buffer.from('in')),
        filename: 'Savings FI-SAV-IBAN.csv',
        sourceBank: 'Nordea',
        format: 'CSV',
    });
    const links = db
        .prepare('SELECT from_transaction_id, to_transaction_id FROM transfer_links')
        .all();
    assert.equal(links.length, 1);
    const from = db
        .prepare('SELECT amount FROM normalized_transactions WHERE id = ?')
        .get(links[0].from_transaction_id);
    const to = db
        .prepare('SELECT amount FROM normalized_transactions WHERE id = ?')
        .get(links[0].to_transaction_id);
    assert.ok(from.amount < 0);
    assert.ok(to.amount > 0);
});
