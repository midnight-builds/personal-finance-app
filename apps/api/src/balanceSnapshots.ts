import { db } from './db.js';

export type BalanceSnapshotRow = {
  date: string;
  balance: number;
  currency: string;
};

export function getBalanceSnapshotsForAccount(accountId: string): BalanceSnapshotRow[] {
  return db.prepare(
    'SELECT date, balance, currency FROM balance_snapshots WHERE account_id = ? ORDER BY date ASC'
  ).all(accountId) as BalanceSnapshotRow[];
}
