import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { db } from '../src/db.js';
import { renameCategory } from '../src/categorization.js';
import { chooseCategoryFor, upsertDecision } from '../src/rules.js';
import { resetDb } from './setup/resetDb.js';

// How a transaction gets its category from rules: user rules first, then the
// built-in keyword rules, then the fallback category. Names are fictional.

const categoryId = (name: string) =>
  (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: string }).id;
const nameOf = (id: string | null) =>
  id === null ? null : (db.prepare('SELECT name FROM categories WHERE id = ?').get(id) as { name: string }).name;
const choose = (counterparty: string, description: string, amount: number) =>
  nameOf(chooseCategoryFor({ counterparty, description, amount }));

/** A bare transaction to hang decisions on. */
function mkTx(counterparty: string) {
  const now = new Date().toISOString();
  const account = crypto.randomUUID();
  const session = crypto.randomUUID();
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at, name, type) VALUES (?, ?, ?, ?)').run(account, now, 'Testitili', 'bank');
  db.prepare('INSERT INTO import_sessions (id, created_at, source_bank, format) VALUES (?, ?, ?, ?)').run(session, now, 'Test', 'CSV');
  db.prepare(
    `INSERT INTO normalized_transactions (id, created_at, import_session_id, account_id, booking_date, amount, currency, counterparty_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, now, session, account, '2026-11-01', -10, 'EUR', counterparty);
  return id;
}

beforeEach(() => resetDb());

// Characterization: the categories the hard-coded heuristics gave before they
// moved into the database. Each row: counterparty, description, amount, expected.
const characterization: Array<[string, string, number, string]> = [
  ['Työnantaja Oy', 'Palkka marraskuu', 2500, 'Tulopuoli ja palkka'],
  ['Työnantaja Oy', 'Palkka marraskuu', -2500, 'Tulopuoli ja palkka'],
  ['Employer Ltd', 'Monthly SALARY', 1800, 'Tulopuoli ja palkka'],
  ['Payroll Services', '', -10, 'Tulopuoli ja palkka'],
  ['Verkkopuoti Oy', 'Palautus tilauksesta', 20, 'Palautukset ja hyvitykset'],
  ['Verkkopuoti Oy', 'Palautus tilauksesta', -20, 'Muut ja epäselvät'],
  ['Webshop', 'Refund', 15, 'Palautukset ja hyvitykset'],
  ['Sähköyhtiö Valo', 'Lasku', -60, 'Laskut ja sopimukset'],
  ['Sähköyhtiö Valo', 'Hyvitys', 60, 'Palautukset ja hyvitykset'],
  ['Kaukolämpö Oy', '', -80, 'Laskut ja sopimukset'],
  ['Jätehuolto Kiertävä', '', -25, 'Laskut ja sopimukset'],
  ['Mobiili Operaattori', '', -19.9, 'Laskut ja sopimukset'],
  ['Laajakaista Oy', '', -29, 'Laskut ja sopimukset'],
  ['Vakuutusyhtiö Turva', '', -40, 'Vakuutukset'],
  ['Ruokapuoti Kulma', '', -12, 'Ruoka ja päivittäistavarat'],
  ['Kulmamarket', '', -8, 'Ruoka ja päivittäistavarat'],
  ['Sähkö market', '', -8, 'Laskut ja sopimukset'],
  ['Autokorjaamo Mäki', '', -300, 'Auto ja liikkuminen'],
  ['Korjaamo', 'Huolto', -150, 'Auto ja liikkuminen'],
  ['Auto palkka', '', -5, 'Auto ja liikkuminen'],
  ['Auto palkka', '', 5, 'Tulopuoli ja palkka'],
  ['Tuntematon Oy', 'Jotain', -5, 'Muut ja epäselvät'],
  ['', '', 0, 'Muut ja epäselvät'],
];

test('the same inputs get the same categories as with the hard-coded heuristics', () => {
  for (const [counterparty, description, amount, expected] of characterization) {
    assert.equal(choose(counterparty, description, amount), expected, `${counterparty} / ${description} / ${amount}`);
  }
});

test('a user rule beats the built-in rules', () => {
  const fun = categoryId('Viihde ja harrastukset');
  upsertDecision({ transactionId: mkTx('Ruokapuoti Kulma'), categoryId: fun, source: 'user', counterparty: 'Ruokapuoti Kulma' });
  assert.equal(choose('Ruokapuoti Kulma', '', -12), 'Viihde ja harrastukset');
  assert.equal(choose('Toinen Ruokapuoti', '', -12), 'Ruoka ja päivittäistavarat');
});

test('the built-in heuristics are rules in the database', () => {
  const rows = db
    .prepare(`SELECT match_type, match_field, priority FROM category_rules WHERE builtin = 1`)
    .all() as Array<{ match_type: string; match_field: string; priority: number }>;
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.match_type, 'regex');
    assert.equal(r.match_field, 'text');
    assert.ok(r.priority < 10, 'built-in rules rank below user rules');
  }
});

test('a disabled built-in rule no longer matches', () => {
  db.prepare(
    `UPDATE category_rules SET disabled_at = ? WHERE builtin = 1 AND category_id = ?`
  ).run(new Date().toISOString(), categoryId('Vakuutukset'));
  assert.equal(choose('Vakuutusyhtiö Turva', '', -40), 'Muut ja epäselvät');
});

test('renaming a category keeps categorization working', () => {
  const food = categoryId('Ruoka ja päivittäistavarat');
  renameCategory(food, 'Ruokaostokset');
  assert.equal(chooseCategoryFor({ counterparty: 'Ruokapuoti Kulma', description: '', amount: -12 }), food);

  const income = categoryId('Tulopuoli ja palkka');
  renameCategory(income, 'Tulot');
  assert.equal(chooseCategoryFor({ counterparty: 'Työnantaja Oy', description: 'Palkka', amount: 2500 }), income);

  const misc = categoryId('Muut ja epäselvät');
  renameCategory(misc, 'Luokittelemattomat');
  assert.equal(chooseCategoryFor({ counterparty: 'Tuntematon Oy', description: '', amount: -5 }), misc);
});

test('rules match by type, field and amount sign', () => {
  const fun = categoryId('Viihde ja harrastukset');
  const insert = db.prepare(
    `INSERT INTO category_rules (id, created_at, category_id, pattern, match_field, priority, match_type, amount_sign)
     VALUES (?, ?, ?, ?, ?, 10, ?, ?)`
  );
  const now = new Date().toISOString();
  insert.run(crypto.randomUUID(), now, fun, '^kino\\b', 'text', 'regex', 'negative');
  assert.equal(choose('Kino Tähti', '', -10), 'Viihde ja harrastukset');
  assert.equal(choose('Kino Tähti', '', 10), 'Muut ja epäselvät');
  assert.equal(choose('Iso Kino', '', -10), 'Muut ja epäselvät');

  insert.run(crypto.randomUUID(), now, fun, 'LIPPU', 'description', 'contains', null);
  assert.equal(choose('Teatteri', 'konserttilippu', -30), 'Viihde ja harrastukset');
  assert.equal(choose('Lippu Oy', '', -30), 'Muut ja epäselvät', 'description rule ignores the counterparty');

  insert.run(crypto.randomUUID(), now, fun, 'puisto', 'text', 'contains', 'positive');
  assert.equal(choose('Huvipuisto', '', 5), 'Viihde ja harrastukset');
  assert.equal(choose('Huvipuisto', '', -5), 'Muut ja epäselvät');
});

test('rules of an archived category do not match', () => {
  const fun = categoryId('Viihde ja harrastukset');
  upsertDecision({ transactionId: mkTx('Kino Tähti'), categoryId: fun, source: 'user', counterparty: 'Kino Tähti' });
  db.prepare('UPDATE categories SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), fun);
  assert.equal(choose('Kino Tähti', '', -10), 'Muut ja epäselvät');
});
