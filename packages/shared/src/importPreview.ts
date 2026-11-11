import { z } from 'zod';

// Contract for the import flow: POST /imports/nordea/preview (writes nothing)
// and the optional target fields of POST /imports/nordea/csv|xlsx.

export const ACCOUNT_SUBTYPES = ['checking', 'savings', 'credit_card'] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

/** Days without any row inside a file that count as a quiet period. */
export const QUIET_PERIOD_MIN_DAYS = 14;

/**
 * Multipart text fields naming where an import goes. At most one of
 * `accountId` and `newAccountName` (+ `newAccountSubtype`); neither = infer
 * from the file's own IBAN.
 */
export const importTargetFieldsSchema = z
  .object({
    accountId: z.string().trim().min(1).optional(),
    newAccountName: z.string().trim().min(1).max(80).optional(),
    newAccountSubtype: z.enum(ACCOUNT_SUBTYPES).optional(),
    /**
     * "1": import even though the file's own IBAN belongs to another account
     * (409 `iban_mismatch` / `iban_in_use` otherwise).
     */
    allowIbanMismatch: z.enum(['1']).optional(),
  })
  .refine((v) => !(v.accountId && v.newAccountName), { message: 'account_id_and_new_account_are_exclusive' })
  .refine((v) => !v.newAccountName || v.newAccountSubtype, {
    message: 'new_account_subtype_required',
    path: ['newAccountSubtype'],
  });
export type ImportTargetFields = z.output<typeof importTargetFieldsSchema>;

/**
 * Preview fields: the numbers are for `accountId`, or for a new account when
 * `asNewAccount` is "1"; with neither, for the guess (a new account if none).
 */
export const importPreviewFieldsSchema = z
  .object({
    accountId: z.string().trim().min(1).optional(),
    asNewAccount: z.enum(['1']).optional(),
  })
  .refine((v) => !(v.accountId && v.asNewAccount), { message: 'account_id_and_new_account_are_exclusive' });

export type ImportPreviewFile = {
  filename: string;
  rowCount: number;
  /** Rows with a booking date. */
  bookedCount: number;
  /** Rows whose Kirjauspäivä is "Varaus". */
  pendingCount: number;
  /** Rows without a readable amount; kept as raw rows only. */
  skippedCount: number;
  firstDate: string | null;
  lastDate: string | null;
  /** The account's own IBAN as the export names it (rows, then file name), compact. */
  ownIban: string | null;
  /** The account that already holds `ownIban`, if any. */
  ownIbanAccount: { id: string; name: string } | null;
  suggestedName: string;
  /** The export carries Nordea's running balance (Saldo). */
  hasRunningBalance: boolean;
};

export type ImportPreviewAccount = {
  id: string;
  name: string;
  iban: string | null;
  subtype: AccountSubtype;
  /** Booked range and count of its rows, one per duplicate group. */
  firstDate: string | null;
  lastDate: string | null;
  transactionCount: number;
};

export type ImportGuessReason = 'iban' | 'overlap' | 'none';

export type ImportPreviewGuess = {
  accountId: string | null;
  reason: ImportGuessReason;
  /** Rows that would group as duplicates with the guessed account (reason 'overlap'). */
  overlapCount?: number;
  /** What to create when the user picks "new account". */
  newAccount: { name: string; subtype: AccountSubtype };
};

export type DayRange = { from: string; to: string; days: number };

/** Days without data between an account's rows and a file. */
export type DataGap = DayRange & {
  /**
   * Does the running balance carry over the gap? 'matches': nothing is
   * missing, the days were just quiet (e.g. a weekend). 'differs': rows are
   * missing, `difference` is their sum. 'unknown': no Saldo to compare (only
   * reported from GAP_WITHOUT_BALANCE_MIN_DAYS days).
   */
  balance: 'matches' | 'differs' | 'unknown';
  difference: number | null;
};

/** Without a balance to compare, shorter gaps are ordinary quiet days. */
export const GAP_WITHOUT_BALANCE_MIN_DAYS = 7;

export type BalanceBreak = {
  /** Day whose rows' Saldo does not follow from the previous day's balance. */
  date: string;
  expected: number;
  actual: number;
  /** actual − expected: the sum of the rows missing in between. */
  difference: number;
};

export type ImportPreviewAnalysis = {
  /** The account the numbers are for; null = a new account. */
  accountId: string | null;
  /** Rows the import would group with already imported rows. */
  duplicates: number;
  /** Booked rows that are not duplicates; pending rows ("Varaus") are not counted. */
  newRows: number;
  overlap: { from: string; to: string } | null;
  /** Rows the import would link as transfers between own accounts. */
  transfers: number;
  /** Days missing between the account's existing data and this file. */
  gapBefore: DataGap | null;
  gapAfter: DataGap | null;
  quietPeriods: DayRange[];
  balanceBreaks: BalanceBreak[];
  /** The file's implied opening balance vs. the account's balance the day before. */
  openingMismatch: { date: string; expected: number; actual: number; difference: number } | null;
  ibanMismatch: boolean;
};

export type ImportPreview = {
  file: ImportPreviewFile;
  accounts: ImportPreviewAccount[];
  /**
   * Only when the request named no target (`accountId` / `asNewAccount`):
   * the client asks once and keeps it while the user changes the target.
   */
  guess: ImportPreviewGuess | null;
  analysis: ImportPreviewAnalysis;
};
