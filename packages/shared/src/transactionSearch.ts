import { z } from 'zod';
import { isoDate } from './schemas.js';
import type { AccountType, OwnTransferKind } from './accounts.js';

// Contract for GET /transactions/search. The field shape is shared by the API
// (validated after query-string coercion) and the MCP tool input schema.

export const TRANSACTION_SEARCH_MAX_LIMIT = 500;

export const transactionSearchFields = {
  from: isoDate.optional().describe('Inclusive start booking date'),
  to: isoDate.optional().describe('Inclusive end booking date'),
  q: z.string().trim().min(1).max(100).optional().describe('Text match on counterparty or description (case-insensitive for ASCII letters)'),
  categoryId: z.string().min(1).optional().describe('Category id from list_categories'),
  accountId: z.string().min(1).optional().describe('Account id from list_accounts'),
  minAmount: z.number().finite().optional().describe('Signed amount lower bound (expenses are negative)'),
  maxAmount: z.number().finite().optional().describe('Signed amount upper bound (expenses are negative)'),
  includeTransfers: z.boolean().default(false).describe('Include account-to-account transfers'),
  limit: z.number().int().min(1).max(TRANSACTION_SEARCH_MAX_LIMIT).default(50),
  offset: z.number().int().min(0).default(0),
};

export const transactionSearchSchema = z.object(transactionSearchFields);
export type TransactionSearchInput = z.input<typeof transactionSearchSchema>;
export type TransactionSearchParams = z.output<typeof transactionSearchSchema>;

export type TransactionSearchRow = {
  id: string;
  bookingDate: string | null;
  amount: number;
  currency: string;
  counterpartyName: string | null;
  description: string | null;
  categoryId: string | null;
  categoryName: string | null;
  accountId: string;
  accountName: string;
  isTransfer: boolean;
  /**
   * Set when the transaction is a transfer to (or from) a manual account: that
   * account's name and type and how the transfer is reported. Never its IBAN.
   */
  ownTransfer: { accountId: string; accountName: string; accountType: AccountType; kind: OwnTransferKind } | null;
};

export type TransactionSearchResult = {
  total: number;
  limit: number;
  offset: number;
  items: TransactionSearchRow[];
};
