import crypto from 'crypto';
import { db } from './db.js';
import { DomainError } from './http/errors.js';
import { today } from './ledger.js';

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

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD naming a real day (not 2026-02-30). */
export function isCalendarDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * The user's own balance for an account on a day, e.g. a credit card whose export
 * carries no Saldo. It is a snapshot like an imported one, so every Ledger view
 * uses it; a credit card's balance is negative when money is owed. A day that
 * already has a snapshot keeps it: correct that one with a balance adjustment.
 */
export function createManualBalanceSnapshot(input: { accountId: unknown; date: unknown; balance: unknown }) {
  const { accountId, date } = input;
  const balance = typeof input.balance === 'number' ? input.balance : typeof input.balance === 'string' && input.balance.trim() !== '' ? Number(input.balance) : NaN;
  if (typeof accountId !== 'string' || !accountId) throw new DomainError('account_missing', 400);
  if (typeof date !== 'string' || !isCalendarDay(date)) {
    throw new DomainError('date_invalid', 400);
  }
  if (!Number.isFinite(balance)) throw new DomainError('balance_invalid', 400);
  const account = db.prepare('SELECT tracking FROM accounts WHERE id = ?').get(accountId) as { tracking: string } | undefined;
  if (!account) throw DomainError.notFound();
  // A manual account's balance is not a snapshot: it gets dated balance observations (not yet built).
  if (account.tracking === 'manual') throw DomainError.conflict('account_manual');
  if (date > today()) throw new DomainError('date_in_future', 400);
  if (db.prepare('SELECT 1 FROM balance_snapshots WHERE account_id = ? AND substr(date, 1, 10) = ?').get(accountId, date)) {
    throw DomainError.conflict('snapshot_exists');
  }
  const latest = db
    .prepare('SELECT currency FROM balance_snapshots WHERE account_id = ? ORDER BY date DESC, created_at DESC LIMIT 1')
    .get(accountId) as { currency: string } | undefined;
  const row = {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    account_id: accountId,
    date,
    balance: Math.round(balance * 100) / 100,
    currency: latest?.currency ?? 'EUR',
    source: 'manual' as const,
  };
  db.prepare(
    `INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.created_at, row.account_id, row.date, row.balance, row.currency, row.source);
  return row;
}
