import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';

import { initDb, db } from '../src/db.js';
import {
  createFeatureProposal,
  listFeatureProposals,
  resolveFeatureProposal,
} from '../src/featureProposals.js';
import { DomainError } from '../src/http/errors.js';

initDb();

const valid = {
  title: 'Budget alerts per category',
  problem: 'Overspending in a category is only noticed at month end.',
  evidence: 'Food spending exceeded its 3-month average in 2 of the last 3 months.',
  proposal: 'Let the user set a monthly budget per category and show a warning at 80%.',
  acceptanceCriteria: ['User can set a budget per category', 'Warning appears at 80% of budget'],
  source: 'hermes',
};

beforeEach(() => {
  db.exec('DELETE FROM feature_proposals;');
});

test('createFeatureProposal stores a new proposal', () => {
  const res = createFeatureProposal(valid);
  assert.equal(res.duplicate, false);
  assert.equal(res.proposal.status, 'new');
  assert.equal(res.proposal.source, 'hermes');
  assert.deepEqual(res.proposal.acceptanceCriteria, valid.acceptanceCriteria);
  assert.equal(listFeatureProposals().length, 1);
});

test('invalid input throws ZodError and stores nothing', () => {
  assert.throws(() => createFeatureProposal({ title: 'x' }), ZodError);
  assert.throws(() => createFeatureProposal({ ...valid, evidence: 'from FI21 1234 5600 0007 85' }), ZodError);
  assert.equal(listFeatureProposals().length, 0);
});

test('same open title is returned as duplicate instead of inserted twice', () => {
  const first = createFeatureProposal(valid);
  const again = createFeatureProposal({ ...valid, title: '  budget ALERTS per   category ' });
  assert.equal(again.duplicate, true);
  assert.equal(again.proposal.id, first.proposal.id);
  assert.equal(listFeatureProposals().length, 1);
});

test('a resolved proposal no longer blocks a new one with the same title', () => {
  const first = createFeatureProposal(valid);
  resolveFeatureProposal(first.proposal.id, 'rejected', 'not now');
  assert.equal(createFeatureProposal(valid).duplicate, false);
});

test('resolveFeatureProposal records the decision and status filter works', () => {
  const { proposal } = createFeatureProposal(valid);
  const resolved = resolveFeatureProposal(proposal.id, 'accepted', 'good idea');
  assert.equal(resolved.status, 'accepted');
  assert.equal(resolved.decisionNote, 'good idea');
  assert.ok(resolved.resolvedAt);
  assert.equal(listFeatureProposals('new').length, 0);
  assert.equal(listFeatureProposals('accepted').length, 1);
});

test('decisions are final and unknown ids are reported', () => {
  const { proposal } = createFeatureProposal(valid);
  resolveFeatureProposal(proposal.id, 'accepted', 'yes');
  assert.throws(
    () => resolveFeatureProposal(proposal.id, 'rejected', 'oops'),
    (e) => e instanceof DomainError && e.code === 'already_resolved' && e.statusCode === 409
  );
  assert.equal(listFeatureProposals()[0].decisionNote, 'yes');
  assert.throws(
    () => resolveFeatureProposal('missing', 'rejected'),
    (e) => e instanceof DomainError && e.statusCode === 404
  );
});
