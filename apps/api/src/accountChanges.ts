import crypto from 'crypto';
import {
  ACCOUNT_CHANGE_MAX_LISTED_TRANSFERS,
  accountOpSchema,
  compactIban,
  type AccountChangeSet,
  type AccountChangeSetList,
  type AccountChangeSetListItem,
  type AccountException,
  type AccountFieldChange,
  type AccountOp,
  type AccountPlan,
  type AccountTracking,
  type AccountType,
  type AccountView,
  type PublicAccountOp,
  type TransferEffect,
} from '@finance-app/shared';
import { db } from './db.js';
import { DomainError } from './http/errors.js';
import {
  applyPlanned,
  inTransaction,
  insertChangeSet,
  keyedToken,
  listChangeSetRows,
  readChangeSet,
  stableJson,
  undoneById,
  type ChangeSetRow,
} from './changeSets.js';
import { notVoid } from './sql/transactions.js';

// Account change sets (GLOSSARY.md, "Account", "Transfer to a manual account";
// docs/MCP.md): creating a manual account, changing an account's name, type,
// share, currency, IBAN or update interval, archiving a manual account, and
// undoing any of these. Planned first, applied with the plan's token, recorded
// with the actor, undoable as a whole (changeSets.ts).
//
// The IBAN is write-only: it is stored (and kept in the set's payload for its
// undo) but no plan, change set or account view returns it; they say only
// `recognizesTransfers`. Plan tokens are keyed hashes, so a token cannot be
// used to guess the IBAN behind it.
//
// Changing which transactions are transfers to a manual account writes no
// transaction, decision or link: the Ledger derives it from the account's IBAN
// on every read, so the plan lists the transactions whose reporting changes and
// the undo restores the IBAN, nothing else.

type AccountState = {
  name: string;
  type: AccountType;
  tracking: AccountTracking;
  ownershipShare: number;
  currency: string;
  iban: string | null;
  updateIntervalDays: number | null;
  archivedAt: string | null;
};

type StoredEffects = { recognized: TransferEffect[]; released: TransferEffect[] };

/** Stored with the change set: everything its undo needs (the IBAN only here). */
type Payload = {
  op: AccountOp;
  accountId: string;
  before: AccountState | null;
  after: AccountState;
  changes: AccountFieldChange[];
  transfers: StoredEffects;
  exceptions: AccountException[];
};

type Draft = {
  op: AccountOp;
  accountId: string | null;
  before: AccountState | null;
  after: AccountState;
  changes: AccountFieldChange[];
  transfers: StoredEffects;
  exceptions: AccountException[];
  undoOf?: string;
  deps: Record<string, unknown>;
};

/** Drafts mark an account to archive with `archivedAt: ARCHIVE_NOW`; the time is the apply's. */
const ARCHIVE_NOW = 'now';
const withArchiveTime = (s: AccountState, at: string): AccountState =>
  s.archivedAt === ARCHIVE_NOW ? { ...s, archivedAt: at } : s;

// ---------- reading state ----------

function readAccount(id: string): AccountState | undefined {
  const row = db
    .prepare(
      `SELECT name, account_subtype, tracking, ownership_share, currency, iban, update_interval_days, archived_at
       FROM accounts WHERE id = ?`
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    name: String(row.name),
    type: row.account_subtype as AccountType,
    tracking: row.tracking as AccountTracking,
    ownershipShare: Number(row.ownership_share),
    currency: String(row.currency),
    iban: (row.iban as string | null) ?? null,
    updateIntervalDays: row.update_interval_days == null ? null : Number(row.update_interval_days),
    archivedAt: (row.archived_at as string | null) ?? null,
  };
}

function requireAccount(id: string): AccountState {
  const account = readAccount(id);
  if (!account) throw new DomainError('account_not_found', 404, { accountId: id });
  return account;
}

/** True when the state makes payments to its IBAN transfers to it. */
const recognizes = (s: AccountState | null) => s !== null && s.tracking === 'manual' && s.archivedAt === null && s.iban !== null;

export function accountView(id: string, s: AccountState): AccountView {
  return {
    id,
    name: s.name,
    type: s.type,
    tracking: s.tracking,
    ownershipShare: s.ownershipShare,
    currency: s.currency,
    updateIntervalDays: s.updateIntervalDays,
    recognizesTransfers: recognizes(s),
    archivedAt: s.archivedAt,
  };
}

function nameTaken(name: string, exceptId: string | null): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM accounts WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND id != ?').get(name, exceptId ?? '')
  );
}

/** Another account (imported or manual, archived too) already has the IBAN. */
function ibanTaken(iban: string, exceptId: string | null): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM accounts WHERE REPLACE(UPPER(iban), ' ', '') = ? AND id != ?")
      .get(compactIban(iban), exceptId ?? '')
  );
}

/**
 * Booked transactions on other accounts whose counterparty IBAN is the state's
 * IBAN, i.e. the transfers to it the Ledger reports while the account is in
 * that state. Linked transfers stay linked transfers and are not listed.
 */
function transfersFor(accountId: string | null, s: AccountState | null): TransferEffect[] {
  if (!recognizes(s)) return [];
  const rows = db
    .prepare(
      `SELECT t.id, t.account_id, substr(t.booking_date, 1, 10) AS day, t.amount, t.counterparty_name
       FROM normalized_transactions t
       WHERE t.booking_date IS NOT NULL AND t.counterparty_iban IS NOT NULL
         AND REPLACE(UPPER(t.counterparty_iban), ' ', '') = ?
         AND t.account_id != ?
         AND t.id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
         AND ${notVoid('t')}
       ORDER BY t.booking_date ASC, t.id ASC`
    )
    .all(compactIban(s!.iban!), accountId ?? '') as Array<{
      id: string;
      account_id: string;
      day: string;
      amount: number;
      counterparty_name: string | null;
    }>;
  return rows.map((r) => ({
    transactionId: r.id,
    accountId: r.account_id,
    date: r.day,
    amount: Number(r.amount),
    counterpartyName: r.counterparty_name,
  }));
}

function effects(accountId: string | null, before: AccountState | null, after: AccountState): StoredEffects {
  const was = transfersFor(accountId, before);
  const will = transfersFor(accountId, after);
  const wasIds = new Set(was.map((t) => t.transactionId));
  const willIds = new Set(will.map((t) => t.transactionId));
  return {
    recognized: will.filter((t) => !wasIds.has(t.transactionId)),
    released: was.filter((t) => !willIds.has(t.transactionId)),
  };
}

const FIELDS = ['name', 'type', 'ownershipShare', 'currency', 'updateIntervalDays'] as const;

/** What differs between two states, the IBAN shown only as recognizesTransfers. */
function diff(before: AccountState, after: AccountState): AccountFieldChange[] {
  const changes: AccountFieldChange[] = [];
  for (const field of FIELDS) {
    if (before[field] !== after[field]) changes.push({ field, from: before[field], to: after[field] });
  }
  if (before.iban !== after.iban) {
    const change: AccountFieldChange = { field: 'recognizesTransfers', from: before.iban !== null, to: after.iban !== null };
    if (before.iban !== null && after.iban !== null) change.replaced = true;
    changes.push(change);
  }
  if ((before.archivedAt === null) !== (after.archivedAt === null)) {
    changes.push({ field: 'archived', from: before.archivedAt !== null, to: after.archivedAt !== null });
  }
  return changes;
}

// ---------- drafting ----------

function draftCreate(op: Extract<AccountOp, { kind: 'create_account' }>): Draft {
  if (nameTaken(op.name, null)) throw new DomainError('account_name_exists', 409, { name: op.name });
  if (op.iban && ibanTaken(op.iban, null)) throw DomainError.conflict('iban_in_use');
  const after: AccountState = {
    name: op.name,
    type: op.type,
    tracking: 'manual',
    ownershipShare: op.ownershipShare ?? 100,
    currency: op.currency ?? 'EUR',
    iban: op.iban ?? null,
    updateIntervalDays: op.updateIntervalDays ?? null,
    archivedAt: null,
  };
  const transfers = effects(null, null, after);
  return {
    op,
    accountId: null,
    before: null,
    after,
    changes: [{ field: 'created', from: null, to: op.name }],
    transfers,
    exceptions: [],
    deps: { recognized: transfers.recognized.map((t) => t.transactionId) },
  };
}

function draftUpdate(op: Extract<AccountOp, { kind: 'update_account' }>): Draft {
  const before = requireAccount(op.accountId);
  if (before.archivedAt) throw DomainError.conflict('account_archived');
  // An imported account's IBAN is how its exports find it, and its currency is the export's.
  if (before.tracking === 'imported') {
    const field = op.iban !== undefined ? 'iban' : op.currency !== undefined ? 'currency' : null;
    if (field) throw new DomainError('account_imported', 409, { field });
  }
  if (op.name !== undefined && nameTaken(op.name, op.accountId)) throw new DomainError('account_name_exists', 409, { name: op.name });
  if (op.iban && ibanTaken(op.iban, op.accountId)) throw DomainError.conflict('iban_in_use');
  const after: AccountState = {
    ...before,
    name: op.name ?? before.name,
    type: op.type ?? before.type,
    ownershipShare: op.ownershipShare ?? before.ownershipShare,
    currency: op.currency ?? before.currency,
    iban: op.iban === undefined ? before.iban : op.iban,
    updateIntervalDays: op.updateIntervalDays === undefined ? before.updateIntervalDays : op.updateIntervalDays,
  };
  const transfers = effects(op.accountId, before, after);
  return {
    op,
    accountId: op.accountId,
    before,
    after,
    changes: diff(before, after),
    transfers,
    exceptions: [],
    deps: depsOf(op.accountId, before, transfers),
  };
}

function draftArchive(op: Extract<AccountOp, { kind: 'archive_account' }>): Draft {
  const before = requireAccount(op.accountId);
  if (before.tracking === 'imported') throw DomainError.conflict('account_imported');
  if (before.archivedAt) throw DomainError.conflict('account_archived');
  const after: AccountState = { ...before, archivedAt: ARCHIVE_NOW };
  const transfers = effects(op.accountId, before, after);
  return {
    op,
    accountId: op.accountId,
    before,
    after,
    changes: diff(before, after),
    transfers,
    exceptions: [],
    deps: depsOf(op.accountId, before, transfers),
  };
}

function draftUndo(op: Extract<AccountOp, { kind: 'undo' }>): Draft {
  const set = readChangeSet('accounts', op.changeSetId);
  if (set.kind === 'undo') throw DomainError.conflict('cannot_undo_undo');
  if (set.status === 'undone') throw DomainError.conflict('already_undone');
  const payload = JSON.parse(set.payload) as Payload;
  const id = payload.accountId;
  const current = requireAccount(id);
  const after: AccountState = { ...current };
  const exceptions: AccountException[] = [];

  if (set.kind === 'create_account' || set.kind === 'archive_account') {
    // Undoing a creation archives the account (accounts are never deleted); undoing an archive brings it back.
    const archive = set.kind === 'create_account';
    if ((current.archivedAt !== null) === archive) exceptions.push({ reason: 'changed_since', field: 'archived' });
    else after.archivedAt = archive ? ARCHIVE_NOW : null;
  } else if (current.archivedAt) {
    exceptions.push({ reason: 'account_archived' });
  } else {
    const before = payload.before!;
    for (const field of FIELDS) {
      if (payload.after[field] === before[field]) continue;
      if (current[field] !== payload.after[field]) {
        exceptions.push({ reason: 'changed_since', field });
      } else if (field === 'name' && nameTaken(before.name, id)) {
        exceptions.push({ reason: 'name_exists', field });
      } else {
        (after as Record<string, unknown>)[field] = before[field];
      }
    }
    if (payload.after.iban !== before.iban) {
      if (current.iban !== payload.after.iban) exceptions.push({ reason: 'changed_since', field: 'recognizesTransfers' });
      else if (before.iban !== null && ibanTaken(before.iban, id)) exceptions.push({ reason: 'iban_in_use', field: 'recognizesTransfers' });
      else after.iban = before.iban;
    }
  }
  const transfers = effects(id, current, after);
  return {
    op,
    accountId: id,
    before: current,
    after,
    changes: diff(current, after),
    transfers,
    exceptions,
    undoOf: set.id,
    deps: { set: [set.id, set.status], ...depsOf(id, current, transfers) },
  };
}

function depsOf(accountId: string, state: AccountState, transfers: StoredEffects) {
  return {
    account: [accountId, state],
    recognized: transfers.recognized.map((t) => t.transactionId),
    released: transfers.released.map((t) => t.transactionId),
  };
}

function draftFor(op: AccountOp): Draft {
  switch (op.kind) {
    case 'create_account':
      return draftCreate(op);
    case 'update_account':
      return draftUpdate(op);
    case 'archive_account':
      return draftArchive(op);
    case 'undo':
      return draftUndo(op);
  }
}

// ---------- public shapes ----------

/** The operation without its IBAN. */
export function publicOp(op: AccountOp): PublicAccountOp {
  if (op.kind !== 'create_account' && op.kind !== 'update_account') return op;
  const { iban, ...rest } = op;
  return iban === undefined ? rest : { ...rest, recognizesTransfers: iban !== null };
}

function publicTransfers(t: StoredEffects) {
  return {
    recognized: t.recognized.slice(0, ACCOUNT_CHANGE_MAX_LISTED_TRANSFERS),
    recognizedTotal: t.recognized.length,
    released: t.released.slice(0, ACCOUNT_CHANGE_MAX_LISTED_TRANSFERS),
    releasedTotal: t.released.length,
  };
}

const tokenOf = (draft: Draft) => keyedToken({ v: 1, domain: 'accounts', op: draft.op, deps: draft.deps });

/** Works out what the operation would change now; writes nothing. Throws `ZodError` / `DomainError`. */
export function planAccountChange(input: unknown): AccountPlan {
  const op = accountOpSchema.parse(input);
  const draft = draftFor(op);
  const view = accountView('', withArchiveTime(draft.after, new Date().toISOString()));
  return {
    kind: op.kind,
    op: publicOp(op),
    account: { ...view, id: draft.accountId },
    changes: draft.changes,
    transfers: publicTransfers(draft.transfers),
    exceptions: draft.exceptions,
    planToken: tokenOf(draft),
  };
}

// ---------- applying ----------


function execute(draft: Draft, token: string, actor: string): string {
  const setId = crypto.randomUUID();
  const now = new Date().toISOString();
  const after = withArchiveTime(draft.after, now);
  let accountId = draft.accountId;
  if (accountId === null) {
    accountId = crypto.randomUUID();
    // `type` is the legacy kind column (imports write 'bank').
    db.prepare(
      `INSERT INTO accounts (id, created_at, name, iban, type, account_subtype, tracking, ownership_share, currency, update_interval_days)
       VALUES (?, ?, ?, ?, 'manual', ?, 'manual', ?, ?, ?)`
    ).run(accountId, now, after.name, after.iban, after.type, after.ownershipShare, after.currency, after.updateIntervalDays);
  } else {
    db.prepare(
      `UPDATE accounts SET name = ?, account_subtype = ?, ownership_share = ?, currency = ?, iban = ?,
              update_interval_days = ?, archived_at = ?
       WHERE id = ?`
    ).run(after.name, after.type, after.ownershipShare, after.currency, after.iban, after.updateIntervalDays, after.archivedAt, accountId);
  }
  const payload: Payload = {
    op: draft.op,
    accountId,
    before: draft.before,
    after,
    changes: draft.changes,
    transfers: draft.transfers,
    exceptions: draft.exceptions,
  };
  insertChangeSet({
    id: setId,
    createdAt: now,
    domain: 'accounts',
    actor,
    kind: draft.op.kind,
    reason: draft.op.reason ?? null,
    planToken: token,
    payload,
    undoOf: draft.undoOf ?? null,
    accountId,
  });
  return setId;
}

/**
 * Applies an operation planned with `planAccountChange` (409 `plan_stale` when
 * anything it rests on changed; the same token again returns the same set).
 */
export function applyAccountChange(input: unknown, planToken: string, actor: string): AccountChangeSet {
  const op = accountOpSchema.parse(input);
  const id = applyPlanned({
    domain: 'accounts',
    planToken,
    sameOp: (payload) => stableJson((JSON.parse(payload) as Payload).op) === stableJson(op),
    draft: () => draftFor(op),
    tokenOf,
    execute: (draft) => {
      if (draft.changes.length === 0 && draft.exceptions.length === 0) throw DomainError.conflict('nothing_to_change');
      return execute(draft, planToken, actor);
    },
  });
  return getAccountChangeSet(id);
}

/** Plans and applies at once, for the web UI's direct endpoints. */
export function applyAccountChangeNow(input: unknown, actor: string): AccountChangeSet {
  return inTransaction(() => applyAccountChange(input, planAccountChange(input).planToken, actor));
}

// ---------- reading change sets ----------

function listItem(row: ChangeSetRow, payload: Payload): AccountChangeSetListItem {
  return {
    id: row.id,
    createdAt: row.created_at,
    actor: row.actor,
    kind: row.kind as AccountChangeSetListItem['kind'],
    reason: row.reason,
    status: row.status,
    undoOfId: row.undo_of_id,
    undoneById: undoneById(row.id),
    accountId: payload.accountId,
    summary: {
      fieldsChanged: payload.changes.length,
      transfersRecognized: payload.transfers.recognized.length,
      transfersReleased: payload.transfers.released.length,
      exceptions: payload.exceptions.length,
    },
  };
}

export function getAccountChangeSet(id: string): AccountChangeSet {
  const row = readChangeSet('accounts', id);
  const payload = JSON.parse(row.payload) as Payload;
  return {
    ...listItem(row, payload),
    op: publicOp(payload.op),
    changes: payload.changes,
    transfers: publicTransfers(payload.transfers),
    exceptions: payload.exceptions,
  };
}

/** Newest first. */
export function listAccountChangeSets(params: { limit: number; offset: number; accountId?: string }): AccountChangeSetList {
  const { total, rows } = listChangeSetRows('accounts', params);
  return { total, limit: params.limit, offset: params.offset, items: rows.map((r) => listItem(r, JSON.parse(r.payload))) };
}
