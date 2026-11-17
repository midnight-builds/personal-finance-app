import './setup/testDb.js';
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { db } from '../src/db.js';
import { createFeatureProposal } from '../src/featureProposals.js';
import { routes } from '../src/routes/index.js';
import { resetDb } from './setup/resetDb.js';

const app = Fastify();
await app.register(routes);
after(() => app.close());

beforeEach(() => {
  resetDb();
  db.exec('DELETE FROM feature_proposal_events; DELETE FROM feature_proposals;');
});

const valid = {
  title: 'Budget alerts per category',
  problem: 'Overspending in a category is only noticed at month end.',
  evidence: 'Food spending exceeded its 3-month average in 2 of the last 3 months.',
  proposal: 'Let the user set a monthly budget per category and show a warning at 80%.',
  acceptanceCriteria: ['User can set a budget per category'],
  source: 'hermes',
};

test('GET /feature-proposals?changedSince filters by change time', async () => {
  const p = createFeatureProposal(valid).proposal;
  const before = await app.inject({ url: `/feature-proposals?changedSince=2000-01-01T00:00:00Z` });
  assert.equal(before.statusCode, 200);
  assert.deepEqual(before.json().map((x: { id: string }) => x.id), [p.id]);

  const none = await app.inject({ url: `/feature-proposals?changedSince=${encodeURIComponent(p.changedAt)}` });
  assert.deepEqual(none.json(), []);
});

test('GET /feature-proposals rejects a changedSince that is not a timestamp', async () => {
  const res = await app.inject({ url: '/feature-proposals?changedSince=yesterday' });
  assert.equal(res.statusCode, 400);
});
