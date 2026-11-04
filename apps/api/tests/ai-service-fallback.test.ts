import './setup/testDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { initDb, seedDefaultCategories } from '../src/db.js';
import type { AiCategoryProvider } from '../src/ai/provider.js';
import { suggestCategory } from '../src/ai/service.js';

initDb();
seedDefaultCategories();

test('suggestCategory: provider error falls back to rules', async () => {
  const provider: AiCategoryProvider = {
    name: 'openai',
    async suggest() {
      throw new Error('boom');
    },
  };

  const res = await suggestCategory({
    enabled: true,
    provider,
    cache: null,
    req: {
      transaction: { counterparty: 'Acme Oy', description: 'Palkka helmikuu', amount: 2500, currency: 'EUR' },
      categories: [
        { id: 'c1', name: 'Tulopuoli ja palkka' },
        { id: 'c2', name: 'Muut ja epäselvät' },
      ],
      locale: 'fi-FI',
    },
  });

  assert.equal(res.meta.provider, 'rules');
  assert.equal(res.suggestion.kind, 'existing');
});
