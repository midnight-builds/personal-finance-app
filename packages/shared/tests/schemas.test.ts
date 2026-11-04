import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SENSITIVE_ID_ERROR,
  featureProposalInputSchema,
  isoDate,
  transactionSearchSchema,
} from '../src/index.js';

test('isoDate accepts real dates and rejects impossible ones', () => {
  assert.equal(isoDate.safeParse('2024-02-29').success, true);
  for (const bad of ['2026-02-30', '2026-99-99', '1.2.2026', '2026-1-1']) {
    assert.equal(isoDate.safeParse(bad).success, false, bad);
  }
});

test('feature proposal schema trims, defaults source and rejects sensitive ids', () => {
  const base = {
    title: '  Budget alerts  ',
    problem: 'p',
    evidence: 'e',
    proposal: 'x',
    acceptanceCriteria: ['a'],
  };
  const ok = featureProposalInputSchema.parse(base);
  assert.equal(ok.title, 'Budget alerts');
  assert.equal(ok.source, 'agent');

  const bad = featureProposalInputSchema.safeParse({ ...base, acceptanceCriteria: ['FI2112345600000785'] });
  assert.equal(bad.success, false);
  assert.ok(!bad.success && bad.error.issues.some((i) => i.message === SENSITIVE_ID_ERROR));
});

test('transaction search schema applies defaults and limits', () => {
  assert.deepEqual(transactionSearchSchema.parse({}), {
    includeTransfers: false,
    includeDuplicates: false,
    limit: 50,
    offset: 0,
  });
  assert.equal(transactionSearchSchema.safeParse({ limit: 501 }).success, false);
  assert.equal(transactionSearchSchema.safeParse({ minAmount: Number.NaN }).success, false);
});
