import { db } from './db.js';

/**
 * `import`: the bank's balance (Saldo) from an export. `manual`: a balance
 * observation an actor stated (balanceObservations.ts), written only through
 * account change sets.
 */
export type BalanceSnapshotSource = 'import' | 'manual';

export type BalanceSnapshotRow = {
  date: string;
  balance: number;
  currency: string;
  source: BalanceSnapshotSource;
};

export function getBalanceSnapshotsForAccount(accountId: string): BalanceSnapshotRow[] {
  return db.prepare(
    'SELECT date, balance, currency, source FROM balance_snapshots WHERE account_id = ? ORDER BY date ASC'
  ).all(accountId) as BalanceSnapshotRow[];
}
