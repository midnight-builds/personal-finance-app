// Import preview: what an upload would do, before anything is written.
//
// Counts that depend on the database (duplicates, transfers) come from one dry
// run of the real import pipeline (`dryRunImport`) for the target, so they are
// exactly what the import then does. Guessing the target uses plain reads. Checks of the file itself (gaps, quiet periods, the
// running balance) are pure functions over the parsed rows plus Ledger reads.
import {
  GAP_WITHOUT_BALANCE_MIN_DAYS,
  QUIET_PERIOD_MIN_DAYS,
  type AccountSubtype,
  type BalanceBreak,
  type DataGap,
  type DayRange,
  type ImportPreview,
  type ImportPreviewAccount,
  type ImportPreviewAnalysis,
  type ImportPreviewFile,
  type ImportPreviewGuess,
} from '@finance-app/shared';
import { db } from './db.js';
import { DomainError } from './http/errors.js';
import { accountBalances, daysBefore, ledgerEntries } from './ledger.js';
import {
  accountIdByIban,
  accountNameTaken,
  chooseCounterparty,
  dryRunImport,
  getField,
  inferAccount,
  isNewestFirst,
  parseAmount,
  parseDate,
} from './importer.js';
import { isCanonicalGroupRow } from './sql/transactions.js';

type BookedRow = { day: string; amount: number; saldo: number | null; counterparty: string | null };

const cents = (n: number) => Math.round(n * 100);
const euros = (c: number) => c / 100;
const compact = (iban: string | null) => (iban ? iban.replace(/\s+/g, '').toUpperCase() : null);

/** Whole days from `a` to `b` (YYYY-MM-DD). */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** The days strictly between `a` and `b`, or null when they touch. */
function between(a: string, b: string): DayRange | null {
  const days = dayDiff(a, b) - 1;
  return days > 0 ? { from: daysBefore(a, -1), to: daysBefore(b, 1), days } : null;
}

/** Booked rows with an amount, oldest first; same-day rows keep their order in time. */
export function bookedRowsInTimeOrder(records: Record<string, unknown>[]): BookedRow[] {
  const rows: BookedRow[] = [];
  for (const record of records) {
    const date = parseDate(getField(record, 'Kirjauspäivä'));
    const amount = parseAmount(getField(record, 'Määrä'));
    if (!date || amount === null) continue;
    rows.push({
      day: date.slice(0, 10),
      amount,
      saldo: parseAmount(getField(record, 'Saldo')),
      counterparty: chooseCounterparty(record, amount).name || null,
    });
  }
  if (isNewestFirst(records)) rows.reverse();
  // Stable: a file that is not strictly ordered still reads day by day.
  return rows.map((r, i) => ({ r, i })).sort((x, y) => x.r.day.localeCompare(y.r.day) || x.i - y.i).map((x) => x.r);
}

function suggestName(filename: string, ownIban: string | null): string {
  const beforeIban = filename.match(/^(.*?)\s*FI\d{2}(?: ?\d{4}){3} ?\d{2}/i)?.[1]?.trim();
  const base = (
    beforeIban ||
    (ownIban ? `Tili ${ownIban.slice(-4)}` : filename.replace(/\.(csv|xlsx)$/i, '').trim()) ||
    'Uusi tili'
  ).slice(0, 70);
  let name = base;
  for (let i = 2; accountNameTaken(name); i++) name = `${base} ${i}`;
  return name;
}

function suggestSubtype(filename: string, ownIban: string | null): AccountSubtype {
  if (!ownIban) return 'credit_card';
  if (/s[äa][äa]st[öo]|savings/i.test(filename)) return 'savings';
  return 'checking';
}

function accountRef(id: string | null): { id: string; name: string } | null {
  if (!id) return null;
  const row = db.prepare('SELECT id, name FROM accounts WHERE id = ?').get(id) as { id: string; name: string } | undefined;
  return row ?? null;
}

export function summarizeFile(records: Record<string, unknown>[], filename: string): ImportPreviewFile {
  const ownIban = compact(inferAccount(records, filename).accountIban || null);
  let bookedCount = 0;
  let pendingCount = 0;
  let skippedCount = 0;
  let hasRunningBalance = false;
  for (const record of records) {
    const amount = parseAmount(getField(record, 'Määrä'));
    if (parseAmount(getField(record, 'Saldo')) !== null) hasRunningBalance = true;
    if (amount === null) skippedCount += 1;
    // A row without a booking date ("Varaus") is pending, as the Ledger reads it.
    else if (parseDate(getField(record, 'Kirjauspäivä'))) bookedCount += 1;
    else pendingCount += 1;
  }
  const days = bookedRowsInTimeOrder(records).map((r) => r.day);
  return {
    filename,
    rowCount: records.length,
    bookedCount,
    pendingCount,
    skippedCount,
    firstDate: days[0] ?? null,
    lastDate: days[days.length - 1] ?? null,
    ownIban,
    ownIbanAccount: ownIban ? accountRef(accountIdByIban(ownIban)) : null,
    suggestedName: suggestName(filename, ownIban),
    hasRunningBalance,
  };
}

/** Every account with the booked range of its rows (one per duplicate group). */
export function previewAccounts(): ImportPreviewAccount[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.iban, a.account_subtype AS subtype,
              MIN(substr(t.booking_date, 1, 10)) AS firstDate,
              MAX(substr(t.booking_date, 1, 10)) AS lastDate,
              COUNT(t.id) AS transactionCount
       FROM accounts a
       LEFT JOIN normalized_transactions t
         ON t.account_id = a.id AND t.booking_date IS NOT NULL AND ${isCanonicalGroupRow('t')}
       GROUP BY a.id
       ORDER BY a.created_at ASC, a.id ASC`
    )
    .all() as Array<ImportPreviewAccount & { transactionCount: number }>;
  return rows.map((r) => ({ ...r, transactionCount: Number(r.transactionCount) }));
}

/** Stretches of at least `minDays` days inside the file without any booked row. */
export function quietPeriods(rows: BookedRow[], minDays = QUIET_PERIOD_MIN_DAYS): DayRange[] {
  const days = [...new Set(rows.map((r) => r.day))];
  const out: DayRange[] = [];
  for (let i = 1; i < days.length; i++) {
    const gap = between(days[i - 1], days[i]);
    if (gap && gap.days >= minDays) out.push(gap);
  }
  return out;
}

type Day = { day: string; rows: BookedRow[]; sum: number };

function byDay(rows: BookedRow[]): Day[] {
  const days: Day[] = [];
  for (const r of rows) {
    const last = days[days.length - 1];
    if (last?.day === r.day) {
      last.rows.push(r);
      last.sum += cents(r.amount);
    } else days.push({ day: r.day, rows: [r], sum: cents(r.amount) });
  }
  return days;
}

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
 * A day's balance before and after its rows (cents), whatever their order in
 * the file. The rows form a chain: each row's balance before it (Saldo −
 * amount) is another row's Saldo, except the day's opening; each Saldo is
 * another row's balance before, except the day's close. Falls back to the
 * file order when the chain is ambiguous or broken.
 */
function dayEnds(d: Day): { opening: number; close: number } {
  const saldos = d.rows.map((r) => cents(r.saldo!));
  const before = d.rows.map((r) => cents(r.saldo!) - cents(r.amount));
  return {
    opening: unpaired(before, saldos) ?? before[0],
    close: unpaired(saldos, before) ?? saldos[saldos.length - 1],
  };
}

const hasSaldo = (d: Day) => d.rows.every((r) => r.saldo !== null);

/** The file's balance before its first booked row (cents), or null without Saldo. */
export function fileOpening(rows: BookedRow[]): number | null {
  const first = byDay(rows)[0];
  return first && hasSaldo(first) ? dayEnds(first).opening : null;
}

/** The file's balance after its last booked row (cents), or null without Saldo. */
export function fileClosing(rows: BookedRow[]): number | null {
  const days = byDay(rows);
  const last = days[days.length - 1];
  return last && hasSaldo(last) ? dayEnds(last).close : null;
}

/**
 * Nordea's Saldo is a running balance. Day by day, the previous day's closing
 * balance plus the day's amounts must be the Saldo of one of the day's rows
 * (which one depends on the order within the day, which exports do not
 * guarantee). Otherwise rows are missing in between; the check then goes on
 * from the day's own closing balance, so one gap is reported once.
 */
export function balanceBreaks(rows: BookedRow[]): BalanceBreak[] {
  if (rows.length === 0 || rows.some((r) => r.saldo === null)) return [];
  const days = byDay(rows);
  const out: BalanceBreak[] = [];
  let close = dayEnds(days[0]).opening;
  for (const d of days) {
    const expected = close + d.sum;
    if (d.rows.some((r) => cents(r.saldo!) === expected)) {
      close = expected;
      continue;
    }
    const actual = dayEnds(d).close;
    out.push({ date: d.day, expected: euros(expected), actual: euros(actual), difference: euros(actual - expected) });
    close = actual;
  }
  return out;
}

/** The account's balance at the end of `day` (cents), only if a snapshot is from that very day. */
function closingOn(accountId: string, day: string): number | null {
  const b = accountBalances(day).find((x) => x.accountId === accountId);
  return b && b.balance !== null && b.date === day ? cents(b.balance) : null;
}

/** The account's balance before its rows of `day` (cents). */
function openingOn(accountId: string, day: string): number | null {
  const close = closingOn(accountId, day);
  if (close === null) return null;
  const sum = ledgerEntries({ accounts: [accountId], from: day, to: day, includeTransfers: true }).reduce(
    (s, e) => s + cents(e.amount),
    0
  );
  return close - sum;
}

/**
 * Days without data between `from` and `to`. When both balances are known,
 * they tell whether rows are missing or the days were merely quiet.
 */
function dataGap(from: string, to: string, balanceBefore: number | null, balanceAfter: number | null): DataGap | null {
  const range = between(from, to);
  if (!range) return null;
  if (balanceBefore !== null && balanceAfter !== null) {
    const difference = balanceAfter - balanceBefore;
    return { ...range, balance: difference === 0 ? 'matches' : 'differs', difference: difference === 0 ? null : euros(difference) };
  }
  return range.days >= GAP_WITHOUT_BALANCE_MIN_DAYS ? { ...range, balance: 'unknown', difference: null } : null;
}

function analyze(
  rows: BookedRow[],
  file: ImportPreviewFile,
  account: ImportPreviewAccount | null,
  dry: { duplicateCount: number; overlap: { from: string; to: string } | null; transferCount: number }
): ImportPreviewAnalysis {
  let gapBefore: DataGap | null = null;
  let gapAfter: DataGap | null = null;
  let openingMismatch: ImportPreviewAnalysis['openingMismatch'] = null;
  const opening = fileOpening(rows);

  if (account?.firstDate && account.lastDate && file.firstDate && file.lastDate) {
    if (account.lastDate < file.firstDate) {
      gapBefore = dataGap(account.lastDate, file.firstDate, closingOn(account.id, account.lastDate), opening);
    }
    if (file.lastDate < account.firstDate) {
      gapAfter = dataGap(file.lastDate, account.firstDate, fileClosing(rows), openingOn(account.id, account.firstDate));
    }

    // Only when the account's data reaches the day before the file starts
    // (a gap is reported above, with its own balance check).
    const dayBefore = daysBefore(file.firstDate, 1);
    if (account.firstDate <= dayBefore && account.lastDate >= dayBefore && opening !== null) {
      const existing = accountBalances(dayBefore).find((b) => b.accountId === account.id)?.balance ?? null;
      if (existing !== null && cents(existing) !== opening) {
        openingMismatch = {
          date: file.firstDate,
          expected: existing,
          actual: euros(opening),
          difference: euros(opening - cents(existing)),
        };
      }
    }
  }

  const accountIban = compact(account?.iban ?? null);
  return {
    accountId: account?.id ?? null,
    duplicates: dry.duplicateCount,
    newRows: file.bookedCount - dry.duplicateCount,
    overlap: dry.overlap,
    transfers: dry.transferCount,
    gapBefore,
    gapAfter,
    quietPeriods: quietPeriods(rows),
    balanceBreaks: balanceBreaks(rows),
    openingMismatch,
    ibanMismatch: Boolean(file.ownIban && accountIban && file.ownIban !== accountIban),
  };
}

/** Rows needed before a file is guessed to repeat an account. */
export const OVERLAP_GUESS_MIN_ROWS = 3;

/**
 * How many of the file's rows an IBAN-less account already has, by the
 * duplicate rule (same day, amount and counterparty, paired one-to-one), and
 * whether that is an overlap rather than a coincidence: an overlapping export
 * repeats most of the account's rows in the shared period and most of its own
 * rows there, and more than a couple. Plain SQL reads, no dry run.
 */
function overlapScore(account: ImportPreviewAccount, rows: BookedRow[], file: ImportPreviewFile) {
  if (!account.firstDate || !account.lastDate || !file.firstDate || !file.lastDate) return null;
  const from = file.firstDate > account.firstDate ? file.firstDate : account.firstDate;
  const to = file.lastDate < account.lastDate ? file.lastDate : account.lastDate;
  if (from > to) return null;
  const existing = db
    .prepare(
      `SELECT substr(t.booking_date, 1, 10) AS day, t.amount, t.counterparty_name AS counterparty
       FROM normalized_transactions t
       WHERE t.account_id = ? AND t.booking_date IS NOT NULL
         AND t.booking_date >= ? AND t.booking_date < ? AND ${isCanonicalGroupRow('t')}`
    )
    .all(account.id, from, daysBefore(to, -1)) as Array<{ day: string; amount: number; counterparty: string | null }>;
  const key = (day: string, amount: number, counterparty: string | null) => `${day}|${cents(amount)}|${counterparty ?? ''}`;
  const left = new Map<string, number>();
  for (const e of existing) left.set(key(e.day, e.amount, e.counterparty), (left.get(key(e.day, e.amount, e.counterparty)) ?? 0) + 1);
  const inRange = rows.filter((r) => r.day >= from && r.day <= to);
  let matched = 0;
  for (const r of inRange) {
    const k = key(r.day, r.amount, r.counterparty);
    const n = left.get(k) ?? 0;
    if (n > 0) {
      left.set(k, n - 1);
      matched += 1;
    }
  }
  const overlaps =
    matched >= OVERLAP_GUESS_MIN_ROWS && matched * 2 >= existing.length && matched * 2 >= inRange.length;
  return overlaps ? matched : null;
}

function guessTarget(rows: BookedRow[], file: ImportPreviewFile, accounts: ImportPreviewAccount[], newAccount: ImportPreviewGuess['newAccount']): ImportPreviewGuess {
  if (file.ownIban) {
    return file.ownIbanAccount
      ? { accountId: file.ownIbanAccount.id, reason: 'iban', newAccount }
      : { accountId: null, reason: 'none', newAccount };
  }
  // No IBAN (a credit card): the IBAN-less account this file overlaps. A tie
  // is left to the user.
  const scores = accounts
    .filter((a) => !a.iban)
    .map((a) => ({ id: a.id, n: overlapScore(a, rows, file) }))
    .filter((s): s is { id: string; n: number } => s.n !== null)
    .sort((a, b) => b.n - a.n);
  if (scores.length > 0 && (scores.length === 1 || scores[0].n > scores[1].n)) {
    return { accountId: scores[0].id, reason: 'overlap', overlapCount: scores[0].n, newAccount };
  }
  return { accountId: null, reason: 'none', newAccount };
}

export type PreviewInput = {
  records: Record<string, unknown>[];
  checksum: string;
  filename: string;
  format: string;
  /** Preview as an import into this existing account instead of the guess. */
  accountId?: string;
  /** Preview as an import into a new account instead of the guess. */
  asNewAccount?: boolean;
};

/**
 * What importing this file would do. Writes nothing. Without a named target
 * it also guesses one, and the numbers are for the guess. Exactly one dry run.
 */
export function previewImport(input: PreviewInput): ImportPreview {
  const { records, checksum, filename, format } = input;
  const file = summarizeFile(records, filename);
  const accounts = previewAccounts();
  const rows = bookedRowsInTimeOrder(records);
  const newAccount = { name: file.suggestedName, subtype: suggestSubtype(filename, file.ownIban) };

  if (input.accountId && !accounts.some((a) => a.id === input.accountId)) throw new DomainError('account_not_found', 404);
  const named = input.accountId !== undefined || input.asNewAccount === true;
  const guess = named ? null : guessTarget(rows, file, accounts, newAccount);
  const targetId = input.asNewAccount ? null : (input.accountId ?? guess?.accountId ?? null);
  const target = targetId ? accounts.find((a) => a.id === targetId)! : null;

  const dry = dryRunImport({
    records,
    checksum,
    filename,
    sourceBank: 'Nordea',
    format,
    target: target ? { accountId: target.id } : { newAccount },
    // The preview shows the mismatch; the import asks for confirmation.
    allowIbanMismatch: true,
  });

  return { file, accounts, guess, analysis: analyze(rows, file, target, dry) };
}
