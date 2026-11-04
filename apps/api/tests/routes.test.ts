import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { initDb, db } from '../src/db.js';
import { routes } from '../src/routes/index.js';

initDb();

const app = Fastify();
await app.register(routes);
after(() => app.close());

beforeEach(() => {
  db.exec('DELETE FROM feature_proposals;');
});

const proposal = {
  title: 'Weekly digest',
  problem: 'p',
  evidence: 'e',
  proposal: 'x',
  acceptanceCriteria: ['a'],
  source: 'hermes',
};

test('POST /feature-proposals: 201 created, 200 for duplicate, 400 with details for invalid', async () => {
  const created = await app.inject({ method: 'POST', url: '/feature-proposals', payload: proposal });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().duplicate, false);

  const dup = await app.inject({ method: 'POST', url: '/feature-proposals', payload: proposal });
  assert.equal(dup.statusCode, 200);
  assert.equal(dup.json().duplicate, true);

  const invalid = await app.inject({
    method: 'POST',
    url: '/feature-proposals',
    payload: { ...proposal, title: 'iban FI2112345600000785' },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, 'invalid_request');
  assert.ok(invalid.json().details.some((d: string) => d.startsWith('title:')));
});

test('accept/reject: decision is final (409), unknown id 404, note length validated', async () => {
  const { proposal: p } = (await app.inject({ method: 'POST', url: '/feature-proposals', payload: proposal })).json();

  const tooLong = await app.inject({ method: 'POST', url: `/feature-proposals/${p.id}/accept`, payload: { note: 'x'.repeat(1001) } });
  assert.equal(tooLong.statusCode, 400);

  const ok = await app.inject({ method: 'POST', url: `/feature-proposals/${p.id}/accept`, payload: { note: 'yes' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, 'accepted');

  const again = await app.inject({ method: 'POST', url: `/feature-proposals/${p.id}/reject`, payload: {} });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'already_resolved');

  const missing = await app.inject({ method: 'POST', url: '/feature-proposals/nope/reject', payload: {} });
  assert.equal(missing.statusCode, 404);
});

test('GET /feature-proposals validates the status filter', async () => {
  assert.equal((await app.inject({ url: '/feature-proposals?status=new' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/feature-proposals?status=bogus' })).statusCode, 400);
});

test('GET /transactions/search coerces query strings and treats empty values as absent', async () => {
  const ok = await app.inject({ url: '/transactions/search?limit=5&includeTransfers=true&minAmount=&q=' });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { total: 0, limit: 5, offset: 0, items: [] });

  for (const bad of [
    'limit=abc',
    'limit=10000',
    'limit=0x10',
    'limit=1e2',
    'limit=1.5',
    'from=2026-02-30',
    'includeTransfers=yes',
    'includeTransfers=TRUE',
    'q=a&q=b',
  ]) {
    const res = await app.inject({ url: `/transactions/search?${bad}` });
    assert.equal(res.statusCode, 400, bad);
    assert.equal(res.json().error, 'invalid_request');
  }
});

test('prototype-named query keys are ignored, not a 500', async () => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal((await app.inject({ url: `/transactions/search?${key}=1` })).statusCode, 200, key);
    assert.equal((await app.inject({ url: `/feature-proposals?${key}=1` })).statusCode, 200, key);
  }
});

test('malformed JSON body is a client error, not a 500', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/feature-proposals',
    headers: { 'content-type': 'application/json' },
    payload: '{not json',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'bad_request');
});
