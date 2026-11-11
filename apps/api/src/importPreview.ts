// Import preview: what an upload would do, before anything is written.
//
// Counts that depend on the database (duplicates, transfers) come from a dry
// run of the real import pipeline (`dryRunImport`), so they are exactly what
// the import then does. Checks of the file itself (gaps, quiet periods, the
// running balance) are pure functions over the parsed rows plus Ledger reads.
import {
  QUIET_PERIOD_MIN_DAYS,
  type AccountSubtype,
  type BalanceBreak,
  type DayRange,
  type ImportPreview,
  type ImportPreviewAccount,
  type ImportPreviewAnalysis,
  type ImportPreviewFile,
  type ImportPreviewGuess,
} from '@finance-app/shared';
import { db } from './db.js';
import { DomainError } from './http/errors.js';
import { accountBalances, daysBefore } from './ledger.js';
import {
  accountIdByIban,
  accountNameTaken,
  dryRunImport,
  getField,
  inferAccount,
  isNewestFirst,
  parseAmount,
  parseDate,
  type ImportTarget,
} from './importer.js';
import { isCanonicalGroupRow } from './sql/transactions.js';

type BookedRow = { day: string; amount: number; saldo: number | null };

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
    rows.push({ day: date.slice(0, 10), amount, saldo: parseAmount(getField(record, 'Saldo')) });
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

/**
 * Nordea's Saldo is a running balance. Day by day, the previous day's closing
 * balance plus the day's amounts must give the day's closing balance (its
 * last row's Saldo); a difference means rows are missing in between. The
 * first day starts from the balance implied by its first row.
 */
export function balanceBreaks(rows: BookedRow[]): BalanceBreak[] {
  const withSaldo = rows.filter((r) => r.saldo !== null);
  if (withSaldo.length === 0 || withSaldo.length !== rows.length) return [];
  const out: BalanceBreak[] = [];
  let close = cents(rows[0].saldo! - rows[0].amount);
  for (let i = 0; i < rows.length; ) {
    const day = rows[i].day;
    let sum = 0;
    let last = rows[i];
    for (; i < rows.length && rows[i].day === day; i++) {
      sum += cents(rows[i].amount);
      last = rows[i];
    }
    const expected = close + sum;
    const actual = cents(last.saldo!);
    if (expected !== actual) out.push({ date: day, expected: euros(expected), actual: euros(actual), difference: euros(actual - expected) });
    close = actual;
  }
  return out;
}

function analyze(
  records: Record<string, unknown>[],
  file: ImportPreviewFile,
  account: ImportPreviewAccount | null,
  dry: { normalizedCount: number; duplicateCount: number; overlap: { from: string; to: string } | null; transferCount: number }
): ImportPreviewAnalysis {
  const rows = bookedRowsInTimeOrder(records);
  let gapBefore: DayRange | null = null;
  let gapAfter: DayRange | null = null;
  let openingMismatch: ImportPreviewAnalysis['openingMismatch'] = null;

  if (account?.firstDate && account.lastDate && file.firstDate && file.lastDate) {
    if (account.lastDate < file.firstDate) gapBefore = between(account.lastDate, file.firstDate);
    if (file.lastDate < account.firstDate) gapAfter = between(file.lastDate, account.firstDate);

    // Only when the account's data reaches the day before the file starts:
    // after a gap the balance is expected to differ by the missing rows.
    const dayBefore = daysBefore(file.firstDate, 1);
    const first = rows[0];
    if (account.firstDate <= dayBefore && account.lastDate >= dayBefore && first?.saldo != null) {
      const existing = accountBalances(dayBefore).find((b) => b.accountId === account.id)?.balance ?? null;
      const opening = cents(first.saldo - first.amount);
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
    newRows: dry.normalizedCount - dry.duplicateCount,
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

export type PreviewInput = {
  records: Record<string, unknown>[];
  checksum: string;
  filename: string;
  format: string;
  /** Preview as an import into this existing account instead of the guess. */
  accountId?: string;
};

/** What importing this file would do. Writes nothing. */
export function previewImport(input: PreviewInput): ImportPreview {
  const { records, checksum, filename, format } = input;
  const file = summarizeFile(records, filename);
  const accounts = previewAccounts();
  const dryRun = (target: ImportTarget) => dryRunImport({ records, checksum, filename, sourceBank: 'Nordea', format, target });

  const newAccount = { name: file.suggestedName, subtype: suggestSubtype(filename, file.ownIban) };
  let guess: ImportPreviewGuess = { accountId: null, reason: 'none', newAccount };
  if (file.ownIban) {
    const id = accountIdByIban(file.ownIban);
    if (id) guess = { accountId: id, reason: 'iban', newAccount };
  } else {
    // No IBAN (a credit card): the account whose rows this file repeats most.
    // A tie is left to the user rather than guessed.
    const scores = accounts
      .filter((a) => !a.iban && a.transactionCount > 0)
      .map((a) => ({ id: a.id, n: dryRun({ accountId: a.id }).duplicateCount }))
      .filter((s) => s.n > 0)
      .sort((a, b) => b.n - a.n);
    if (scores.length > 0 && (scores.length === 1 || scores[0].n > scores[1].n)) {
      guess = { accountId: scores[0].id, reason: 'overlap', overlapCount: scores[0].n, newAccount };
    }
  }

  if (input.accountId && !accounts.some((a) => a.id === input.accountId)) throw new DomainError('account_not_found', 404);
  const targetId = input.accountId ?? guess.accountId;
  const target = targetId ? accounts.find((a) => a.id === targetId)! : null;
  const dry = dryRun(target ? { accountId: target.id } : { newAccount });

  return { file, accounts, guess, analysis: analyze(records, file, target, dry) };
}
