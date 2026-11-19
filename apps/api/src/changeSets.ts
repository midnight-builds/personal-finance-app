import crypto from 'crypto';
import { db } from './db.js';
import { DomainError } from './http/errors.js';

// Change sets (GLOSSARY.md, "Change set", "Plan"): the protocol every audited,
// undoable change follows, whatever it changes. A plan writes nothing and
// returns a token over the operation and the state it rests on; applying
// re-plans in one transaction, refuses a token that no longer matches (409
// `plan_stale`) and returns the existing set for a token already applied. Each
// domain (categorization.ts, accountChanges.ts) drafts and executes its own
// operations and lists, reads and undoes only its own sets.

export type ChangeSetDomain = 'categorization' | 'accounts';

export type ChangeSetRow = {
  id: string;
  created_at: string;
  actor: string;
  kind: string;
  reason: string | null;
  plan_token: string;
  payload: string;
  status: 'applied' | 'undone';
  undo_of_id: string | null;
  domain: ChangeSetDomain;
  account_id: string | null;
};

/** JSON with object keys sorted, so equal values hash equally. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

let savepoints = 0;

/** Runs fn atomically; nests (savepoints), so callers may already be in a transaction. */
export function inTransaction<T>(fn: () => T): T {
  const name = `change_set_${savepoints++}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  } finally {
    savepoints--;
  }
}

/** A set of `domain`; a missing one, or one of another domain, is 404 `change_set_not_found`. */
export function readChangeSet(domain: ChangeSetDomain, id: string): ChangeSetRow {
  const row = db.prepare('SELECT * FROM change_sets WHERE id = ? AND domain = ?').get(id, domain);
  if (!row) throw new DomainError('change_set_not_found', 404, { changeSetId: id });
  return { ...row } as ChangeSetRow;
}

export function undoneById(id: string): string | null {
  const row = db.prepare('SELECT id FROM change_sets WHERE undo_of_id = ?').get(id) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Sets of `domain`, newest first; `accountId` narrows to one account's sets. */
export function listChangeSetRows(
  domain: ChangeSetDomain,
  params: { limit: number; offset: number; accountId?: string }
): { total: number; rows: ChangeSetRow[] } {
  const where = params.accountId ? 'domain = ? AND account_id = ?' : 'domain = ?';
  const args = params.accountId ? [domain, params.accountId] : [domain];
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM change_sets WHERE ${where}`).get(...args) as { n: number }).n);
  const rows = db
    .prepare(`SELECT * FROM change_sets WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
    .all(...args, params.limit, params.offset)
    .map((r) => ({ ...r }) as ChangeSetRow);
  return { total, rows };
}

/** Records an applied set (and marks the set it undoes undone). */
export function insertChangeSet(set: {
  id: string;
  createdAt: string;
  domain: ChangeSetDomain;
  actor: string;
  kind: string;
  reason: string | null;
  planToken: string;
  payload: unknown;
  undoOf: string | null;
  accountId?: string | null;
}) {
  db.prepare(
    `INSERT INTO change_sets (id, created_at, actor, kind, reason, plan_token, payload, status, undo_of_id, domain, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', ?, ?, ?)`
  ).run(
    set.id,
    set.createdAt,
    set.actor,
    set.kind,
    set.reason,
    set.planToken,
    JSON.stringify(set.payload),
    set.undoOf,
    set.domain,
    set.accountId ?? null
  );
  if (set.undoOf) db.prepare(`UPDATE change_sets SET status = 'undone' WHERE id = ?`).run(set.undoOf);
}

/**
 * Applies a planned operation: a token already applied returns that set's id
 * (when the stored operation is the same, `sameOp`); otherwise the operation is
 * drafted again and executed only if its token is the one planned.
 */
export function applyPlanned<D>(options: {
  domain: ChangeSetDomain;
  planToken: string;
  sameOp: (storedPayload: string) => boolean;
  draft: () => D;
  tokenOf: (draft: D) => string;
  execute: (draft: D) => string;
}): string {
  return inTransaction(() => {
    const existing = db.prepare('SELECT id, payload, domain FROM change_sets WHERE plan_token = ?').get(options.planToken) as
      | { id: string; payload: string; domain: string }
      | undefined;
    if (existing) {
      if (existing.domain !== options.domain || !options.sameOp(existing.payload)) throw DomainError.conflict('plan_stale');
      return existing.id;
    }
    const draft = options.draft();
    if (options.tokenOf(draft) !== options.planToken) throw DomainError.conflict('plan_stale');
    return options.execute(draft);
  });
}

/** sha256 of the value's stable JSON. */
export function sha256Token(value: unknown): string {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

const TOKEN_KEY_SETTING = 'changeSetTokenKey';

/**
 * HMAC-SHA256 of the value's stable JSON under a random key kept in the
 * database. For plans whose state includes a secret (an account's IBAN): a
 * plain hash of a few known fields and an IBAN could be reversed by trying
 * every account number, a keyed one cannot.
 */
export function keyedToken(value: unknown): string {
  let row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(TOKEN_KEY_SETTING) as { value: string } | undefined;
  if (!row) {
    db.prepare('INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      TOKEN_KEY_SETTING,
      crypto.randomBytes(32).toString('hex'),
      new Date().toISOString()
    );
    row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(TOKEN_KEY_SETTING) as { value: string };
  }
  return crypto.createHmac('sha256', row.value).update(stableJson(value)).digest('hex');
}
