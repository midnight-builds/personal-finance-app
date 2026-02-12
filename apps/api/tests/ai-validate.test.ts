import test from 'node:test';
import assert from 'node:assert/strict';

import { validateAiResult } from '../src/ai.js';

const cats = [
  { id: 'c1', name: 'Ruoka' },
  { id: 'c2', name: 'Asuminen' },
];

test('validateAiResult: existing requires known categoryId', () => {
  assert.deepEqual(validateAiResult({ mode: 'existing', categoryId: 'nope', categoryName: 'X' }, cats), { mode: 'none' });
  assert.deepEqual(validateAiResult({ mode: 'existing', categoryId: 'c1', categoryName: 'Ruoka' }, cats), {
    mode: 'existing',
    categoryId: 'c1',
    categoryName: 'Ruoka',
  });
});

test('validateAiResult: options drops invalid and caps to 3', () => {
  const res = validateAiResult(
    {
      mode: 'options',
      options: [
        { categoryId: 'bad', categoryName: 'X', reason: 'no' },
        { categoryId: 'c2', categoryName: '', reason: 'rent' },
        { categoryId: 'c1', categoryName: 'Ruoka', reason: 'food' },
      ],
    },
    cats
  );

  assert.equal(res.mode, 'options');
  if (res.mode !== 'options') throw new Error('expected options');
  assert.equal(res.options.length, 2);
  assert.deepEqual(res.options[0], { categoryId: 'c2', categoryName: 'Asuminen', reason: 'rent' });
});

test('validateAiResult: unknown shape returns none', () => {
  assert.deepEqual(validateAiResult(null, cats), { mode: 'none' });
  assert.deepEqual(validateAiResult({ mode: 'wat' }, cats), { mode: 'none' });
});
