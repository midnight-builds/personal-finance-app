import { balanceStaleness } from '@finance-app/shared';
import { db } from './db.js';
import { accountBalances, today } from './ledger.js';

/**
 * Accounts with their latest balance (the Ledger's rule: the bank's or an
 * observation, `balance_source`), in creation order, for the web UI: the IBAN is
 * included (agents get `AccountView`s instead, accountChanges.ts). `currency` is
 * the balance's, or the account's own when there is no balance;
 * `recognizes_transfers` says whether payments to a manual account's IBAN are
 * transfers to it; `stale` that the balance is older than the update interval.
 */
export function listAccounts() {
  const balances = new Map(accountBalances(undefined, { includeManual: true }).map((b) => [b.accountId, b]));
  const day = today();
  const rows = db
    .prepare(
      // balance_date keeps the snapshot's stored form (the Ledger reports its day).
      `SELECT a.id, a.name, a.iban, a.type, a.account_subtype, a.owner_label,
              a.credit_limit, a.savings_goal, a.tracking, a.ownership_share, a.currency AS account_currency,
              a.update_interval_days, a.archived_at,
              (SELECT date FROM balance_snapshots bs WHERE bs.account_id = a.id
               ORDER BY date DESC, created_at DESC LIMIT 1) AS balance_date
       FROM accounts a
       ORDER BY a.created_at ASC`
    )
    .all() as Array<Record<string, any>>;
  return rows.map(({ balance_date, account_currency, ...account }) => {
    const b = balances.get(account.id);
    const { ageDays, stale } = balanceStaleness(b?.date ?? null, account.update_interval_days ?? null, day);
    return {
      ...account,
      balance: b?.balance ?? null,
      currency: b?.currency ?? account_currency,
      balance_date,
      balance_source: b?.source ?? null,
      balance_age_days: ageDays,
      stale,
      recognizes_transfers: account.tracking === 'manual' && account.archived_at === null && account.iban !== null,
    };
  });
}

/** The fields outside change sets (labels and limits shown in the UI). */
export function updateAccountDetails(
  id: string,
  patch: {
    owner_label?: string | null;
    credit_limit?: number | null;
    savings_goal?: number | null;
  }
) {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.owner_label !== undefined)     { sets.push('owner_label = ?');     values.push(patch.owner_label); }
  if (patch.credit_limit !== undefined)    { sets.push('credit_limit = ?');    values.push(patch.credit_limit); }
  if (patch.savings_goal !== undefined)    { sets.push('savings_goal = ?');    values.push(patch.savings_goal); }

  if (sets.length === 0) return undefined;
  values.push(id);
  return db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...(values as any[])) as { changes: number };
}
