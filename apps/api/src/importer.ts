import crypto from 'crypto';
import { parse } from 'csv-parse/sync';
import xlsx from 'xlsx';
import { db } from './db.js';
import { logEvent } from './logger.js';
import { chooseCategoryFor, upsertDecision } from './rules.js';
import { detectPatterns } from './patterns.js';
import { runBriefing } from './briefing.js';
import { generateRuleSuggestions } from './ruleSuggestions.js';
import { canonicalGroupOrder, isCanonicalGroupRow } from './sql/transactions.js';
import { daysBefore } from './ledger.js';
import { DomainError } from './http/errors.js';
import { dayEnds, type SaldoRow } from './saldoChain.js';
import type { AccountSubtype } from '@finance-app/shared';

export type ImportResult = {
  importSessionId: string;
  accountId: string;
  normalizedCount: number;
  rawCount: number;
  skippedCount: number;
  overlapDetected: boolean;
  alreadyImportedCount: number;
  /** Rows grouped with already imported rows (overlap with earlier exports). */
  duplicateCount: number;
  /** Rows linked as one side of a transfer between own accounts. */
  transferCount: number;
  briefingSessionId?: string;
};

type RecordValue = string | number | null | undefined;

export function parseAmount(value?: RecordValue): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const normalized = value
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const amount = Number(normalized);
  return Number.isNaN(amount) ? null : amount;
}

export function parseDate(value?: RecordValue): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value && typeof value === 'object' && 'toISOString' in value) {
    try {
      return (value as Date).toISOString();
    } catch {
      // ignore
    }
  }
  if (typeof value === 'number') {
    const epoch = Date.UTC(1899, 11, 30);
    const date = new Date(epoch + value * 86400000);
    return date.toISOString();
  }
  if (value === 'Varaus') return null;

  const normalized = String(value).replace(/\./g, '/').replace(/-/g, '/');
  const parts = normalized.split('/');
  if (parts.length !== 3) return null;

  let year = Number(parts[0]);
  let month = Number(parts[1]);
  let day = Number(parts[2]);

  if (year < 100) {
    year += 2000;
  }

  if (year > 31 && month > 0 && day > 0) {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.toISOString();
  }

  const altDay = Number(parts[0]);
  const altMonth = Number(parts[1]);
  const altYear = Number(parts[2]);
  if (altYear > 31 && altMonth > 0 && altDay > 0) {
    const date = new Date(Date.UTC(altYear, altMonth - 1, altDay));
    return date.toISOString();
  }

  return null;
}

function createId(): string {
  return crypto.randomUUID();
}

export function getField(record: Record<string, unknown>, key: string): RecordValue {
  if (record[key] !== undefined && record[key] !== null) return record[key] as RecordValue;
  const bomKey = `\ufeff${key}`;
  if (record[bomKey] !== undefined && record[bomKey] !== null) return record[bomKey] as RecordValue;
  return null;
}

function ensureAccount(accountName: string, accountIban: string, now: string): string {
  // IBANs are compared without spaces or case: exports and older rows differ.
  const accountRow = accountIban
    ? (db
        .prepare("SELECT * FROM accounts WHERE REPLACE(UPPER(iban), ' ', '') = ? ORDER BY created_at ASC LIMIT 1")
        .get(accountIban.replace(/\s+/g, '').toUpperCase()) as any)
    : (db.prepare('SELECT * FROM accounts WHERE name = ?').get(accountName) as any);

  const accountId = accountRow?.id ?? createId();
  if (!accountRow) {
    db.prepare(
      'INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)'
    ).run(accountId, now, accountName, accountIban || null, 'bank');
  }

  return accountId;
}

/**
 * The account's own IBAN as the export names it: the payer of an outgoing
 * row, the payee of an incoming one. The other field names the other party,
 * which on a savings account fed from checking is the checking account in
 * every row — so counting both fields could file savings under checking.
 */
function extractIbanCandidates(records: Record<string, unknown>[]): string[] {
  const candidates: string[] = [];
  for (const record of records) {
    const amount = parseAmount(getField(record, 'Määrä'));
    if (amount === null || amount === 0) continue;
    const own = amount < 0 ? ['Maksaja', 'Maksaja '] : ['Maksunsaaja', 'Maksunsaaja '];
    for (const field of own) {
      const raw = getField(record, field);
      if (!raw || typeof raw !== 'string') continue;
      const compact = raw.replace(/\s+/g, '').toUpperCase();
      if (looksLikeIban(compact)) candidates.push(compact);
    }
  }
  return candidates;
}

function mostFrequent(arr: string[]): string | null {
  if (arr.length === 0) return null;
  const counts = new Map<string, number>();
  for (const item of arr) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [item, count] of counts.entries()) {
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  }
  return best;
}

function accountNameFromFilename(filename: string, accountIban: string | null): string {
  const match = filename.match(/^(.*?)\s*(FI\d{2}(?: ?\d{4}){3} ?\d{2})/i);
  if (match && match[1].trim()) {
    return match[1].trim();
  }
  if (accountIban) {
    return `Tili ${accountIban.slice(-4)}`;
  }
  return 'Nordea tili';
}

/**
 * Nordea lists newest first; some exports ascend. Decided by the first and
 * last booked dates of the file (all on one day reads as newest first).
 */
export function isNewestFirst(records: Record<string, unknown>[]): boolean {
  const bookedDates = records
    .map((r) => parseDate(getField(r, 'Kirjauspäivä')))
    .filter((d): d is string => d !== null);
  return bookedDates.length === 0 || bookedDates[0] >= bookedDates[bookedDates.length - 1];
}

/** The export's own IBAN (compact; '' when none) and a name for its account. */
export function inferAccount(records: Record<string, unknown>[], filename: string) {
  const ibanCandidates = extractIbanCandidates(records);
  const fromFilename = filename.match(/FI\d{2}(?: ?\d{4}){3} ?\d{2}/i)?.[0].replace(/\s+/g, '').toUpperCase() ?? null;
  const accountIban = mostFrequent(ibanCandidates) ?? fromFilename;
  const accountName = accountNameFromFilename(filename, accountIban);
  return { accountIban: accountIban ?? '', accountName };
}

function normalizeString(input: string | null | undefined): string {
  return (input ?? '').trim().toLowerCase();
}

function eqIgnoreCase(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeIban(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^FI[0-9 ]{6,}$/i.test(value.trim());
}

export function chooseCounterparty(record: Record<string, unknown>, amount: number): { name: string | null; iban: string | null } {
  const nameFields = [
    getField(record, 'Nimi'),
    getField(record, 'Otsikko'),
    getField(record, 'Viesti'),
  ]
    .filter((v) => typeof v === 'string' && v.trim().length > 0 && !looksLikeIban(v as string))
    .map((v) => (v as string).trim());

  const otherParty = amount < 0 ? getField(record, 'Maksunsaaja') : getField(record, 'Maksaja');
  const otherPartyStr = typeof otherParty === 'string' ? otherParty.trim() : '';

  const name = nameFields[0] || (looksLikeIban(otherPartyStr) ? null : otherPartyStr) || null;
  const iban = looksLikeIban(otherPartyStr) ? otherPartyStr.replace(/\s+/g, '') : null;

  return { name, iban };
}

function assignDuplicateGroup(txId: string, candidateId: string) {
  const candidate = db
    .prepare('SELECT transaction_group_id FROM normalized_transactions WHERE id = ?')
    .get(candidateId) as { transaction_group_id: string | null } | undefined;

  const current = db
    .prepare('SELECT transaction_group_id FROM normalized_transactions WHERE id = ?')
    .get(txId) as { transaction_group_id: string | null } | undefined;

  const groupId = candidate?.transaction_group_id ?? current?.transaction_group_id ?? createId();

  db.prepare('UPDATE normalized_transactions SET transaction_group_id = ? WHERE id IN (?, ?)')
    .run(groupId, txId, candidateId);

  // Ensure a corresponding transaction_groups row exists and choose canonical deterministically.
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO transaction_groups (id, created_at, canonical_transaction_id) VALUES (?, ?, NULL)'
  ).run(groupId, now);

  const canonical = db
    .prepare(
      `SELECT id FROM normalized_transactions WHERE transaction_group_id = ? ORDER BY ${canonicalGroupOrder()} LIMIT 1`
    )
    .get(groupId) as { id: string } | undefined;

  if (canonical?.id) {
    db.prepare('UPDATE transaction_groups SET canonical_transaction_id = ? WHERE id = ?').run(
      canonical.id,
      groupId
    );
  }
}

function dedupeInserted(ids: string[]) {
  for (const id of ids) {
    const row = db
      .prepare(
        'SELECT account_id, import_session_id, booking_date, amount, counterparty_name, description FROM normalized_transactions WHERE id = ?'
      )
      .get(id) as any;
    if (!row || !row.booking_date) continue;
    const candidates = db
      .prepare(
        `SELECT c.id
         FROM normalized_transactions c
         WHERE c.id != ?
           AND c.import_session_id != ?
           -- pair one-to-one: skip rows already matched by an earlier row of this import
           AND NOT EXISTS (
             SELECT 1 FROM normalized_transactions o
             WHERE c.transaction_group_id IS NOT NULL
               AND o.transaction_group_id = c.transaction_group_id
               AND o.import_session_id = ?
           )
           AND c.account_id = ?
           AND c.booking_date = ?
           AND c.amount = ?
           AND (c.counterparty_name = ? OR (c.counterparty_name IS NULL AND ? IS NULL))
         ORDER BY ${canonicalGroupOrder('c')}
         LIMIT 1`
      )
      .get(
        id,
        row.import_session_id,
        row.import_session_id,
        row.account_id,
        row.booking_date,
        row.amount,
        row.counterparty_name,
        row.counterparty_name
      ) as any;
    if (candidates) {
      assignDuplicateGroup(id, candidates.id);
    }
  }
}

/** True when `x` or a duplicate of it is already one side of a transfer. */
function isLinked(x: string) {
  return `(${x}.id IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
    OR (${x}.transaction_group_id IS NOT NULL AND ${x}.transaction_group_id IN (
      SELECT n.transaction_group_id FROM normalized_transactions n
      JOIN transfer_links l ON n.id IN (l.from_transaction_id, l.to_transaction_id)
      WHERE n.transaction_group_id IS NOT NULL)))`;
}

const normIban = (iban: string | null) => (iban ? iban.replace(/\s+/g, '').toUpperCase() : null);

type LinkSide = {
  id: string;
  account_id: string;
  counterparty_iban: string | null;
  account_iban: string | null;
  dist?: number;
};

/**
 * Pairs each new transaction with the other side of a transfer between own
 * accounts: the opposite amount on another account within two days. Each
 * transaction (and its duplicates) is in at most one transfer.
 *
 * Nordea exports name the other account's IBAN on a transfer, and a
 * merchant's name on a card payment. So:
 * - an IBAN pointing at the candidate's account is proof, and the best one;
 * - an IBAN pointing elsewhere rules the candidate out;
 * - without IBANs, an account whose export carries them elsewhere is not
 *   transferring (e.g. a purchase on one card and a refund on another);
 * - otherwise the closest day wins, and a tie between accounts is left
 *   unlinked rather than guessed.
 */
function linkTransfers(ids: string[]) {
  const sideOf = db.prepare(
    `SELECT t.id, t.account_id, t.booking_date, t.amount, t.counterparty_iban, a.iban AS account_iban
     FROM normalized_transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ? AND t.booking_date IS NOT NULL AND ${isCanonicalGroupRow('t')} AND NOT ${isLinked('t')}`
  );
  const candidatesOf = db.prepare(
    `SELECT c.id, c.account_id, c.counterparty_iban, a.iban AS account_iban,
            ABS(julianday(substr(c.booking_date, 1, 10)) - julianday(substr(?, 1, 10))) AS dist
     FROM normalized_transactions c JOIN accounts a ON a.id = c.account_id
     WHERE c.account_id != ? AND c.amount = ?
       AND c.booking_date >= ? AND c.booking_date < ?
       AND ABS(julianday(substr(c.booking_date, 1, 10)) - julianday(substr(?, 1, 10))) <= 2
       AND ${isCanonicalGroupRow('c')} AND NOT ${isLinked('c')}
     ORDER BY dist ASC, ${canonicalGroupOrder('c')}`
  );
  const carriesIbansStmt = db.prepare(
    'SELECT 1 FROM normalized_transactions WHERE account_id = ? AND counterparty_iban IS NOT NULL LIMIT 1'
  );
  const carries = new Map<string, boolean>();
  const carriesIbans = (accountId: string) => {
    if (!carries.has(accountId)) carries.set(accountId, carriesIbansStmt.get(accountId) !== undefined);
    return carries.get(accountId)!;
  };
  const insertLink = db.prepare(
    'INSERT INTO transfer_links (id, created_at, from_transaction_id, to_transaction_id, confidence) VALUES (?, ?, ?, ?, ?)'
  );

  for (const id of ids) {
    const row = sideOf.get(id) as (LinkSide & { booking_date: string; amount: number }) | undefined;
    if (!row || row.amount === 0) continue;
    // An export naming the account's own IBAN as the other party says nothing about it.
    const ownIbanAsNone = (s: LinkSide) =>
      normIban(s.counterparty_iban) === normIban(s.account_iban) ? { ...s, counterparty_iban: null } : s;
    Object.assign(row, ownIbanAsNone(row));
    // Plain string bounds (booking_date is an ISO timestamp) keep its index usable.
    const day = row.booking_date.slice(0, 10);
    const candidates = (
      candidatesOf.all(row.booking_date, row.account_id, -row.amount, daysBefore(day, 2), daysBefore(day, -3), row.booking_date) as LinkSide[]
    ).map(ownIbanAsNone);

    const pointsAt = (from: LinkSide, to: LinkSide) =>
      from.counterparty_iban !== null && normIban(from.counterparty_iban) === normIban(to.account_iban);
    const pointsElsewhere = (from: LinkSide, to: LinkSide) =>
      from.counterparty_iban !== null && normIban(from.counterparty_iban) !== normIban(to.account_iban);

    const proven = candidates.filter((c) => pointsAt(row, c) || pointsAt(c, row));
    // An account without an IBAN (a credit card) cannot be named by one. The
    // one transfer it takes part in is a repayment: money into the card from
    // an account that pays it like a bill, to the issuer's IBAN. A purchase
    // on the card, or a card-less purchase on checking, is not one.
    const isRepayment = (into: LinkSide & { amount?: number }, from: LinkSide & { amount?: number }) =>
      !into.account_iban &&
      !!from.account_iban &&
      (into.amount ?? 0) > 0 &&
      (!carriesIbans(from.account_id) || from.counterparty_iban !== null);
    const plausible = candidates.filter((c) => {
      const cand = { ...c, amount: -row.amount };
      if (!row.account_iban || !c.account_iban) return isRepayment(row, cand) || isRepayment(cand, row);
      return (
        !pointsElsewhere(row, c) &&
        !pointsElsewhere(c, row) &&
        !carriesIbans(row.account_id) &&
        !carriesIbans(c.account_id)
      );
    });

    let match: LinkSide | undefined;
    let confidence: number;
    if (proven.length > 0) {
      match = proven[0];
      confidence = 95;
    } else {
      match = plausible[0];
      confidence = 70;
      if (match && plausible.some((c) => c.dist === match!.dist && c.account_id !== match!.account_id)) continue;
    }
    if (!match) continue;

    const fromId = row.amount < 0 ? row.id : match.id;
    const toId = row.amount < 0 ? match.id : row.id;
    insertLink.run(createId(), new Date().toISOString(), fromId, toId, confidence);
  }
}

/** Where an import goes, as the user chose it. */
export type ImportTarget =
  | { accountId: string }
  | { newAccount: { name: string; subtype: AccountSubtype } };

export type ImportOptions = {
  records: Record<string, unknown>[];
  checksum: string;
  filename: string;
  sourceBank: string;
  format: string;
  /** Internal callers (demo seed, tests): the account with this IBAN, else this name; created if missing. */
  accountName?: string;
  accountIban?: string;
  /** The user's choice: an existing account (never renamed or re-IBANed), or a new one. */
  target?: ImportTarget;
  /**
   * The user confirmed a target although the file's own IBAN belongs to
   * another account (existing target with a different IBAN, or a new account
   * while the IBAN is already taken). Without it those are refused.
   */
  allowIbanMismatch?: boolean;
};

/** What the import's transactional part did, or in a dry run would do. */
export type ImportCounts = {
  importSessionId: string;
  accountId: string;
  normalizedCount: number;
  skippedCount: number;
  /** Rows of this import grouped with already imported rows. */
  duplicateCount: number;
  /** Day range of those rows. */
  overlap: { from: string; to: string } | null;
  /** Rows of this import linked as one side of a transfer. */
  transferCount: number;
  overlapDetected: boolean;
  alreadyImportedCount: number;
};

type AccountPlan =
  | { kind: 'existing'; accountId: string; iban: string | null }
  | { kind: 'new'; name: string; subtype: AccountSubtype; iban: string | null }
  | { kind: 'ensure'; name: string; iban: string };

const compactIban = (iban: string) => iban.replace(/\s+/g, '').toUpperCase();

/** The account holding `iban` (compared without spaces or case), if any. */
export function accountIdByIban(iban: string): string | null {
  const row = db
    .prepare("SELECT id FROM accounts WHERE REPLACE(UPPER(iban), ' ', '') = ? ORDER BY created_at ASC LIMIT 1")
    .get(compactIban(iban)) as { id: string } | undefined;
  return row?.id ?? null;
}

export function accountNameTaken(name: string): boolean {
  return db.prepare('SELECT 1 FROM accounts WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))').get(name) !== undefined;
}

/**
 * Decides the account before anything is written. Without a target the
 * export must name its own IBAN: an IBAN-less export (a credit card) could
 * otherwise land on another card's account and its purchases dedupe away.
 */
function planAccount(options: ImportOptions): AccountPlan {
  const { target } = options;
  if (target && 'accountId' in target) {
    const row = db.prepare('SELECT id, iban FROM accounts WHERE id = ?').get(target.accountId) as
      | { id: string; iban: string | null }
      | undefined;
    if (!row) throw new DomainError('account_not_found', 404);
    const own = inferAccount(options.records, options.filename).accountIban;
    // The file's own IBAN is someone else's: the account's IBAN differs, or
    // another account holds it (also when this account has none).
    const holder = own ? accountIdByIban(own) : null;
    const mismatch = own && ((row.iban && compactIban(row.iban) !== own) || (holder && holder !== row.id));
    if (!options.allowIbanMismatch && mismatch) {
      throw DomainError.conflict('iban_mismatch');
    }
    return { kind: 'existing', accountId: row.id, iban: row.iban };
  }
  const inferred = inferAccount(options.records, options.filename);
  if (target && 'newAccount' in target) {
    const name = target.newAccount.name.trim();
    if (!name) throw new DomainError('account_name_required', 400);
    if (accountNameTaken(name)) throw DomainError.conflict('account_name_exists');
    const holder = inferred.accountIban ? accountIdByIban(inferred.accountIban) : null;
    if (holder && !options.allowIbanMismatch) throw DomainError.conflict('iban_in_use');
    const iban = inferred.accountIban && !holder ? inferred.accountIban : null;
    return { kind: 'new', name, subtype: target.newAccount.subtype, iban };
  }
  const accountIban = options.accountIban ?? inferred.accountIban;
  if (!accountIban && options.accountName === undefined) throw new DomainError('account_required', 400);
  return { kind: 'ensure', name: options.accountName ?? inferred.accountName, iban: accountIban };
}

function resolveAccount(plan: AccountPlan, now: string): { accountId: string; iban: string | null } {
  if (plan.kind === 'existing') return { accountId: plan.accountId, iban: plan.iban };
  if (plan.kind === 'ensure') return { accountId: ensureAccount(plan.name, plan.iban, now), iban: plan.iban || null };
  const accountId = createId();
  db.prepare('INSERT INTO accounts (id, created_at, name, iban, type, account_subtype) VALUES (?, ?, ?, ?, ?, ?)').run(
    accountId,
    now,
    plan.name,
    plan.iban,
    'bank',
    plan.subtype
  );
  return { accountId, iban: plan.iban };
}

/**
 * The import's transactional part, all synchronous: node:sqlite shares one
 * connection, so an `await` before COMMIT/ROLLBACK would let another request
 * run inside this transaction. A dry run takes the very same path and rolls
 * back, so its counts are exactly what the import would do.
 */
function runImport(options: ImportOptions, plan: AccountPlan, dryRun: boolean): ImportCounts {
  const { records, checksum, sourceBank, format } = options;
  const rowCount = records.length;
  const now = new Date().toISOString();
  const importSessionId = createId();
  let accountId = '';
  let normalizedCount = 0;
  let skippedCount = 0;
  let overlapRow: { id: string; row_count: number } | undefined;
  const insertedIds: string[] = [];
  let counts: Pick<ImportCounts, 'duplicateCount' | 'overlap' | 'transferCount'>;

  // One transaction up to COMMIT: a failed or interrupted import leaves no
  // account, session or rows behind, and never rows that are not yet grouped
  // with their duplicates or linked as transfers. BEGIN is outside the try: if
  // it fails, there is no transaction of ours to roll back.
  db.exec('BEGIN');
  try {
    const account = resolveAccount(plan, now);
    accountId = account.accountId;
    const overlapKey = `${checksum}:${rowCount}:${account.iban || accountId}`;
    overlapRow = db
      .prepare('SELECT id, row_count FROM import_sessions WHERE overlap_key = ?')
      .get(overlapKey) as { id: string; row_count: number } | undefined;

    db.prepare(
      'INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(importSessionId, now, sourceBank, format, checksum, rowCount, overlapKey);

    logEvent({
      type: 'import.start',
      scope: importSessionId,
      message: `Import ${format} ${sourceBank} rows=${rowCount}`,
      payload: { checksum, rowCount, overlapDetected: Boolean(overlapRow) },
    });

    const insertRaw = db.prepare(
      'INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );

    const insertNormalized = db.prepare(
      'INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name, description, counterparty_iban, transaction_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertBalance = db.prepare(
      'INSERT OR REPLACE INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)'
    );

    // A day's snapshot is its closing balance: the Saldo of the day's last row
    // in time, read from the chain of the day's rows (saldoChain.ts), so the
    // order of a day's rows in the file does not matter. Only when the chain
    // does not decide it: the file order, newest first like Nordea (then the
    // day's first row) or ascending (then its last row).
    const newestFirst = isNewestFirst(records);
    const dayRows = new Map<string, Array<SaldoRow & { currency: string }>>();
    const daysMissingSaldo = new Set<string>();

    for (const record of records) {
      const bookingDate = parseDate(getField(record, 'Kirjauspäivä'));
      const amount = parseAmount(getField(record, 'Määrä'));
      const currency = (getField(record, 'Valuutta') as string) || 'EUR';
      const saldoRaw = getField(record, 'Saldo');
      const saldo = parseAmount(saldoRaw);

      const rawId = createId();
      insertRaw.run(
        rawId,
        now,
        importSessionId,
        JSON.stringify(record),
        bookingDate,
        amount,
        currency
      );

      if (amount === null) {
        skippedCount += 1;
        continue;
      }

      const { name: counterparty, iban: counterpartyIban } = chooseCounterparty(record, amount);

      const descriptionParts = [getField(record, 'Otsikko'), getField(record, 'Viesti')]
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
        .map((value) => String(value).trim());

      let filteredParts = descriptionParts;
      if (counterparty) {
        filteredParts = filteredParts.filter((p) => !eqIgnoreCase(p, counterparty));
      }

      let description = filteredParts.join(' | ');

      if (counterparty && description.toLowerCase().startsWith(counterparty.toLowerCase())) {
        const pattern = new RegExp(`^\\s*${escapeRegex(counterparty)}\\s*[|,:-]?\\s*`, 'i');
        description = description.replace(pattern, '').trim();
      }

      if (description && counterparty && normalizeString(description) === normalizeString(counterparty)) {
        description = '';
      }

      const normalizedId = createId();
      insertNormalized.run(
        normalizedId,
        now,
        rawId,
        importSessionId,
        accountId,
        bookingDate,
        bookingDate,
        amount,
        currency,
        counterparty || null,
        description || null,
        counterpartyIban || null,
        null
      );

      if (saldo !== null && bookingDate) {
        if (!dayRows.has(bookingDate)) dayRows.set(bookingDate, []);
        dayRows.get(bookingDate)!.push({ amount, saldo, currency });
      } else if (bookingDate) {
        daysMissingSaldo.add(bookingDate);
      }

      const categoryId = chooseCategoryFor({
        counterparty: counterparty || '',
        description: description || '',
        amount,
      });
      if (categoryId) {
        upsertDecision({ transactionId: normalizedId, categoryId, source: 'rule' });
      }

      insertedIds.push(normalizedId);
      normalizedCount += 1;
    }

    for (const [day, rows] of dayRows) {
      // The chain is only sound when every row of the day has a Saldo: with
      // one missing, a wrong row can look like the day's last one.
      const close = daysMissingSaldo.has(day) ? null : dayEnds(rows).close;
      const byFileOrder = newestFirst ? rows[0] : rows[rows.length - 1];
      const saldo = close !== null ? close / 100 : byFileOrder.saldo;
      insertBalance.run(createId(), now, accountId, day, saldo, byFileOrder.currency);
    }

    // Post-processing: group duplicates, then link transfers between their canonical rows.
    dedupeInserted(insertedIds);
    linkTransfers(insertedIds);
    counts = countEffects(importSessionId);

    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (!dryRun) {
      logEvent({ type: 'import.error', scope: importSessionId, message: 'Import failed', payload: { error: String(error) } });
    }
    throw error;
  }

  return {
    importSessionId,
    accountId,
    normalizedCount,
    skippedCount,
    ...counts,
    overlapDetected: Boolean(overlapRow),
    alreadyImportedCount: overlapRow?.row_count ?? 0,
  };
}

/** Duplicates grouped and transfers linked by one import session's rows. */
function countEffects(importSessionId: string): Pick<ImportCounts, 'duplicateCount' | 'overlap' | 'transferCount'> {
  const dup = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(substr(booking_date, 1, 10)) AS f, MAX(substr(booking_date, 1, 10)) AS t
       FROM normalized_transactions WHERE import_session_id = ? AND transaction_group_id IS NOT NULL`
    )
    .get(importSessionId) as { n: number; f: string | null; t: string | null };
  const transfers = db
    .prepare(
      `SELECT COUNT(DISTINCT n.id) AS n FROM normalized_transactions n
       JOIN transfer_links l ON n.id IN (l.from_transaction_id, l.to_transaction_id)
       WHERE n.import_session_id = ?`
    )
    .get(importSessionId) as { n: number };
  return {
    duplicateCount: Number(dup.n),
    overlap: dup.f && dup.t ? { from: dup.f, to: dup.t } : null,
    transferCount: Number(transfers.n),
  };
}

/**
 * Runs the import inside a transaction that is always rolled back: nothing is
 * written (not even the event log), and the counts are the real pipeline's.
 * Throws the same errors as `processImport` (e.g. `account_required`).
 */
export function dryRunImport(options: ImportOptions): ImportCounts {
  return runImport(options, planAccount(options), true);
}

export async function processImport(options: ImportOptions): Promise<ImportResult> {
  // Planning and the whole transaction run before the first await.
  const run = runImport(options, planAccount(options), false);
  const { importSessionId, accountId, normalizedCount, skippedCount, overlapDetected, alreadyImportedCount } = run;

  // Hook patterns and briefing into import pipeline
  let briefingSessionId: string | undefined;
  try {
    detectPatterns(accountId);
    briefingSessionId = await runBriefing(importSessionId);
  } catch (err) {
    logEvent({ type: 'import.warning', scope: importSessionId, message: 'Briefing failed', payload: { error: String(err) } });
  }

  // Fire-and-forget: non-blocking AI rule suggestions
  generateRuleSuggestions().catch((err) => {
    console.error('[importer] generateRuleSuggestions failed:', err);
  });

  logEvent({
    type: 'import.done',
    scope: importSessionId,
    message: `Imported ${normalizedCount} rows (skipped ${skippedCount})`,
    payload: { normalizedCount, skippedCount, overlapDetected, alreadyImportedCount },
  });

  return {
    importSessionId,
    accountId,
    normalizedCount,
    rawCount: options.records.length,
    skippedCount,
    overlapDetected,
    alreadyImportedCount,
    duplicateCount: run.duplicateCount,
    transferCount: run.transferCount,
    briefingSessionId,
  };
}

export function parseCsv(fileBuffer: Buffer): Record<string, unknown>[] {
  return parse(fileBuffer, {
    delimiter: ';',
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, unknown>[];
}

export function parseXlsx(fileBuffer: Buffer): Record<string, unknown>[] {
  const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: false,
  });
}

export function checksum(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
