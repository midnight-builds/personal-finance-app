// Detection and redaction of account identifiers and personal ids in text that
// leaves the app towards external agents or public trackers.

// IBAN: country code + check digits, optional 4-letter bank code (GB, NL…), then
// 10–30 digits separated by any spaces, dots or dashes. Case-insensitive and with
// no word boundaries, so an IBAN glued to other text ("IBANFI21…", "…466x") still matches.
const IBAN = /[a-z]{2}\d{2}[\s.-]*(?:[a-z]{4}[\s.-]*)?(?:\d[\s.-]*){9,29}\d/gi;

// Old Finnish domestic account number: 123456-785, or 14 digits written without the dash.
const FI_DOMESTIC_ACCOUNT = /\b\d{6}-\d{2,8}\b|\b\d{14}\b/g;

// Finnish personal identity code (ddmmyy, century marker incl. the 2023 additions, 3 digits, check char).
const FI_PERSONAL_ID = /\b\d{6}[-+a-fu-y]\d{3}[0-9a-y]\b/gi;

const PATTERNS: readonly RegExp[] = [IBAN, FI_DOMESTIC_ACCOUNT, FI_PERSONAL_ID];

export const REDACTED = '[REDACTED]';

// Object keys that hold account or personal identifiers; such fields are dropped entirely.
const IDENTIFIER_KEY = /iban|bban|account_?(number|no)|personal_?id|ssn|hetu/i;

export function containsSensitiveId(text: string): boolean {
  return PATTERNS.some((re) => {
    re.lastIndex = 0; // global regexes are stateful across .test() calls
    return re.test(text);
  });
}

export function redactSensitiveIds(text: string): string {
  return PATTERNS.reduce((acc, re) => acc.replace(re, REDACTED), text);
}

/**
 * Deep-copies a JSON-like value, dropping identifier-named keys and redacting
 * sensitive ids inside every string.
 */
export function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveIds(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !IDENTIFIER_KEY.test(key))
        .map(([key, v]) => [key, redactDeep(v)])
    );
  }
  return value;
}
