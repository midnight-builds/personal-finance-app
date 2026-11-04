import './setup/testDb.js';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';

import { initDb, db } from '../src/db.js';
import {
  createFeatureProposal,
  listFeatureProposals,
  resolveFeatureProposal,
  updateFeatureProposal,
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
  db.exec('DELETE FROM feature_proposal_events; DELETE FROM feature_proposals;');
});

test('createFeatureProposal stores a new proposal', () => {
  const res = createFeatureProposal(valid);
  assert.equal(res.duplicate, false);
  assert.equal(res.proposal.status, 'new');
  assert.equal(res.proposal.source, 'hermes');
  assert.equal(res.proposal.kind, 'feature');
  assert.equal(res.proposal.resolution, null);
  assert.deepEqual(res.proposal.history, []);
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

test('kind is stored and an accepted proposal still blocks a duplicate', () => {
  const bug = createFeatureProposal({ ...valid, title: 'Zero balance shown for missing data', kind: 'bug' });
  assert.equal(bug.proposal.kind, 'bug');
  const { proposal } = createFeatureProposal(valid);
  resolveFeatureProposal(proposal.id, 'accepted');
  const again = createFeatureProposal(valid);
  assert.equal(again.duplicate, true);
  assert.equal(again.proposal.id, proposal.id);
});

test('lifecycle: new → accepted → done keeps a history the agent can read', () => {
  const { proposal } = createFeatureProposal(valid);
  resolveFeatureProposal(proposal.id, 'accepted', 'build it');
  const done = resolveFeatureProposal(proposal.id, 'done', 'shipped', 'abc1234');
  assert.equal(done.status, 'done');
  assert.equal(done.resolution, 'abc1234');
  assert.equal(done.decisionNote, 'shipped');
  assert.deepEqual(
    done.history.map((e) => [e.status, e.note, e.resolution]),
    [
      ['accepted', 'build it', null],
      ['done', 'shipped', 'abc1234'],
    ]
  );
  assert.ok(done.history.every((e) => e.at));
  assert.deepEqual(listFeatureProposals('done')[0].history, done.history);
  assert.equal(createFeatureProposal(valid).duplicate, false);
});

test('a clear bug can go straight from new to done, but only with a resolution', () => {
  const { proposal } = createFeatureProposal({ ...valid, kind: 'bug' });
  assert.throws(
    () => resolveFeatureProposal(proposal.id, 'done', 'fixed'),
    (e) => e instanceof DomainError && e.code === 'resolution_required' && e.statusCode === 400
  );
  assert.equal(listFeatureProposals()[0].status, 'new');
  assert.equal(resolveFeatureProposal(proposal.id, 'done', null, 'https://example.test/pr/1').status, 'done');
});

test('final statuses cannot change, accepted may still be rejected, unknown ids are reported', () => {
  const { proposal } = createFeatureProposal(valid);
  resolveFeatureProposal(proposal.id, 'rejected', 'no');
  for (const decision of ['accepted', 'rejected', 'done'] as const) {
    assert.throws(
      () => resolveFeatureProposal(proposal.id, decision, 'oops', 'x'),
      (e) => e instanceof DomainError && e.code === 'invalid_transition' && e.statusCode === 409,
      decision
    );
  }
  const after = listFeatureProposals()[0];
  assert.equal(after.decisionNote, 'no');
  assert.equal(after.history.length, 1);

  const second = createFeatureProposal({ ...valid, title: 'Other' }).proposal;
  resolveFeatureProposal(second.id, 'accepted');
  assert.throws(() => resolveFeatureProposal(second.id, 'accepted'), (e) => e instanceof DomainError && e.statusCode === 409);
  assert.equal(resolveFeatureProposal(second.id, 'rejected', 'dropped').status, 'rejected');

  assert.throws(
    () => resolveFeatureProposal('missing', 'rejected'),
    (e) => e instanceof DomainError && e.statusCode === 404
  );
});

test('updateFeatureProposal edits only the given fields of an open proposal', () => {
  const { proposal } = createFeatureProposal({ ...valid, kind: 'bug' });
  assert.equal(proposal.updatedAt, null);
  const edited = updateFeatureProposal(proposal.id, {
    title: 'Budget warnings per category',
    acceptanceCriteria: ['Warning appears at 80% of budget'],
  });
  assert.equal(edited.title, 'Budget warnings per category');
  assert.deepEqual(edited.acceptanceCriteria, ['Warning appears at 80% of budget']);
  assert.equal(edited.kind, 'bug', 'omitted kind must not fall back to the default');
  assert.equal(edited.problem, valid.problem);
  assert.equal(edited.status, 'new');
  assert.ok(edited.updatedAt);
  assert.deepEqual(edited.history, []);

  resolveFeatureProposal(proposal.id, 'accepted');
  assert.equal(updateFeatureProposal(proposal.id, { kind: 'feature' }).kind, 'feature');
  assert.equal(listFeatureProposals()[0].status, 'accepted');
});

test('updateFeatureProposal validates input like create', () => {
  const { proposal } = createFeatureProposal(valid);
  assert.throws(() => updateFeatureProposal(proposal.id, {}), ZodError);
  assert.throws(() => updateFeatureProposal(proposal.id, { title: '  ' }), ZodError);
  assert.throws(() => updateFeatureProposal(proposal.id, { acceptanceCriteria: [] }), ZodError);
  assert.throws(() => updateFeatureProposal(proposal.id, { evidence: 'from FI21 1234 5600 0007 85' }), ZodError);
  assert.throws(() => updateFeatureProposal(proposal.id, { status: 'done' }), ZodError);
  assert.equal(listFeatureProposals()[0].updatedAt, null);
});

test('updateFeatureProposal refuses final statuses, unknown ids and duplicate open titles', () => {
  const { proposal } = createFeatureProposal(valid);
  const other = createFeatureProposal({ ...valid, title: 'Other' }).proposal;
  assert.throws(
    () => updateFeatureProposal(other.id, { title: ' budget alerts PER category' }),
    (e) => e instanceof DomainError && e.code === 'duplicate_title' && e.statusCode === 409
  );
  assert.equal(updateFeatureProposal(proposal.id, { title: 'Budget alerts per Category' }).title, 'Budget alerts per Category');

  resolveFeatureProposal(proposal.id, 'rejected', 'no');
  assert.equal(updateFeatureProposal(other.id, { title: 'Budget alerts per category' }).title, 'Budget alerts per category');
  assert.throws(
    () => updateFeatureProposal(proposal.id, { title: 'Changed' }),
    (e) => e instanceof DomainError && e.code === 'not_editable' && e.statusCode === 409
  );
  assert.throws(
    () => updateFeatureProposal('missing', { title: 'x' }),
    (e) => e instanceof DomainError && e.statusCode === 404
  );
});
