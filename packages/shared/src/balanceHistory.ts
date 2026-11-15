import { z } from 'zod';
import { isoDate } from './schemas.js';

// Contract for GET /balances/history. The field shape is shared by the API
// (validated after query-string coercion) and the MCP tool input schema.

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
  subtype: 'checking' | 'savings' | 'credit_card';
  /** First day with a balance (the first balance snapshot), or null if none. */
  knownFrom: string | null;
  /** Last day the imported data covers; later days are unknown. */
  knownUntil: string | null;
};

export type BalanceHistoryPoint = {
  /** End of the period, YYYY-MM-DD. */
  date: string;
  /** Every account; balance null = unknown on that day (never zero). */
  accounts: Array<{ accountId: string; balance: number | null; balanceDate: string | null }>;
  /** Known balances of bank accounts (and credit cards in credit). */
  assets: number;
  /** Known credit card debt, positive. */
  liabilities: number;
  /** assets − liabilities over the included accounts only. */
  netWorth: number;
  /** True when every account's balance is known on this day. */
  isComplete: boolean;
  coverage: { includedAccountIds: string[]; missingAccountIds: string[] };
};

export type BalanceHistory = {
  from: string;
  to: string;
  interval: BalanceHistoryInterval;
  accounts: BalanceHistoryAccount[];
  /** Asset classes the app does not track at all, so net worth never includes them. */
  untrackedAssetClasses: string[];
  points: BalanceHistoryPoint[];
};
