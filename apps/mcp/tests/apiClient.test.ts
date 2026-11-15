import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/apiClient.js';

/** A fetch that records each request's headers and answers `{}`. */
function recordingFetch() {
  const seen: Array<{ url: string; method: string; headers: Headers }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers) });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

test('every request names the actor in X-Finance-Actor', async () => {
  const { seen, fetchImpl } = recordingFetch();
  const api = createApiClient('http://127.0.0.1:3001/', fetchImpl, { actor: 'hermes' });
  await api.get('/categories');
  await api.get('/transactions/search', { limit: 5 });
  await api.post('/categorization/plan', { op: { kind: 'create_category', name: 'Lemmikit' } });

  assert.deepEqual(
    seen.map((r) => [r.method, r.url, r.headers.get('x-finance-actor')]),
    [
      ['GET', 'http://127.0.0.1:3001/categories', 'hermes'],
      ['GET', 'http://127.0.0.1:3001/transactions/search?limit=5', 'hermes'],
      ['POST', 'http://127.0.0.1:3001/categorization/plan', 'hermes'],
    ]
  );
  assert.equal(seen[2].headers.get('content-type'), 'application/json');
});

test('without an actor no header is sent (the API then records "user")', async () => {
  const { seen, fetchImpl } = recordingFetch();
  await createApiClient('http://127.0.0.1:3001', fetchImpl).get('/categories');
  assert.equal(seen[0].headers.get('x-finance-actor'), null);
});
