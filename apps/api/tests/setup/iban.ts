/**
 * A Finnish-format IBAN with valid check digits for a made-up 14-digit BBAN
 * (tests only; no real account). Spaced like a bank prints it.
 */
export function testIban(bban: string): string {
  if (!/^\d{14}$/.test(bban)) throw new Error('testIban: 14 digits');
  // ISO 13616: move "FI00" to the end, letters to numbers (F=15, I=18), 98 − (n mod 97).
  let rest = 0;
  for (const d of `${bban}151800`) rest = (rest * 10 + Number(d)) % 97;
  const check = String(98 - rest).padStart(2, '0');
  const compact = `FI${check}${bban}`;
  return compact.replace(/(.{4})/g, '$1 ').trim();
}

export const compact = (iban: string) => iban.replace(/\s+/g, '');
