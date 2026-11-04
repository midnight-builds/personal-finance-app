import './setup/testDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { queryParser } from '../src/http/query.js';

const parse = queryParser({
  n: z.number().optional(),
  flag: z.boolean().default(false),
  kind: z.enum(['a', 'b']).optional(),
  s: z.string().optional(),
});

test('coerces by field type and applies defaults', () => {
  assert.deepEqual(parse({ n: '-1.5', flag: 'true', kind: 'a', s: '42' }), { n: -1.5, flag: true, kind: 'a', s: '42' });
  assert.deepEqual(parse({}), { flag: false });
  assert.deepEqual(parse(undefined), { flag: false });
});

test('empty values are absent; unknown and prototype keys are ignored', () => {
  assert.deepEqual(parse({ n: '', s: '  ', other: 'x', constructor: '1', __proto__: '1' }), { flag: false });
});

test('rejects non-decimal numbers and non-literal booleans', () => {
  for (const n of ['0x10', '1e2', ' 1', 'abc']) assert.throws(() => parse({ n }), z.ZodError, n);
  assert.throws(() => parse({ flag: 'TRUE' }), z.ZodError);
});

test('unsupported field types fail when the parser is built, not per request', () => {
  assert.throws(() => queryParser({ tags: z.array(z.string()) }), /unsupported type "array"/);
  assert.throws(() => queryParser({ when: z.string().transform((v) => new Date(v)) }), /unsupported type "pipe"/);
});
