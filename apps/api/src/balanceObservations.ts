import crypto from 'crypto';
import {
  balanceFromDebt,
  balanceStaleness,
  isLiabilityType,
  type AccountBalanceObservations,
  type AccountException,
  type AccountFieldChange,
  type AccountOp,
  type AccountTracking,
  type AccountType,
  type ObservationReconciliation,
  type PlannedObservation,
} from '@finance-app/shared';
import { db } from './db.js';
import { DomainError } from './http/errors.js';
import { accountBalances, today } from './ledger.js';
import { notVoid } from './sql/transactions.js';

// Balance observations (GLOSSARY.md, "Balance observation";
// docs/adr/0003-balance-observations-are-snapshots.md): a dated balance an actor
// states for an account. It is a balance snapshot with `source = 'manual'`, so
// the Ledger reads it exactly like the bank's balance (the latest one on or
// before a day wins; two are never added) and nothing is estimated between two.
// The bank's own snapshots (`source = 'import'`) are never edited here.
//
// This module reads observations and drafts the three observation operations
// of account change sets (add, correct, delete, and their undo); accountChanges.ts
// plans, applies and records them like every other account change.

type ObservationRow = {
  id: string;
  account_id: string;
  date: string;
  balance: number;
  currency: string;
  source: 'import' | 'manual';
  note: string | null;
  actor: string | null;
  created_at: string;
  updated_at: string | null;
};

const cents = (n: number) => Math.round(n * 100) / 100;

function readRow(id: string): ObservationRow | undefined {
  const row = db.prepare('SELECT * FROM balance_snapshots WHERE id = ?').get(id) as ObservationRow | undefined;
  return row ? { ...row } : undefined;
}

/** The snapshot (either source) of the account on that day, if any. */
function snapshotOn(accountId: string, date: string, exceptId: string | null = null) {
  return db
    .prepare('SELECT id, source FROM balance_snapshots WHERE account_id = ? AND substr(date, 1, 10) = ? AND id != ?')
    .get(accountId, date, exceptId ?? '') as { id: string; source: string } | undefined;
}

const debtOf = (type: string, balance: number) => (isLiabilityType(type) ? cents(Math.max(0, -balance)) : null);

function view(row: ObservationRow, type: string): PlannedObservation & { id: string; actor: string; createdAt: string } {
  return {
    id: row.id,
    accountId: row.account_id,
    date: row.date.slice(0, 10),
    balance: Number(row.balance),
    debt: debtOf(type, Number(row.balance)),
    currency: row.currency,
    note: row.note,
    actor: row.actor ?? 'system',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type AccountFacts = { type: AccountType; tracking: AccountTracking; currency: string; archivedAt: string | null };

function accountFacts(id: string): (AccountFacts & { updateIntervalDays: number | null }) | undefined {
  const row = db
    .prepare('SELECT account_subtype, tracking, currency, archived_at, update_interval_days FROM accounts WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    type: row.account_subtype as AccountType,
    tracking: row.tracking as AccountTracking,
    currency: String(row.currency),
    archivedAt: (row.archived_at as string | null) ?? null,
    updateIntervalDays: row.update_interval_days == null ? null : Number(row.update_interval_days),
  };
}

/** True when the account has observations; their sign and currency then rest on its type and currency. */
export function hasObservations(accountId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM balance_snapshots WHERE account_id = ? AND source = 'manual'").get(accountId));
}

/**
 * Checks an observation on an imported account against the account's previous
 * balance (either source) and the bookings after it, up to its own day.
 */
function reconcile(row: ObservationRow): ObservationReconciliation | null {
  const day = row.date.slice(0, 10);
  const previous = db
    .prepare(
      `SELECT substr(date, 1, 10) AS day, balance FROM balance_snapshots
       WHERE account_id = ? AND substr(date, 1, 10) < ?
       ORDER BY date DESC, created_at DESC LIMIT 1`
    )
    .get(row.account_id, day) as { day: string; balance: number } | undefined;
  if (!previous) return null;
  const booked = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount), 0) AS total, COUNT(*) AS n FROM normalized_transactions t
       WHERE t.account_id = ? AND t.booking_date IS NOT NULL
         AND substr(t.booking_date, 1, 10) > ? AND substr(t.booking_date, 1, 10) <= ?
         AND ${notVoid('t')}`
    )
    .get(row.account_id, previous.day, day) as { total: number; n: number };
  const bookedSum = cents(Number(booked.total));
  return {
    previousDate: previous.day,
    previousBalance: Number(previous.balance),
    bookedSum,
    bookedCount: Number(booked.n),
    difference: cents(Number(row.balance) - (Number(previous.balance) + bookedSum)),
  };
}

/** An account's observations (newest first), its latest balance and whether that is stale. */
export function listAccountObservations(accountId: string): AccountBalanceObservations {
  const account = accountFacts(accountId);
  if (!account) throw new DomainError('account_not_found', 404, { accountId });
  const rows = (
    db
      .prepare('SELECT * FROM balance_snapshots WHERE account_id = ? ORDER BY date DESC, created_at DESC')
      .all(accountId) as ObservationRow[]
  ).map((r) => ({ ...r }));
  const imported = rows.filter((r) => r.source !== 'manual');
  const latest = accountBalances(undefined, { includeManual: true }).find((b) => b.accountId === accountId);
  const { ageDays, stale } = balanceStaleness(latest?.date ?? null, account.updateIntervalDays, today());
  return {
    accountId,
    type: account.type,
    tracking: account.tracking,
    currency: account.currency,
    updateIntervalDays: account.updateIntervalDays,
    latest:
      latest?.balance != null && latest.date !== null
        ? {
            date: latest.date,
            balance: latest.balance,
            debt: debtOf(account.type, latest.balance),
            source: latest.source ?? 'import',
          }
        : null,
    ageDays,
    stale,
    observations: rows
      .filter((r) => r.source === 'manual')
      .map((r) => ({ ...view(r, account.type), reconciliation: account.tracking === 'imported' ? reconcile(r) : null })),
    imported: {
      count: imported.length,
      firstDate: imported.at(-1)?.date.slice(0, 10) ?? null,
      lastDate: imported[0]?.date.slice(0, 10) ?? null,
    },
  };
}

// ---------- drafting change-set operations ----------

export type ObservationOp = Extract<
  AccountOp,
  { kind: 'add_balance_observation' | 'correct_balance_observation' | 'delete_balance_observation' }
>;

/** What an observation operation (or its undo) does: the account's state is untouched. */
export type ObservationDraft = {
  accountId: string;
  before: PlannedObservation | null;
  after: PlannedObservation | null;
  /** Applying stamps the observation with the applying actor and time (not for an undo, which restores). */
  stamp: boolean;
  changes: AccountFieldChange[];
  exceptions: AccountException[];
  deps: Record<string, unknown>;
};

function usableAccount(accountId: string): AccountFacts {
  const account = accountFacts(accountId);
  if (!account) throw new DomainError('account_not_found', 404, { accountId });
  if (account.archivedAt) throw DomainError.conflict('account_archived');
  return account;
}

function requireDay(date: string) {
  if (date > today()) throw new DomainError('date_in_future', 400, { date });
}

/** 409 when another balance holds that day: correct that one instead. */
function requireFreeDay(accountId: string, date: string, exceptId: string | null) {
  const taken = snapshotOn(accountId, date, exceptId);
  if (!taken) return;
  if (taken.source === 'manual') throw new DomainError('observation_exists', 409, { observationId: taken.id, date });
  throw new DomainError('snapshot_exists', 409, { date });
}

function requireObservation(id: string): ObservationRow {
  const row = readRow(id);
  if (!row) throw new DomainError('observation_not_found', 404, { observationId: id });
  // The bank's balance is corrected with a balance adjustment, never rewritten.
  if (row.source !== 'manual') throw DomainError.conflict('snapshot_imported');
  return row;
}

const OBSERVATION_FIELDS = [
  ['date', 'observationDate'],
  ['balance', 'observationBalance'],
  ['note', 'observationNote'],
] as const;

function diff(before: PlannedObservation | null, after: PlannedObservation | null): AccountFieldChange[] {
  return OBSERVATION_FIELDS.flatMap(([key, field]) => {
    const from = before ? before[key] : null;
    const to = after ? after[key] : null;
    return from === to ? [] : [{ field, from, to }];
  });
}

function draft(accountId: string, before: PlannedObservation | null, after: PlannedObservation | null, extra: Partial<ObservationDraft> = {}): ObservationDraft {
  return {
    accountId,
    before,
    after,
    stamp: true,
    changes: diff(before, after),
    exceptions: [],
    deps: {},
    ...extra,
  };
}

/** Deps every observation plan rests on: the account, the observation and the day it goes to. */
function depsOf(accountId: string, observationId: string | null, date: string | null) {
  return {
    observationAccount: [accountId, accountFacts(accountId)],
    observation: observationId ? (readRow(observationId) ?? null) : null,
    day: date ? [date, snapshotOn(accountId, date, observationId) ?? null] : null,
  };
}

export function draftObservationOp(op: ObservationOp): ObservationDraft {
  if (op.kind === 'add_balance_observation') {
    const account = usableAccount(op.accountId);
    requireDay(op.date);
    requireFreeDay(op.accountId, op.date, null);
    const balance = cents(balanceFromDebt(account.type, op.amount));
    const after: PlannedObservation = {
      id: null,
      accountId: op.accountId,
      date: op.date,
      balance,
      debt: debtOf(account.type, balance),
      currency: account.currency,
      note: op.note ?? null,
      actor: null,
      createdAt: null,
      updatedAt: null,
    };
    return draft(op.accountId, null, after, { deps: depsOf(op.accountId, null, op.date) });
  }

  const row = requireObservation(op.observationId);
  const account = usableAccount(row.account_id);
  const before = view(row, account.type);
  if (op.kind === 'delete_balance_observation') {
    return draft(row.account_id, before, null, { deps: depsOf(row.account_id, row.id, null) });
  }
  const date = op.date ?? before.date;
  if (op.date !== undefined) {
    requireDay(date);
    requireFreeDay(row.account_id, date, row.id);
  }
  const balance = op.amount === undefined ? before.balance : cents(balanceFromDebt(account.type, op.amount));
  const after: PlannedObservation = {
    ...before,
    date,
    balance,
    debt: debtOf(account.type, balance),
    note: op.note === undefined ? before.note : op.note,
  };
  return draft(row.account_id, before, after, { deps: depsOf(row.account_id, row.id, date) });
}

/** Undoes an applied observation set: restores its `before`, unless the observation changed since. */
export function draftObservationUndo(kind: string, change: { before: PlannedObservation | null; after: PlannedObservation | null }): ObservationDraft {
  const id = (change.after ?? change.before)!.id!;
  const accountId = (change.after ?? change.before)!.accountId;
  const deps = depsOf(accountId, id, change.before?.date ?? null);
  const current = readRow(id);
  const account = accountFacts(accountId);
  const exception = (reason: string, field?: string): ObservationDraft => {
    const now = current && current.source === 'manual' ? view(current, account?.type ?? 'other_asset') : null;
    return draft(accountId, now, now, { stamp: false, changes: [], exceptions: [field ? { reason, field } : { reason }], deps });
  };
  if (!account || account.archivedAt) return exception('account_archived');

  if (kind === 'delete_balance_observation') {
    // Restore the deleted observation as it was, with its id.
    if (snapshotOn(accountId, change.before!.date, id)) return exception('date_taken', 'observationDate');
    return draft(accountId, null, change.before, { stamp: false, deps });
  }
  // add or correct: the observation must still be as the set left it.
  if (!current || current.source !== 'manual') return exception('observation_missing');
  const now = view(current, account.type);
  const changed = OBSERVATION_FIELDS.find(([key]) => now[key] !== change.after![key]);
  if (changed) return exception('changed_since', changed[1]);
  if (kind === 'add_balance_observation') return draft(accountId, now, null, { stamp: false, deps });
  if (snapshotOn(accountId, change.before!.date, id)) return exception('date_taken', 'observationDate');
  const restored = { ...change.before!, debt: debtOf(account.type, change.before!.balance) };
  return draft(accountId, now, restored, { stamp: false, deps });
}

/**
 * Writes the draft's observation and returns it as stored: an add gets its id,
 * the actor and the time; a correction the actor and time (`stamp`); an undo
 * restores the earlier observation exactly.
 */
export function writeObservation(d: ObservationDraft, actor: string, now: string): PlannedObservation | null {
  const { before, after } = d;
  if (before && !after) {
    db.prepare("DELETE FROM balance_snapshots WHERE id = ? AND source = 'manual'").run(before.id);
    return null;
  }
  if (!after) return null;
  const stored: PlannedObservation = {
    ...after,
    id: after.id ?? crypto.randomUUID(),
    actor: d.stamp ? actor : after.actor,
    createdAt: after.createdAt ?? now,
    updatedAt: d.stamp && before ? now : after.updatedAt,
  };
  if (!before) {
    db.prepare(
      `INSERT INTO balance_snapshots (id, created_at, account_id, date, balance, currency, source, note, actor, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`
    ).run(stored.id, stored.createdAt, stored.accountId, stored.date, stored.balance, stored.currency, stored.note, stored.actor, stored.updatedAt);
  } else {
    db.prepare(
      `UPDATE balance_snapshots SET date = ?, balance = ?, note = ?, actor = ?, updated_at = ?
       WHERE id = ? AND source = 'manual'`
    ).run(stored.date, stored.balance, stored.note, stored.actor, stored.updatedAt, stored.id);
  }
  return stored;
}
