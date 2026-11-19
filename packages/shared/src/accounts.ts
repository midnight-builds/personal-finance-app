import { z } from 'zod';
import { isoDate } from './schemas.js';

// The account model (GLOSSARY.md, "Account", "Tracking", "Transfer to a manual
// account", "Balance observation"; docs/adr/0002-transfers-to-manual-accounts.md,
// docs/adr/0003-balance-observations-are-snapshots.md) and the contract of
// account change sets: POST /accounts/plan, POST /accounts/apply and the
// change-set listing. Shared by the API, the web app and the MCP tools.

/** Every account type. An import creates checking, savings or credit_card accounts. */
export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'credit_card',
  'loan',
  'investment',
  'property',
  'other_asset',
  'other_liability',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Types whose balance is debt. Debt is entered as a positive amount (`balanceFromDebt`). */
export const LIABILITY_TYPES: readonly AccountType[] = ['credit_card', 'loan', 'other_liability'];
export const isLiabilityType = (type: string): boolean => (LIABILITY_TYPES as readonly string[]).includes(type);

/**
 * The sign convention: a user (or agent) states debt as a positive amount ("I owe
 * 1 200"); stored balances are signed, so debt is a negative balance, as the bank
 * reports a credit card's. Anything else is stored as given.
 */
export function balanceFromDebt(type: string, amount: number): number {
  return isLiabilityType(type) ? -Math.abs(amount) : amount;
}

/**
 * Types whose balance is cash for the runway: what can pay next month's bills
 * (a credit card's debt reduces it). Loans, investments, property and other
 * assets or liabilities count in net worth only.
 */
export const CASH_TYPES: readonly AccountType[] = ['checking', 'savings', 'credit_card'];
export const isCashType = (type: string): boolean => (CASH_TYPES as readonly string[]).includes(type);

/** Whole days from `from` to `to` (YYYY-MM-DD; negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * How old an account's balance is on `today`, and whether it is stale: the
 * account has an update interval and its balance is older than that. An
 * account without a balance is unknown, not stale (`ageDays` null).
 */
export function balanceStaleness(
  balanceDate: string | null,
  updateIntervalDays: number | null,
  today: string
): { ageDays: number | null; stale: boolean } {
  if (balanceDate === null) return { ageDays: null, stale: false };
  const ageDays = daysBetween(balanceDate.slice(0, 10), today);
  return { ageDays, stale: updateIntervalDays !== null && ageDays > updateIntervalDays };
}

/** `imported`: transactions and balances come from bank exports. `manual`: nothing is imported. */
export const ACCOUNT_TRACKINGS = ['imported', 'manual'] as const;
export type AccountTracking = (typeof ACCOUNT_TRACKINGS)[number];

/**
 * How a transfer between an imported account and a manual one is reported, by
 * the manual account's type: `saving` and `loan_repayment` are never
 * consumption; `other` (a manual checking account, card, property or other
 * asset) is reported like any payment. All three count in cash flow.
 */
export const OWN_TRANSFER_KINDS = ['saving', 'loan_repayment', 'other'] as const;
export type OwnTransferKind = (typeof OWN_TRANSFER_KINDS)[number];

export function ownTransferKind(type: string): OwnTransferKind {
  if (type === 'savings' || type === 'investment') return 'saving';
  if (type === 'loan' || type === 'other_liability') return 'loan_repayment';
  return 'other';
}

/** An IBAN as stored and compared: no spaces, upper case. */
export const compactIban = (iban: string) => iban.replace(/\s+/g, '').toUpperCase();

/** Structure (country, check digits, 11–30 letters or digits) and the ISO 13616 mod-97 check. */
export function isValidIban(value: string): boolean {
  const iban = compactIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

export const ACCOUNT_NAME_MAX = 80;
/** Most transactions a plan or change set lists per direction; the totals count all. */
export const ACCOUNT_CHANGE_MAX_LISTED_TRANSFERS = 200;

const id = z.string().trim().min(1).max(100);
const reason = z.string().trim().min(1).max(500).optional().describe('Why the change is made; stored with the change set');
const name = z.string().trim().min(1).max(ACCOUNT_NAME_MAX).describe('Account name; the only name agents see');
const type = z.enum(ACCOUNT_TYPES).describe(`One of ${ACCOUNT_TYPES.join(', ')}`);
const ownershipShare = z
  .number()
  .min(0)
  .max(100)
  .describe('Your share in percent, 0–100 (default 100). Used only for net worth, never for cash flow');
const currency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'ISO 4217 code, e.g. EUR')
  .transform((c) => c.toUpperCase())
  .describe('ISO 4217 currency code; no conversion is ever made');
const iban = z
  .string()
  .trim()
  .max(50)
  .refine(isValidIban, 'iban_invalid')
  .transform(compactIban)
  .describe(
    "The account's IBAN (manual accounts only). Payments between it and imported accounts become transfers to this " +
      'account. Write-only: never returned, responses only say recognizesTransfers'
  );
const updateIntervalDays = z
  .number()
  .int()
  .min(1)
  .max(3650)
  .describe('How often, in days, the balance is meant to be updated (staleness)');

const observationId = id.describe('Balance observation id from list_balance_observations');
const observationDate = isoDate.describe('The day the balance is for (YYYY-MM-DD; today or earlier, never in the future)');
const observationAmount = z
  .number()
  .finite()
  .min(-1e12)
  .max(1e12)
  .describe(
    'The balance at the end of that day in the account currency. For credit_card, loan and other_liability state the ' +
      'DEBT as a positive amount (owing 1200 = 1200); it is stored as a negative balance. Other types: the balance as is'
  );
const observationNote = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe('Where the balance comes from, e.g. "card statement" or "checked in the bank app"');

export const accountOpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create_account'),
    name,
    type,
    ownershipShare: ownershipShare.optional(),
    currency: currency.optional(),
    iban: iban.optional(),
    updateIntervalDays: updateIntervalDays.optional(),
    reason,
  }),
  z
    .object({
      kind: z.literal('update_account'),
      accountId: id.describe('Account id from list_accounts'),
      name: name.optional(),
      type: type.optional(),
      ownershipShare: ownershipShare.optional(),
      currency: currency.optional(),
      iban: iban.nullable().optional().describe('New IBAN (manual accounts only); null removes it'),
      updateIntervalDays: updateIntervalDays.nullable().optional().describe('Days between balance updates; null removes it'),
      reason,
    })
    .refine(
      (op) =>
        ['name', 'type', 'ownershipShare', 'currency', 'iban', 'updateIntervalDays'].some(
          (k) => (op as Record<string, unknown>)[k] !== undefined
        ),
      'nothing_to_change'
    ),
  z.object({ kind: z.literal('archive_account'), accountId: id, reason }),
  z.object({
    kind: z.literal('unarchive_account'),
    accountId: id.describe('An archived account; it keeps its name and IBAN while archived'),
    reason,
  }),
  z.object({
    kind: z.literal('add_balance_observation'),
    accountId: id.describe('Account id from list_accounts'),
    date: observationDate,
    amount: observationAmount,
    note: observationNote.optional(),
    reason,
  }),
  z
    .object({
      kind: z.literal('correct_balance_observation'),
      observationId,
      date: observationDate.optional(),
      amount: observationAmount.optional(),
      note: observationNote.nullable().optional().describe('New note; null removes it'),
      reason,
    })
    .refine(
      (op) => op.date !== undefined || op.amount !== undefined || op.note !== undefined,
      'nothing_to_change'
    ),
  z.object({ kind: z.literal('delete_balance_observation'), observationId, reason }),
  z.object({ kind: z.literal('undo'), changeSetId: id.describe('Account change set id'), reason }),
]);

/** Operations on an account's dated balance observations (GLOSSARY.md, "Balance observation"). */
export const OBSERVATION_OP_KINDS = ['add_balance_observation', 'correct_balance_observation', 'delete_balance_observation'] as const;
export const isObservationOpKind = (kind: string): boolean => (OBSERVATION_OP_KINDS as readonly string[]).includes(kind);

export type AccountOpInput = z.input<typeof accountOpSchema>;
export type AccountOp = z.output<typeof accountOpSchema>;
export type AccountOpKind = AccountOp['kind'];

export const ACCOUNT_PLAN_TOKEN = /^[0-9a-f]{64}$/;

export const accountPlanRequestSchema = z.object({ op: accountOpSchema });
export const accountApplyRequestSchema = z.object({
  op: accountOpSchema,
  planToken: z.string().regex(ACCOUNT_PLAN_TOKEN, 'planToken from POST /accounts/plan'),
});

/**
 * An operation as responses show it: the IBAN is never echoed, only whether
 * the operation sets one (`recognizesTransfers: true`) or removes it (`false`).
 */
export type PublicAccountOp =
  | (Omit<Extract<AccountOp, { kind: 'create_account' }>, 'iban'> & { recognizesTransfers?: boolean })
  | (Omit<Extract<AccountOp, { kind: 'update_account' }>, 'iban'> & { recognizesTransfers?: boolean })
  | Extract<AccountOp, { kind: 'archive_account' }>
  | Extract<AccountOp, { kind: 'unarchive_account' }>
  | Extract<AccountOp, { kind: 'add_balance_observation' }>
  | Extract<AccountOp, { kind: 'correct_balance_observation' }>
  | Extract<AccountOp, { kind: 'delete_balance_observation' }>
  | Extract<AccountOp, { kind: 'undo' }>;

/**
 * A dated balance an actor stated for an account: for a manual account its only
 * balance, for an imported one an anchor between the bank's own balances. It is
 * a balance snapshot (`source: manual`), so every balance view reads it like the
 * bank's; nothing is estimated between two of them.
 */
export type BalanceObservation = {
  id: string;
  accountId: string;
  /** YYYY-MM-DD: the balance at the end of that day. */
  date: string;
  /** Signed, as the Ledger uses it: debt is negative. */
  balance: number;
  /** For a liability type (credit_card, loan, other_liability) the debt as a positive amount; null otherwise. */
  debt: number | null;
  currency: string;
  note: string | null;
  /** Who stated (or last corrected) it; `system` for balances from before actors were recorded. */
  actor: string;
  createdAt: string;
  updatedAt: string | null;
};

/**
 * An observation on an imported account checked against the account's previous
 * balance and the bookings between: `difference` = balance − (previous balance +
 * booked sum). Non-zero means the bookings and the two balances disagree (rows
 * missing, or a wrong balance); nothing is booked to even it out.
 */
export type ObservationReconciliation = {
  previousDate: string;
  previousBalance: number;
  bookedSum: number;
  bookedCount: number;
  difference: number;
};

export type AccountBalanceObservations = {
  accountId: string;
  type: AccountType;
  tracking: AccountTracking;
  currency: string;
  updateIntervalDays: number | null;
  /** The latest balance (an observation or, for imported accounts, the bank's), null = unknown. */
  latest: { date: string; balance: number; debt: number | null; source: 'import' | 'manual' } | null;
  ageDays: number | null;
  stale: boolean;
  /** Newest first. */
  observations: Array<BalanceObservation & { reconciliation: ObservationReconciliation | null }>;
  /** Balances the bank exports reported (imported accounts), not editable. */
  imported: { count: number; firstDate: string | null; lastDate: string | null };
};

/** An account as agents and change sets see it: never its IBAN. */
export type AccountView = {
  id: string;
  name: string;
  type: AccountType;
  tracking: AccountTracking;
  ownershipShare: number;
  currency: string;
  updateIntervalDays: number | null;
  /** True when payments to its IBAN are recognised as transfers to it (manual accounts with an IBAN). */
  recognizesTransfers: boolean;
  archivedAt: string | null;
};

/** One field a change set changed. The IBAN shows only as `recognizesTransfers` (true/false), never its value. */
export type AccountFieldChange = {
  field:
    | 'name'
    | 'type'
    | 'ownershipShare'
    | 'currency'
    | 'recognizesTransfers'
    | 'updateIntervalDays'
    | 'archived'
    | 'created'
    | 'observationDate'
    | 'observationBalance'
    | 'observationNote';
  from: string | number | boolean | null;
  to: string | number | boolean | null;
  /** For `recognizesTransfers` true → true: the IBAN was replaced by another one. */
  replaced?: boolean;
};

/** A transaction whose reporting a change set changes. */
export type TransferEffect = { transactionId: string; accountId: string; date: string; amount: number; counterpartyName: string | null };

export type AccountTransferEffects = {
  /** Booked transactions that become transfers to this account. */
  recognized: TransferEffect[];
  recognizedTotal: number;
  /** Transactions that stop being transfers to this account and count as ordinary payments again. */
  released: TransferEffect[];
  releasedTotal: number;
  /** Still transfers to this account, but reported as another kind (the type changed, e.g. savings → property). */
  reclassified: TransferEffect[];
  reclassifiedTotal: number;
};

export type AccountException = { reason: string; field?: string };

export type AccountPlan = {
  kind: AccountOpKind;
  op: PublicAccountOp;
  /** The account after the change (for a create: as it will be, id null). */
  account: Omit<AccountView, 'id'> & { id: string | null };
  changes: AccountFieldChange[];
  transfers: AccountTransferEffects;
  /** For balance observation ops: the observation before and after (null = none). */
  observation: ObservationChange | null;
  exceptions: AccountException[];
  planToken: string;
};

/** An observation in a plan: one still to be added has no id, actor or creation time yet. */
export type PlannedObservation = Omit<BalanceObservation, 'id' | 'actor' | 'createdAt'> & {
  id: string | null;
  actor: string | null;
  createdAt: string | null;
};

/** What a change set does to one observation: before and after (null = none), as applied. */
export type ObservationChange = { before: PlannedObservation | null; after: PlannedObservation | null };

export type AccountChangeSetListItem = {
  id: string;
  createdAt: string;
  actor: string;
  kind: AccountOpKind;
  reason: string | null;
  status: 'applied' | 'undone';
  undoOfId: string | null;
  undoneById: string | null;
  accountId: string;
  summary: {
    fieldsChanged: number;
    transfersRecognized: number;
    transfersReleased: number;
    transfersReclassified: number;
    exceptions: number;
  };
};

export type AccountChangeSet = AccountChangeSetListItem & {
  op: PublicAccountOp;
  changes: AccountFieldChange[];
  transfers: AccountTransferEffects;
  observation: ObservationChange | null;
  exceptions: AccountException[];
};

export type AccountChangeSetList = { total: number; limit: number; offset: number; items: AccountChangeSetListItem[] };

export const accountChangeSetListFields = {
  accountId: z.string().trim().min(1).max(100).optional().describe('Only change sets of this account'),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
};
