import './setup/testDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import type { AiCategoryProvider } from '../src/ai/provider.js';
import type { AiCategorySuggestionRequest } from '../src/ai/contract.js';
import { createInMemoryAiCache } from '../src/ai/cache.js';
import { suggestCategory } from '../src/ai/service.js';
import { initDb } from '../src/db.js';

// The rules fallback queries category tables; the test DB is in-memory (see package.json).
initDb();

test('suggestCategory: cache prevents duplicate provider calls', async () => {
  let calls = 0;
  const provider: AiCategoryProvider = {
    name: 'openai',
    async suggest(_req: AiCategorySuggestionRequest) {
      calls++;
      return {
        outputText: JSON.stringify({
          mode: 'existing',
          categoryId: 'c1',
          categoryName: 'Ruoka',
          reason: 'keyword',
        }),
      };
    },
  };

  const req: AiCategorySuggestionRequest = {
    transaction: { counterparty: 'K-Market', description: 'ostokset', amount: -12.34, currency: 'EUR' },
    categories: [
      { id: 'c1', name: 'Ruoka' },
      { id: 'c2', name: 'Asuminen' },
    ],
    locale: 'fi-FI',
  };

  const cache = createInMemoryAiCache({ max: 50 });

  const r1 = await suggestCategory({ req, provider, cache, enabled: true });
  const r2 = await suggestCategory({ req, provider, cache, enabled: true });

  assert.equal(calls, 1);
  assert.equal(r1.suggestion.kind, 'existing');
  assert.equal(r2.meta.cached, true);
});
