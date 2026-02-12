import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.OPENAI_API_KEY = '';

import { initDb, seedDefaultCategories } from '../src/db.js';
import { aiCategorize } from '../src/ai.js';

initDb();
seedDefaultCategories();

test('aiCategorize: falls back to rules when OPENAI_API_KEY missing', async () => {
  const res = await aiCategorize({
    counterparty: 'Acme Oy',
    description: 'Palkka helmikuu',
    amount: 2500,
    currency: 'EUR',
  });

  assert.equal(res.mode, 'existing');
  if (res.mode !== 'existing') throw new Error('expected existing');
  assert.equal(res.categoryName, 'Tulopuoli ja palkka');
});
