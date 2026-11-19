import crypto from 'crypto';
import { parse } from 'csv-parse/sync';
import xlsx from 'xlsx';
import { db } from './db.js';
import { logEvent } from './logger.js';
import { chooseCategoryFor, upsertDecision } from './rules.js';
import { detectPatterns } from './patterns.js';
import { runBriefing } from './briefing.js';
import { generateRuleSuggestions } from './ruleSuggestions.js';
import { daysBefore, today } from './ledger.js';
import { DomainError } from './http/errors.js';
import { isManual } from './categorization.js';
import { LATEST_DECISION_ORDER } from './sql/transactions.js';
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
  /** Rows not stored because the account already has them (overlap with earlier exports). */
  duplicateCount: number;
  /** Rows linked as one side of a transfer between own accounts. */
  transferCount: number;
  /** Pending rows already stored as pending (not stored again). */
  pendingSeenCount: number;
  /** Booked rows that booked a stored pending row in place. */
  bookedPendingCount: number;
  /** Stored pending rows this export shows cancelled (void). */
  voidedPendingCount: number;
  briefingSessionId?: string;
};

type RecordValue = string | number | null | undefined;

/**
 * An amount as a CSV writes it ("-1.234,50", "1 234,56") or as a spreadsheet
 * cell holds it (a number, or text like "-12.50"). The decimal separator is the
 * last of comma and dot when both appear; a lone comma is decimal (Nordea); a
 * lone dot is decimal only before one or two final digits ("1.234" is a
 * thousand).
 */
export function parseAmount(value?: RecordValue): number | null {
  if (value === null || value === undefined || value === '') return null;
  // A spreadsheet number may carry float noise (-12.499999999999998): amounts are cents.
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const s = String(value).replace(/\s/g, '').replace(/−/g, '-');
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  let decimal: ',' | '.' | null;
  if (comma >= 0 && dot >= 0) decimal = comma > dot ? ',' : '.';
  else if (comma >= 0) decimal = ',';
  else if (dot >= 0) decimal = /^[-+]?\d*\.\d{1,2}$/.test(s) ? '.' : null;
  else decimal = null;
  const thousands = decimal === ',' ? /\./g : decimal === '.' ? /,/g : /[.,]/g;
  const normalized = decimal ? s.replace(thousands, '').replace(decimal, '.') : s.replace(thousands, '');
  if (normalized === '' || normalized === '-' || normalized === '+') return null;
  const amount = Number(normalized);
  return Number.isNaN(amount) ? null : amount;
}

/**
 * A booking day as an ISO timestamp at UTC midnight, or null (a pending
 * "Varaus" row, or no date). Accepts Nordea's "YYYY/MM/DD", "DD.MM.YYYY", ISO
 * days with a time after them, and spreadsheet day numbers (a time of day,
 * the fraction, is dropped: a booking is a calendar day).
 */
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
    if (!Number.isFinite(value)) return null;
    const epoch = Date.UTC(1899, 11, 30);
    const date = new Date(epoch + Math.floor(value) * 86400000);
    return date.toISOString();
  }
  const trimmed = String(value).trim();
  if (trimmed === 'Varaus') return null;

  const normalized = trimmed.split(/[\sT]/)[0].replace(/\./g, '/').replace(/-/g, '/');
  const parts = normalized.split('/');
  if (parts.length !== 3) return null;

  // A four-digit last part is a year (DD.MM.YYYY); otherwise year first (YYYY/MM/DD, YY/MM/DD).
  const dayFirst = parts[2].trim().length === 4;
  let year = Number(dayFirst ? parts[2] : parts[0]);
  const month = Number(parts[1]);
  const day = Number(dayFirst ? parts[0] : parts[2]);
  if (year < 100) year += 2000;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // No rolling over: 31.02. is not a day.
  if (date.getUTCMonth() !== month - 1) return null;
  return date.toISOString();
}

function createId(): string {
  return crypto.randomUUID();
}

/** A column name as the pipeline knows it: no BOM, no surrounding spaces, composed umlauts. */
const canonicalColumn = (name: string) => name.replace(/^\ufeff/, '').normalize('NFC').trim();

/**
 * A column's value. Column names are compared in canonical form: the CSV
 * reader trims its header, a spreadsheet header may carry a stray space, a BOM
 * or decomposed umlauts, and those are the same column.
 */
export function getField(record: Record<string, unknown>, key: string): RecordValue {
  if (record[key] !== undefined && record[key] !== null) return record[key] as RecordValue;
  for (const name of Object.keys(record)) {
    if (name !== key && canonicalColumn(name) === key && record[name] !== undefined && record[name] !== null) {
      return record[name] as RecordValue;
    }
  }
  return null;
}

/** A text column's value as text: a spreadsheet may store a message like "20261012" as a number. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
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
    const raw = textOf(getField(record, amount < 0 ? 'Maksaja' : 'Maksunsaaja'));
    const compact = raw.replace(/\s+/g, '').toUpperCase();
    if (looksLikeIban(compact)) candidates.push(compact);
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
    textOf(getField(record, 'Nimi')),
    textOf(getField(record, 'Otsikko')),
    textOf(getField(record, 'Viesti')),
  ].filter((v) => v.length > 0 && !looksLikeIban(v));

  const otherPartyStr = textOf(amount < 0 ? getField(record, 'Maksunsaaja') : getField(record, 'Maksaja'));

  const name = nameFields[0] || (looksLikeIban(otherPartyStr) ? null : otherPartyStr) || null;
  const iban = looksLikeIban(otherPartyStr) ? otherPartyStr.replace(/\s+/g, '') : null;

  return { name, iban };
}

/** True when `x` is already one side of a transfer. */
function isLinked(x: string) {
  return `${x}.id IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)`;
}

const normIban = (iban: string | null) => (iban ? iban.replace(/\s+/g, '').toUpperCase() : null);

type LinkSide = {
  id: string;
  account_id: string;
  counterparty_iban: string | null;
  counterparty_name: string | null;
  account_iban: string | null;
  dist?: number;
};

/**
 * How a card names a credit, without the day some cards put in it
 * ("Suoritus 20.10" and "Suoritus 05.11" are the same kind of credit).
 */
const creditLabel = (name: string | null) =>
  name === null ? null : name.replace(/\b\d{1,2}\.\d{1,2}(?:\.\d{0,4})?(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Pairs each new transaction with the other side of a transfer between own
 * accounts: the opposite amount on another account within two days. Each
 * transaction is in at most one transfer.
 *
 * Nordea exports name the other account's IBAN on a transfer, and a
 * merchant's name on a card payment. So:
 * - an IBAN pointing at the candidate's account is proof, and the best one;
 * - an IBAN pointing elsewhere rules the candidate out;
 * - without IBANs, an account whose export carries them elsewhere is not
 *   transferring (e.g. a purchase on one card and a refund on another);
 * - otherwise the closest day wins, and a tie between accounts is left
 *   unlinked rather than guessed.
 *
 * A card's monthly bill is often paid as an e-invoice without the issuer's
 * IBAN, unlike extra repayments. A payee that an IBAN-carrying repayment from
 * the account already went to is the card issuer, so a payment to it without
 * an IBAN may be a repayment too, when the card names the credit as it named
 * that repayment (a refund carries the merchant's name), and it beats other
 * payments of the same amount. A card credit several payments could have repaid waits for a second
 * pass, when repayments in the same import may have taught the issuer; rows
 * left unlinked are tried again then too.
 */
function linkTransfers(ids: string[]) {
  const sideOf = db.prepare(
    `SELECT t.id, t.account_id, t.booking_date, t.amount, t.counterparty_iban, t.counterparty_name, a.iban AS account_iban
     FROM normalized_transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.id = ? AND t.booking_date IS NOT NULL AND NOT ${isLinked('t')}`
  );
  const candidatesOf = db.prepare(
    `SELECT c.id, c.account_id, c.booking_date, c.amount, c.counterparty_iban, c.counterparty_name, a.iban AS account_iban,
            ABS(julianday(substr(c.booking_date, 1, 10)) - julianday(substr(?, 1, 10))) AS dist
     FROM normalized_transactions c JOIN accounts a ON a.id = c.account_id
     WHERE c.account_id != ? AND c.amount = ?
       AND c.booking_date >= ? AND c.booking_date < ?
       AND ABS(julianday(substr(c.booking_date, 1, 10)) - julianday(substr(?, 1, 10))) <= 2
       AND NOT ${isLinked('c')}
     ORDER BY dist ASC, c.created_at ASC, c.id ASC`
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
  // IBAN-carrying repayments from an account with an IBAN into one without: the payee
  // on the paying side, and how the payment is named on the card.
  const payeesStmt = db.prepare(
    `SELECT DISTINCT f.account_id, f.counterparty_name, t.account_id AS card_id, t.counterparty_name AS credit_name
     FROM transfer_links l
     JOIN normalized_transactions f ON f.id = l.from_transaction_id
     JOIN accounts fa ON fa.id = f.account_id
     JOIN normalized_transactions t ON t.id = l.to_transaction_id
     JOIN accounts ta ON ta.id = t.account_id
     WHERE fa.iban IS NOT NULL AND ta.iban IS NULL
       AND f.counterparty_iban IS NOT NULL AND f.counterparty_name IS NOT NULL`
  );
  const payeeKey = (from: Pick<LinkSide, 'account_id' | 'counterparty_name'>, card: Pick<LinkSide, 'account_id' | 'counterparty_name'>) =>
    [from.account_id, from.counterparty_name, card.account_id, creditLabel(card.counterparty_name)].join('\u0000');
  const loadPayees = () =>
    new Set(
      (
        payeesStmt.all() as Array<{ account_id: string; counterparty_name: string; card_id: string; credit_name: string | null }>
      ).map((p) => payeeKey(p, { account_id: p.card_id, counterparty_name: p.credit_name }))
    );
  let payees = loadPayees();

  /**
   * A payment from `from` to the card's issuer, named on the card as its earlier repayments
   * were: a refund on the card carries the merchant's name instead.
   */
  const knownPayee = (from: LinkSide, card: LinkSide) =>
    from.counterparty_name !== null && payees.has(payeeKey(from, card));
  /** Unlinked payments on accounts with an IBAN that could have repaid this card credit. */
  const repaymentRivals = (credit: LinkSide & { booking_date: string; amount: number }) => {
    const day = credit.booking_date.slice(0, 10);
    return (
      candidatesOf.all(credit.booking_date, credit.account_id, -credit.amount, daysBefore(day, 2), daysBefore(day, -3), credit.booking_date) as LinkSide[]
    ).filter((c) => c.account_iban);
  };

  /** Links one row. With `settle` false, a card credit several payments could have repaid waits. */
  const linkOne = (id: string, settle: boolean) => {
    const row = sideOf.get(id) as (LinkSide & { booking_date: string; amount: number }) | undefined;
    if (!row || row.amount === 0) return;
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
      (!carriesIbans(from.account_id) ||
        from.counterparty_iban !== null ||
        knownPayee(from, into));
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
      // Several payments of the card credit's amount: the one to the card's issuer
      // wins, and the issuer may be learnt only later in this import, so wait.
      let pool = plausible;
      const credit = !row.account_iban && row.amount > 0 ? row : null;
      const card = credit ? null : (pool.find((c) => !c.account_iban) as (LinkSide & { booking_date: string; amount: number }) | undefined);
      const rivals = credit ? candidates.filter((c) => c.account_iban) : card ? repaymentRivals(card) : [];
      if (rivals.length > 1) {
        if (!settle) return;
        const fromIssuer = (c: LinkSide) => knownPayee(c, credit!);
        if (credit && pool.some(fromIssuer)) pool = pool.filter(fromIssuer);
        if (card && !knownPayee(row, card) && rivals.some((r) => knownPayee(r, card))) pool = pool.filter((c) => c !== card);
      }
      match = pool[0];
      confidence = 70;
      if (match && pool.some((c) => c.dist === match!.dist && c.account_id !== match!.account_id)) return;
    }
    if (!match) return;

    const fromId = row.amount < 0 ? row.id : match.id;
    const toId = row.amount < 0 ? match.id : row.id;
    insertLink.run(createId(), new Date().toISOString(), fromId, toId, confidence);
  };

  ids.forEach((id) => linkOne(id, false));
  payees = loadPayees();
  ids.forEach((id) => linkOne(id, true));
}

/** Bump when linkTransfers would link stored rows it once left unlinked. */
export const TRANSFER_RULES_VERSION = '1';
const TRANSFER_RULES_VERSION_KEY = 'transferRulesVersion';

/**
 * Links the stored card bills the current transfer rules pair but an earlier
 * version left unlinked (runs once per rules version). Only payments without an
 * IBAN from accounts with one are tried: the paying side sees every card credit,
 * so a tie between cards stays unlinked as on import, and rows linked under older
 * rules are not re-judged. Existing links and the rows themselves are kept as
 * they are; patterns are re-detected when a link is added.
 */
export function relinkTransfersIfRulesChanged(): boolean {
  const stored = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(TRANSFER_RULES_VERSION_KEY) as
    | { value: string }
    | undefined;
  if (stored?.value === TRANSFER_RULES_VERSION) return false;

  const countLinks = () => Number((db.prepare('SELECT COUNT(*) AS n FROM transfer_links').get() as { n: number }).n);
  db.exec('BEGIN');
  try {
    const before = countLinks();
    const ids = (
      db
        .prepare(
          `SELECT t.id FROM normalized_transactions t JOIN accounts a ON a.id = t.account_id
           WHERE t.booking_date IS NOT NULL AND t.amount < 0 AND t.counterparty_iban IS NULL
             AND a.iban IS NOT NULL AND NOT ${isLinked('t')}
           ORDER BY t.booking_date, t.created_at, t.id`
        )
        .all() as Array<{ id: string }>
    ).map((r) => r.id);
    linkTransfers(ids);
    if (countLinks() > before) {
      for (const { id } of db.prepare('SELECT id FROM accounts').all() as Array<{ id: string }>) detectPatterns(id);
    }
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(TRANSFER_RULES_VERSION_KEY, TRANSFER_RULES_VERSION, new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
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
  /** Who imports (`X-Finance-Actor`); recorded on the rule decisions made on import. Default `user`. */
  actor?: string;
};

/** What the import's transactional part did, or in a dry run would do. */
export type ImportCounts = {
  importSessionId: string;
  accountId: string;
  normalizedCount: number;
  skippedCount: number;
  /**
   * Rows of this import not stored because the account already has them: same
   * booking date, amount and counterparty, paired one-to-one with stored rows.
   */
  duplicateCount: number;
  /** Pending rows of this import the account already has as pending: not stored again. */
  pendingSeenCount: number;
  /** Booked rows of this import that are the booking of a stored pending row, promoted in place. */
  bookedPendingCount: number;
  /** Stored pending rows this newer export lists neither pending nor booked: now void. */
  voidedPendingCount: number;
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

function isManualAccount(id: string): boolean {
  return db.prepare("SELECT 1 FROM accounts WHERE id = ? AND tracking = 'manual'").get(id) !== undefined;
}

export function accountNameTaken(name: string): boolean {
  return db.prepare('SELECT 1 FROM accounts WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))').get(name) !== undefined;
}

/**
 * Decides the account before anything is written. Without a target the
 * export must name its own IBAN: an IBAN-less export (a credit card) could
 * otherwise land on another card's account, where purchases matching that
 * card's are skipped as already stored.
 */
function planAccount(options: ImportOptions): AccountPlan {
  const { target } = options;
  if (target && 'accountId' in target) {
    const row = db.prepare('SELECT id, iban, tracking FROM accounts WHERE id = ?').get(target.accountId) as
      | { id: string; iban: string | null; tracking: string }
      | undefined;
    if (!row) throw new DomainError('account_not_found', 404);
    if (row.tracking === 'manual') throw DomainError.conflict('account_manual');
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
  const name = options.accountName ?? inferred.accountName;
  // Nothing is imported into a manual account: its IBAN only recognises transfers to it.
  const found = accountIban
    ? accountIdByIban(accountIban)
    : ((db.prepare('SELECT id FROM accounts WHERE name = ?').get(name) as { id: string } | undefined)?.id ?? null);
  if (found && isManualAccount(found)) throw DomainError.conflict('account_manual');
  return { kind: 'ensure', name, iban: accountIban };
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

/** A file row as the pipeline reads it. */
type FileRow = {
  record: Record<string, unknown>;
  /** Index in the file. */
  index: number;
  /** ISO timestamp at UTC midnight; null for a pending row. */
  bookingDate: string | null;
  day: string | null;
  amount: number | null;
  currency: string;
  counterparty: string | null;
  counterpartyIban: string | null;
  description: string | null;
};

/** A stored pending (or void) row of the account that a file row may be. */
type PendingCandidate = {
  id: string;
  amount: number;
  counterparty: string | null;
  createdAt: string;
  /** `booked`: a reservation already booked, only for recognising an older export that still lists it. */
  status: 'pending' | 'void' | 'booked';
  firstSeenDay: string;
  lastSeenDay: string;
  resolvedDay: string | null;
};

/** What the import does with a file row. */
type RowAction =
  | { kind: 'skip' }
  | { kind: 'duplicate' }
  | { kind: 'pending_seen'; target: PendingCandidate }
  | { kind: 'promote'; target: PendingCandidate }
  | { kind: 'insert' };

/**
 * Days a booking may be dated before the export that first listed its
 * reservation (the export's latest booked day stands in for when it was made,
 * and a bank may date a booking a little back).
 */
export const PENDING_BACKDATE_DAYS = 3;
/**
 * Days after the newest export that still listed a reservation within which
 * its booking (or the same reservation again) is looked for. Card
 * authorisations lapse well within this; a later row of the same amount and
 * counterparty is another purchase.
 */
export const PENDING_MAX_AGE_DAYS = 35;

function descriptionOf(record: Record<string, unknown>, counterparty: string | null): string | null {
  const descriptionParts = [textOf(getField(record, 'Otsikko')), textOf(getField(record, 'Viesti'))].filter((v) => v.length > 0);
  const filteredParts = counterparty ? descriptionParts.filter((p) => !eqIgnoreCase(p, counterparty)) : descriptionParts;
  let description = filteredParts.join(' | ');
  if (counterparty && description.toLowerCase().startsWith(counterparty.toLowerCase())) {
    const pattern = new RegExp(`^\\s*${escapeRegex(counterparty)}\\s*[|,:-]?\\s*`, 'i');
    description = description.replace(pattern, '').trim();
  }
  if (description && counterparty && normalizeString(description) === normalizeString(counterparty)) {
    description = '';
  }
  return description || null;
}

function readRow(record: Record<string, unknown>, index: number): FileRow {
  const bookingDate = parseDate(getField(record, 'Kirjauspäivä'));
  const amount = parseAmount(getField(record, 'Määrä'));
  const currency = textOf(getField(record, 'Valuutta')) || 'EUR';
  if (amount === null) {
    return { record, index, bookingDate, day: bookingDate?.slice(0, 10) ?? null, amount, currency, counterparty: null, counterpartyIban: null, description: null };
  }
  const { name, iban } = chooseCounterparty(record, amount);
  const counterparty = name || null;
  return {
    record,
    index,
    bookingDate,
    day: bookingDate?.slice(0, 10) ?? null,
    amount,
    currency,
    counterparty,
    counterpartyIban: iban || null,
    description: descriptionOf(record, counterparty),
  };
}

const sameKey = (c: PendingCandidate, r: FileRow) => c.amount === r.amount && c.counterparty === r.counterparty;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Decides, before anything is written, what happens to every row of the file:
 *
 * 1. A booked row the account already has (same booking day, amount and
 *    counterparty, paired one-to-one with stored rows of earlier imports) is
 *    a duplicate and not stored.
 * 2. A pending row the account already has as pending (same amount and
 *    counterparty, last listed within PENDING_MAX_AGE_DAYS) is seen again and
 *    not stored. Of several, the most recently seen one is taken: the
 *    reservations still pending are the newest. A reservation already booked
 *    by an export at least as new as this file counts too (last): an older
 *    export imported again lists it pending.
 * 3. Any other booked row may be the booking of a stored reservation: same
 *    amount and counterparty, dated from PENDING_BACKDATE_DAYS before the
 *    export that first listed it to PENDING_MAX_AGE_DAYS after the newest that
 *    did. Bookings are paired in day order with the oldest reservations
 *    first, one-to-one; a still-pending reservation goes before a void one.
 * 4. Everything else is new.
 *
 * Rows of this file are never matched with each other, and a reservation
 * this file still lists pending is never booked by it. A booked row is only
 * ever paired with one stored row that no report counts (a pending or void
 * one), so promotion can never make two counted transactions one.
 */
function planRows(rows: FileRow[], accountId: string, fileDay: string): { actions: RowAction[]; unclaimed: PendingCandidate[] } {
  const actions: RowAction[] = rows.map(() => ({ kind: 'insert' }) as RowAction);

  // 1. Booked duplicates.
  const storedCount = db.prepare(
    `SELECT COUNT(*) AS n FROM normalized_transactions
     WHERE account_id = ? AND booking_date >= ? AND booking_date < ? AND amount = ?
       AND (counterparty_name = ? OR (counterparty_name IS NULL AND ? IS NULL))`
  );
  const unmatched = new Map<string, number>();
  for (const r of rows) {
    if (r.amount === null) {
      actions[r.index] = { kind: 'skip' };
      continue;
    }
    if (!r.day) continue;
    const key = JSON.stringify([r.day, r.amount, r.counterparty]);
    const left =
      unmatched.get(key) ??
      Number((storedCount.get(accountId, r.day, daysBefore(r.day, -1), r.amount, r.counterparty, r.counterparty) as { n: number }).n);
    unmatched.set(key, Math.max(0, left - 1));
    if (left > 0) actions[r.index] = { kind: 'duplicate' };
  }

  const candidates = (
    db
      .prepare(
        `SELECT t.id, t.amount, t.counterparty_name, t.created_at, p.status, p.first_seen_day, p.last_seen_day, p.resolved_day
         FROM normalized_transactions t JOIN pending_transactions p ON p.transaction_id = t.id
         WHERE t.account_id = ?
           AND ((t.booking_date IS NULL AND p.status IN ('pending', 'void')) OR p.status = 'booked')`
      )
      .all(accountId) as Array<{
      id: string;
      amount: number;
      counterparty_name: string | null;
      created_at: string;
      status: 'pending' | 'void' | 'booked';
      first_seen_day: string;
      last_seen_day: string;
      resolved_day: string | null;
    }>
  ).map(
    (c): PendingCandidate => ({
      id: c.id,
      amount: Number(c.amount),
      counterparty: c.counterparty_name,
      createdAt: c.created_at,
      status: c.status,
      firstSeenDay: c.first_seen_day,
      lastSeenDay: c.last_seen_day,
      resolvedDay: c.resolved_day,
    })
  );
  const claimed = new Set<string>();
  const RANK = { pending: 0, void: 1, booked: 2 } as const;
  const pendingFirst = (a: PendingCandidate, b: PendingCandidate) => RANK[a.status] - RANK[b.status];
  /**
   * A booked reservation still listed pending by this file: the file is not
   * newer than the export that booked it (an older export imported again).
   */
  const bookedLater = (c: PendingCandidate) => c.status !== 'booked' || (c.resolvedDay !== null && fileDay <= c.resolvedDay);

  // 2. Reservations seen again: the most recently seen first.
  const recentEnough = daysBefore(fileDay, PENDING_MAX_AGE_DAYS);
  for (const r of rows) {
    if (r.amount === null || r.day) continue;
    const pick = candidates
      .filter((c) => !claimed.has(c.id) && sameKey(c, r) && c.lastSeenDay >= recentEnough && bookedLater(c))
      .sort(
        (a, b) =>
          pendingFirst(a, b) ||
          cmp(b.lastSeenDay, a.lastSeenDay) ||
          cmp(b.firstSeenDay, a.firstSeenDay) ||
          cmp(b.createdAt, a.createdAt) ||
          cmp(b.id, a.id)
      )[0];
    if (pick) {
      claimed.add(pick.id);
      actions[r.index] = { kind: 'pending_seen', target: pick };
    }
  }

  // 3. Bookings of reservations: in day order (file order within a day), oldest reservation first.
  const bookings = rows
    .filter((r) => r.day && r.amount !== null && actions[r.index].kind === 'insert')
    .sort((a, b) => cmp(a.day!, b.day!) || a.index - b.index);
  for (const r of bookings) {
    const day = r.day!;
    const pick = candidates
      .filter(
        (c) =>
          !claimed.has(c.id) &&
          c.status !== 'booked' &&
          sameKey(c, r) &&
          day >= daysBefore(c.firstSeenDay, PENDING_BACKDATE_DAYS) &&
          day <= daysBefore(c.lastSeenDay, -PENDING_MAX_AGE_DAYS)
      )
      .sort((a, b) => pendingFirst(a, b) || cmp(a.firstSeenDay, b.firstSeenDay) || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id))[0];
    if (pick) {
      claimed.add(pick.id);
      actions[r.index] = { kind: 'promote', target: pick };
    }
  }

  return { actions, unclaimed: candidates.filter((c) => !claimed.has(c.id)) };
}

/**
 * Stored reservations this file proves gone: it lists them neither pending nor
 * booked, and it is a newer export of their period. Newer: its latest booked
 * day is on or after that of the newest export that listed the reservation.
 * Of their period: its booked rows reach back to where the reservation's
 * booking could be dated (PENDING_BACKDATE_DAYS before it was first listed).
 * A shorter or older export proves nothing, and a file without booked rows
 * has no period.
 */
function provenGone(unclaimed: PendingCandidate[], firstDay: string | null, lastDay: string | null): PendingCandidate[] {
  if (!firstDay || !lastDay) return [];
  return unclaimed.filter(
    (c) => c.status === 'pending' && lastDay >= c.lastSeenDay && firstDay <= daysBefore(c.firstSeenDay, PENDING_BACKDATE_DAYS)
  );
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
  let duplicateCount = 0;
  let pendingSeenCount = 0;
  let bookedPendingCount = 0;
  let voidedPendingCount = 0;
  let overlapFrom: string | null = null;
  let overlapTo: string | null = null;
  let overlapRow: { id: string; row_count: number } | undefined;
  /** Rows that got a booking date in this import: inserted booked rows and promoted reservations. */
  const linkIds: string[] = [];
  let transferCount = 0;

  const rows = records.map(readRow);
  const bookedDays = rows.map((r) => r.day).filter((d): d is string => d !== null).sort();
  const firstDay = bookedDays[0] ?? null;
  const lastDay = bookedDays[bookedDays.length - 1] ?? null;
  // The export's day: its latest booked day (an export does not say when it
  // was made). Set once the account is known: a file of reservations only
  // takes the account's latest booked day, so a later export's bookings of
  // them still fall in their window; an account without any, today.
  let fileDay = lastDay ?? today();

  // One transaction up to COMMIT: a failed or interrupted import leaves no
  // account, session or rows behind, and never rows that are not yet linked
  // as transfers. BEGIN is outside the try: if
  // it fails, there is no transaction of ours to roll back.
  db.exec('BEGIN');
  try {
    const account = resolveAccount(plan, now);
    accountId = account.accountId;
    const overlapKey = `${checksum}:${rowCount}:${account.iban || accountId}`;
    overlapRow = db
      .prepare('SELECT id, row_count FROM import_sessions WHERE overlap_key = ?')
      .get(overlapKey) as { id: string; row_count: number } | undefined;

    if (!lastDay) {
      const latest = db
        .prepare('SELECT MAX(substr(booking_date, 1, 10)) AS d FROM normalized_transactions WHERE account_id = ? AND booking_date IS NOT NULL')
        .get(accountId) as { d: string | null };
      if (latest.d) fileDay = latest.d;
    }

    // Decided before this import writes a row, so its own rows are never matched.
    const { actions, unclaimed } = planRows(rows, accountId, fileDay);

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
      'INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name, description, counterparty_iban) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insertPending = db.prepare(
      `INSERT INTO pending_transactions
         (transaction_id, status, first_seen_session_id, first_seen_day, last_seen_session_id, last_seen_day, pending_raw_transaction_id)
       VALUES (?, 'pending', ?, ?, ?, ?, ?)`
    );
    const seenAgain = db.prepare(
      `UPDATE pending_transactions
       SET last_seen_session_id = ?, last_seen_day = MAX(last_seen_day, ?),
           status = CASE WHEN status = 'void' AND ? >= resolved_day THEN 'pending' ELSE status END,
           resolved_session_id = CASE WHEN status = 'void' AND ? >= resolved_day THEN NULL ELSE resolved_session_id END,
           resolved_at = CASE WHEN status = 'void' AND ? >= resolved_day THEN NULL ELSE resolved_at END,
           resolved_day = CASE WHEN status = 'void' AND ? >= resolved_day THEN NULL ELSE resolved_day END
       WHERE transaction_id = ?`
    );
    const promote = db.prepare(
      `UPDATE normalized_transactions
       SET raw_transaction_id = ?, booking_date = ?, transaction_date = ?, currency = ?, description = ?, counterparty_iban = ?
       WHERE id = ? AND booking_date IS NULL`
    );
    const resolvePending = db.prepare(
      `UPDATE pending_transactions SET status = ?, resolved_session_id = ?, resolved_day = ?, resolved_at = ?
       WHERE transaction_id = ? AND status IN ('pending', 'void')`
    );
    const latestDecisionSource = db.prepare(
      `SELECT source FROM categorization_decisions WHERE transaction_id = ? ORDER BY ${LATEST_DECISION_ORDER} LIMIT 1`
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

    const categorize = (id: string, r: FileRow) => {
      const categoryId = chooseCategoryFor({ counterparty: r.counterparty || '', description: r.description || '', amount: r.amount! });
      if (categoryId) upsertDecision({ transactionId: id, categoryId, source: 'rule', actor: options.actor ?? 'user' });
    };

    for (const r of rows) {
      const { record, bookingDate, amount, currency } = r;
      const action = actions[r.index];

      const storeRaw = () => {
        const rawId = createId();
        insertRaw.run(rawId, now, importSessionId, JSON.stringify(record), bookingDate, amount, currency);
        return rawId;
      };

      if (amount === null || action.kind === 'skip') {
        storeRaw();
        skippedCount += 1;
        continue;
      }

      // The file's balances count whether or not its rows are new.
      const saldo = parseAmount(getField(record, 'Saldo'));
      if (saldo !== null && bookingDate) {
        if (!dayRows.has(bookingDate)) dayRows.set(bookingDate, []);
        dayRows.get(bookingDate)!.push({ amount, saldo, currency });
      } else if (bookingDate) {
        daysMissingSaldo.add(bookingDate);
      }

      if (action.kind === 'duplicate') {
        // A transaction is stored once: a row the account already has is not stored again.
        duplicateCount += 1;
        const day = r.day!;
        if (overlapFrom === null || day < overlapFrom) overlapFrom = day;
        if (overlapTo === null || day > overlapTo) overlapTo = day;
        continue;
      }

      if (action.kind === 'pending_seen') {
        // The same reservation again: not stored again, only seen later.
        pendingSeenCount += 1;
        if (action.target.status === 'booked') continue;
        seenAgain.run(importSessionId, fileDay, fileDay, fileDay, fileDay, fileDay, action.target.id);
        continue;
      }

      const rawId = storeRaw();

      if (action.kind === 'promote') {
        // The reservation is booked: the same transaction (id, decisions,
        // links) gets its booking date; the booked raw row becomes its source
        // and the pending raw row stays as the reservation's.
        const id = action.target.id;
        promote.run(rawId, bookingDate, bookingDate, currency, r.description, r.counterpartyIban, id);
        resolvePending.run('booked', importSessionId, fileDay, now, id);
        // The booked text may say more than the reservation's: rules decide
        // again, unless the user chose the category (manual beats rule).
        const latest = latestDecisionSource.get(id) as { source: string } | undefined;
        if (!latest || !isManual(id, latest)) categorize(id, r);
        linkIds.push(id);
        bookedPendingCount += 1;
        continue;
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
        r.counterparty,
        r.description,
        r.counterpartyIban
      );
      if (!bookingDate) insertPending.run(normalizedId, importSessionId, fileDay, importSessionId, fileDay, rawId);
      categorize(normalizedId, r);

      if (bookingDate) linkIds.push(normalizedId);
      normalizedCount += 1;
    }

    // Reservations this newer export no longer lists, pending or booked: cancelled.
    for (const c of provenGone(unclaimed, firstDay, lastDay)) {
      resolvePending.run('void', importSessionId, fileDay, now, c.id);
      voidedPendingCount += 1;
    }

    for (const [day, rows] of dayRows) {
      // The chain is only sound when every row of the day has a Saldo: with
      // one missing, a wrong row can look like the day's last one.
      const close = daysMissingSaldo.has(day) ? null : dayEnds(rows).close;
      const byFileOrder = newestFirst ? rows[0] : rows[rows.length - 1];
      const saldo = close !== null ? close / 100 : byFileOrder.saldo;
      insertBalance.run(createId(), now, accountId, day, saldo, byFileOrder.currency);
    }

    // Post-processing: link the rows that got a booking date as transfers.
    linkTransfers(linkIds);
    transferCount = countTransfers(linkIds);

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
    duplicateCount,
    pendingSeenCount,
    bookedPendingCount,
    voidedPendingCount,
    overlap: overlapFrom && overlapTo ? { from: overlapFrom, to: overlapTo } : null,
    transferCount,
    overlapDetected: Boolean(overlapRow),
    alreadyImportedCount: overlapRow?.row_count ?? 0,
  };
}

/** Of these rows, those linked as one side of a transfer. */
function countTransfers(ids: string[]): number {
  const linked = db.prepare('SELECT 1 FROM transfer_links WHERE from_transaction_id = ? OR to_transaction_id = ? LIMIT 1');
  return ids.filter((id) => linked.get(id, id) !== undefined).length;
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
    payload: {
      normalizedCount,
      skippedCount,
      duplicateCount: run.duplicateCount,
      pendingSeenCount: run.pendingSeenCount,
      bookedPendingCount: run.bookedPendingCount,
      voidedPendingCount: run.voidedPendingCount,
      overlapDetected,
      alreadyImportedCount,
    },
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
    pendingSeenCount: run.pendingSeenCount,
    bookedPendingCount: run.bookedPendingCount,
    voidedPendingCount: run.voidedPendingCount,
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
  // Cell values as stored: numbers stay numbers and date cells day numbers.
  // Formatted text would come in the writer's locale ("3/5/26", "-12.5"),
  // which reads as another day and amount than the CSV of the same export.
  return xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: true,
  });
}

export function checksum(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
