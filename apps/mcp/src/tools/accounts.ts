import { z } from 'zod';
import {
  ACCOUNT_CHANGE_MAX_LISTED_TRANSFERS,
  ACCOUNT_TYPES,
  accountApplyRequestSchema,
  accountChangeSetListFields,
  accountPlanRequestSchema,
} from '@finance-app/shared';
import { READ_ONLY, UNDOABLE_WRITE, defineTool, type ToolDefinition } from './types.js';

// Account management (GLOSSARY.md, "Account", "Transfer to a manual account",
// "Balance observation"): planned first, applied with the plan's token, undoable
// as a whole, recorded under this server's actor. Dated balance observations are
// account change sets too. This agent is trusted like the user in the web UI,
// so it may also SET a manual account's IBAN; but no response ever contains an
// IBAN: plans and change sets say only recognizesTransfers (docs/MCP.md).

const ERROR_CODES =
  'Errors come back as "Finance API error <status>: {"error": <code>, "details": ...}": 400 invalid_request ' +
  '(e.g. op.iban: iban_invalid); 404 account_not_found, change_set_not_found; 409 plan_stale, account_name_exists, ' +
  'iban_in_use (another account has that IBAN), account_imported (an imported account\'s IBAN and currency come from ' +
  'its exports; it cannot be archived), account_archived, account_not_archived, nothing_to_change, already_undone, ' +
  'cannot_undo_undo; observations: 400 date_in_future, debt_negative (a liability\'s debt is never negative; a card ' +
  'in credit cannot be entered); 404 observation_not_found; 409 observation_exists (that day ' +
  'has one: correct it, details.observationId), snapshot_exists (the bank reported that day\'s balance), ' +
  'snapshot_imported (the bank\'s balance is never edited), account_has_observations (a type change across ' +
  'asset/liability or a currency change would reinterpret stored balances; details.field).';

export const accountTools: ToolDefinition[] = [
  defineTool({
    name: 'plan_account_change',
    title: 'Plan an account change',
    description:
      'Work out an account change WITHOUT writing anything. op.kind is one of: ' +
      'create_account (a manual account: nothing is imported into it; name, type, optional ownershipShare 0-100 ' +
      '(default 100), currency (default EUR), iban, updateIntervalDays); ' +
      'update_account (accountId from list_accounts and any of name, type, ownershipShare, updateIntervalDays (null ' +
      'removes), and for manual accounts currency and iban (null removes)); ' +
      'archive_account (a manual account: hidden, its transfers count as ordinary payments again; nothing deleted; it ' +
      'keeps its name and IBAN); unarchive_account (brings an archived account back, also one whose creation was undone); ' +
      'add_balance_observation (accountId, date YYYY-MM-DD today or earlier, amount, optional note on where it comes ' +
      'from: the balance at the end of that day; for credit_card, loan and other_liability the DEBT as a POSITIVE ' +
      'amount (never negative), stored as a negative balance; one per account and day; works for imported accounts too, as an anchor ' +
      'between the bank\'s balances, never added to them); correct_balance_observation (observationId from ' +
      'list_balance_observations and any of date, amount, note (null removes)); delete_balance_observation ' +
      '(observationId; kept in the change set, undo restores it). An observation creates no transactions and never ' +
      'changes cash flow; nothing is estimated between two observations. ' +
      'undo (changeSetId from list_account_changes; fields changed since are left alone and reported). ' +
      `type is one of ${ACCOUNT_TYPES.join(', ')}. ` +
      'A manual account\'s IBAN makes payments between it and imported accounts transfers to that account: ' +
      'savings/investment = saving, loan/other_liability = loan repayment (both still reduce cash in cash flow and ' +
      'net, but are never spending in insights); other types are reported like any payment. The IBAN is write-only: ' +
      'responses only say recognizesTransfers. Returns { kind, op, account, changes [{field, from, to}], transfers ' +
      `{ recognized, released, reclassified (still transfers, other kind) with their totals } (transactions whose reporting changes; at most ` +
      `${ACCOUNT_CHANGE_MAX_LISTED_TRANSFERS} listed each), observation { before, after } (observation ops; null ` +
      'otherwise), exceptions, planToken }. Review it, then call ' +
      'apply_account_change with the same op and the planToken. ' +
      ERROR_CODES,
    inputSchema: accountPlanRequestSchema.shape,
    annotations: READ_ONLY,
    run: (args, { api }) => api.post('/accounts/plan', args),
  }),
  defineTool({
    name: 'apply_account_change',
    title: 'Apply a planned account change',
    description:
      'Apply a change worked out with plan_account_change: pass the identical op (with the same iban, if any) and its ' +
      'planToken. Refused with 409 plan_stale if the account or the transactions the plan listed changed since; plan ' +
      'again then. Applying the same token twice returns the same change set. Returns the change set (id, actor, kind, ' +
      'reason, status, accountId, op, changes, transfers, observation, exceptions), recorded under this server\'s ' +
      'actor and undoable with an undo op. Changes account settings and balance observations only: transactions, ' +
      'amounts, categories and the bank\'s balances are never written; a deleted observation stays in its change ' +
      'set. ' +
      ERROR_CODES,
    inputSchema: accountApplyRequestSchema.shape,
    annotations: UNDOABLE_WRITE,
    run: (args, { api }) => api.post('/accounts/apply', args),
  }),
  defineTool({
    name: 'list_account_changes',
    title: 'Account change log',
    description:
      'Applied account change sets, newest first, from every actor (user = the web UI). Each item: id, createdAt, ' +
      'actor, kind, reason, status (applied or undone), undoOfId, undoneById, accountId, summary. Optional accountId ' +
      'narrows to one account. Returns { total, limit, offset, items }.',
    inputSchema: accountChangeSetListFields,
    annotations: READ_ONLY,
    run: (args, { api }) => api.get('/accounts/change-sets', args),
  }),
  defineTool({
    name: 'list_balance_observations',
    title: 'Balance observations of an account',
    description:
      'One account\'s dated balance observations, newest first: id (for correct/delete), date, balance (signed: debt ' +
      'negative), debt (liabilities: the debt as a positive amount; null otherwise), currency, note, actor, createdAt, ' +
      'updatedAt, and for imported accounts reconciliation { previousDate, previousBalance, bookedSum, bookedCount, ' +
      'difference } against the previous balance and the bookings in between (non-zero = the bookings and the two ' +
      'balances disagree; nothing is booked to even it out). Also latest { date, balance, debt, source: import | ' +
      'manual } (null = unknown), ageDays, stale (older than updateIntervalDays) and imported { count, firstDate, ' +
      'lastDate } (the bank\'s balances, not editable).',
    inputSchema: { accountId: z.string().trim().min(1).max(100).describe('Account id from list_accounts') },
    annotations: READ_ONLY,
    run: ({ accountId }, { api }) => api.get(`/accounts/${encodeURIComponent(accountId)}/balance-observations`),
  }),
  defineTool({
    name: 'get_account_change',
    title: 'Account change set',
    description: 'One account change set by id: its op, actor, reason, status, changes, transfers and exceptions.',
    inputSchema: { id: z.string().trim().min(1).max(100).describe('Change set id') },
    annotations: READ_ONLY,
    run: ({ id }, { api }) => api.get(`/accounts/change-sets/${encodeURIComponent(id)}`),
  }),
];
