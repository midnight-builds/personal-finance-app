import { z } from 'zod';
import { isoDate } from './schemas.js';
import type { AccountTracking, AccountType } from './accounts.js';

// Contracts for GET /balances/history and GET /net-worth. The field shape is
// shared by the API (validated after query-string coercion) and the MCP tool
// input schema. Net worth (GLOSSARY.md, "Net worth") weighs each account by its
// ownership share; cash flow never does. Totals are in EUR: accounts in another
// currency are never converted, they get totals of their own (`otherCurrencies`).

export const BALANCE_HISTORY_INTERVALS = ['day', 'week', 'month'] as const;
export type BalanceHistoryInterval = (typeof BALANCE_HISTORY_INTERVALS)[number];

/** Most points one request may return. */
export const BALANCE_HISTORY_MAX_POINTS = 400;

export const balanceHistoryFields = {
  from: isoDate.optional().describe('First day (YYYY-MM-DD). Default: 12 months before `to`'),
  to: isoDate.optional().describe('Last day (YYYY-MM-DD). Default: the latest booking date in the data'),
  interval: z
    .enum(BALANCE_HISTORY_INTERVALS)
    .default('month')
    .describe('One point per day, per week (ending Sunday) or per month (month end); the last point is `to`'),
};

export const balanceHistorySchema = z.object(balanceHistoryFields);
export type BalanceHistoryParams = z.output<typeof balanceHistorySchema>;

export type BalanceHistoryAccount = {
  id: string;
  name: string;
  subtype: AccountType;
  tracking: AccountTracking;
  /** Never converted: an account in another currency counts in `otherCurrencies`, not in the EUR totals. */
  currency: string;
  /** 0–100; net worth counts this share of the balance. */
  ownershipShare: number;
  /** First day with a balance (the first balance snapshot or observation), or null if none. */
  knownFrom: string | null;
  /**
   * Imported: the last day its imported data covers; later days are unknown.
   * Manual: null, its latest observation holds until the next one (check `stale`).
   */
  knownUntil: string | null;
};

/** Net worth over a group of accounts of one currency. */
export type NetWorthTotals = {
  currency: string;
  /** Known asset balances times ownership share; null when no account is known. */
  assets: number | null;
  /** Known debt (liability types with a negative balance) times ownership share, positive; null when no account is known. */
  liabilities: number | null;
  /** assets − liabilities over the included accounts only; null when no account is known. */
  netWorth: number | null;
  /** True when there are accounts and every one's balance is known. */
  isComplete: boolean;
  coverage: { includedAccountIds: string[]; missingAccountIds: string[] };
};

export type BalanceHistoryPoint = Omit<NetWorthTotals, 'currency'> & {
  /** End of the period, YYYY-MM-DD. */
  date: string;
  /** Every account; balance null = unknown on that day (never zero). `ownedBalance` = balance × ownership share. */
  accounts: Array<{ accountId: string; balance: number | null; ownedBalance: number | null; balanceDate: string | null }>;
  /** Accounts in other currencies, one group per currency, never converted or added to the EUR totals. */
  otherCurrencies: NetWorthTotals[];
};

export type BalanceHistory = {
  from: string;
  to: string;
  interval: BalanceHistoryInterval;
  accounts: BalanceHistoryAccount[];
  points: BalanceHistoryPoint[];
};

/** One account in the current net worth (GET /net-worth). */
export type NetWorthAccount = {
  accountId: string;
  name: string;
  type: AccountType;
  tracking: AccountTracking;
  currency: string;
  ownershipShare: number;
  /** Latest known balance, signed; null = unknown (never zero). */
  balance: number | null;
  ownedBalance: number | null;
  balanceDate: string | null;
  /** `import`: the bank's balance; `manual`: a balance observation. */
  source: 'import' | 'manual' | null;
  ageDays: number | null;
  /** It has an update interval and its balance is older than that; still counted. */
  stale: boolean;
  /** Why the balance is unknown: no balance yet, or (imported) bookings came after the balance it rests on. */
  unknownReason: 'no_balance' | 'bookings_after_balance' | null;
};

/** Every account's latest balance and the net worth over them (each account at its own latest date). */
export type NetWorth = NetWorthTotals & {
  /** Today in Helsinki: ages are counted to it. */
  asOf: string;
  accounts: NetWorthAccount[];
  /** Included accounts whose balance is stale. */
  staleAccountIds: string[];
  otherCurrencies: NetWorthTotals[];
};
