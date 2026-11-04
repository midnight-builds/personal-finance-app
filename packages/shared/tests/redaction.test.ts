import test from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, containsSensitiveId, redactDeep, redactSensitiveIds } from '../src/redaction.js';

const SENSITIVE = [
  'FI21 1234 5600 0007 85',
  'FI2112345600000785',
  'fi49 5000 9420 0287 30',
  'FI49-5000-9420-0287-30',
  'FI49  5000  9420  0287  30',
  'FI21123456 00000785',
  'SE4550000000058398257466x',
  'GB82 WEST 1234 5698 7654 32',
  'DE89 3704 0044 0532 0130 00',
  'FI21.1234.5600.0007.85',
  'IBANFI2112345600000785',
  'ref_FI2112345600000785',
  '123456-785',
  '12345600000785',
  '010190-123A',
  '010100Y123A',
  '010100B123A',
];

const HARMLESS = [
  'On 2026-10-03 spending was about 1 200 EUR, 30% above average over 12 months.',
  'viite 1234 5678',
  'K-Market Kallio',
  'Order 12345',
  'Viitenumero 1234561',
  'Invoice INV-2026-0042',
];

test('detects account numbers and personal ids in any common spelling', () => {
  for (const s of SENSITIVE) assert.equal(containsSensitiveId(`text ${s} text`), true, s);
});

test('does not flag ordinary text, dates, amounts or reference numbers', () => {
  for (const s of HARMLESS) assert.equal(containsSensitiveId(s), false, s);
});

test('repeated calls are stable despite global regex state', () => {
  for (let i = 0; i < 3; i++) assert.equal(containsSensitiveId('FI2112345600000785'), true);
});

test('redaction keeps surrounding text and spacing', () => {
  assert.equal(redactSensitiveIds('Palauta tilille fi49 5000 9420 0287 30 kiitos'), `Palauta tilille ${REDACTED} kiitos`);
  assert.equal(redactSensitiveIds('tilinro 123456-785, viite 1234 5678'), `tilinro ${REDACTED}, viite 1234 5678`);
});

test('redactDeep drops every identifier-like key', () => {
  const out = redactDeep({ accountNumber: 1, account_no: 2, personalId: 3, hetu: 4, bban: 5, name: 'Main' });
  assert.deepEqual(out, { name: 'Main' });
});

test('redactDeep drops identifier keys and redacts nested strings without mutating input', () => {
  const input = {
    iban: 'FI2112345600000785',
    items: [{ counterparty_iban: 'x', counterpartyName: 'SE4550000000058398257466', amount: -5, ok: true, none: null }],
  };
  const snapshot = structuredClone(input);
  assert.deepEqual(redactDeep(input), { items: [{ counterpartyName: REDACTED, amount: -5, ok: true, none: null }] });
  assert.deepEqual(input, snapshot);
});
