// Nordea's Saldo is a running balance, but an export does not promise the
// order of one day's rows. The rows of a day still form a chain: each row's
// balance before it (Saldo − amount) is another row's Saldo, except for the
// day's opening; each Saldo is another row's balance before, except for the
// day's close. The importer (closing snapshots) and the import preview
// (balance checks) both read a day's ends here, so they cannot disagree.

export type SaldoRow = { amount: number; saldo: number };

/** Euros to whole cents. */
export const cents = (n: number) => Math.round(n * 100);

/** The one value of `values` not paired with a value of `others` (multisets), if exactly one. */
function unpaired(values: number[], others: number[]): number | null {
  const left = new Map<number, number>();
  for (const o of others) left.set(o, (left.get(o) ?? 0) + 1);
  const rest = values.filter((v) => {
    const n = left.get(v) ?? 0;
    if (n > 0) left.set(v, n - 1);
    return n === 0;
  });
  return rest.length === 1 ? rest[0] : null;
}

/**
 * A day's balance before and after its rows, in cents, whatever their order.
 * Null when the chain does not decide it: e.g. a day that nets to zero
 * (100 → 110 → 100 could as well start at 110), or a row missing mid-day.
 */
export function dayEnds(rows: SaldoRow[]): { opening: number | null; close: number | null } {
  if (rows.length === 0) return { opening: null, close: null };
  const saldos = rows.map((r) => cents(r.saldo));
  const before = rows.map((r) => cents(r.saldo) - cents(r.amount));
  return { opening: unpaired(before, saldos), close: unpaired(saldos, before) };
}
