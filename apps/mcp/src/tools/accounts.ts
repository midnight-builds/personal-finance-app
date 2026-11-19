import { z } from 'zod';
import {
  ACCOUNT_CHANGE_MAX_LISTED_TRANSFERS,
  ACCOUNT_TYPES,
  accountApplyRequestSchema,
  accountChangeSetListFields,
  accountPlanRequestSchema,
} from '@finance-app/shared';
import { READ_ONLY, UNDOABLE_WRITE, defineTool, type ToolDefinition } from './types.js';

// Account management (GLOSSARY.md, "Account", "Transfer to a manual account"):
// planned first, applied with the plan's token, undoable as a whole, recorded
// under this server's actor. This agent is trusted like the user in the web UI,
// so it may also SET a manual account's IBAN; but no response ever contains an
// IBAN: plans and change sets say only recognizesTransfers (docs/MCP.md).

const ERROR_CODES =
  'Errors come back as "Finance API error <status>: {"error": <code>, "details": ...}": 400 invalid_request ' +
  '(e.g. op.iban: iban_invalid); 404 account_not_found, change_set_not_found; 409 plan_stale, account_name_exists, ' +
  'iban_in_use (another account has that IBAN), account_imported (an imported account\'s IBAN and currency come from ' +
  'its exports; it cannot be archived), account_archived, account_not_archived, nothing_to_change, already_undone, ' +
  'cannot_undo_undo.';

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
      'undo (changeSetId from list_account_changes; fields changed since are left alone and reported). ' +
      `type is one of ${ACCOUNT_TYPES.join(', ')}. ` +
      'A manual account\'s IBAN makes payments between it and imported accounts transfers to that account: ' +
      'savings/investment = saving, loan/other_liability = loan repayment (both still reduce cash in cash flow and ' +
      'net, but are never spending in insights); other types are reported like any payment. The IBAN is write-only: ' +
      'responses only say recognizesTransfers. Returns { kind, op, account, changes [{field, from, to}], transfers ' +
      `{ recognized, released, reclassified (still transfers, other kind) with their totals } (transactions whose reporting changes; at most ` +
      `${ACCOUNT_CHANGE_MAX_LISTED_TRANSFERS} listed each), exceptions, planToken }. Review it, then call ` +
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
      'reason, status, accountId, op, changes, transfers, exceptions), recorded under this server\'s actor and ' +
      'undoable with an undo op. Changes account settings only: transactions, amounts, categories and balances are ' +
      'never written, and nothing is deleted. ' +
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
    name: 'get_account_change',
    title: 'Account change set',
    description: 'One account change set by id: its op, actor, reason, status, changes, transfers and exceptions.',
    inputSchema: { id: z.string().trim().min(1).max(100).describe('Change set id') },
    annotations: READ_ONLY,
    run: ({ id }, { api }) => api.get(`/accounts/change-sets/${encodeURIComponent(id)}`),
  }),
];
