import { db } from './db.js';
import { accountBalances } from './ledger.js';

/** Accounts with their latest balance (the Ledger's rule), in creation order. */
export function listAccounts() {
  const balances = new Map(accountBalances().map((b) => [b.accountId, b]));
  const rows = db
    .prepare(
      // balance_date keeps the snapshot's stored form (the Ledger reports its day).
      `SELECT a.id, a.name, a.iban, a.type, a.account_subtype, a.owner_label,
              a.credit_limit, a.savings_goal,
              (SELECT date FROM balance_snapshots bs WHERE bs.account_id = a.id
               ORDER BY date DESC, created_at DESC LIMIT 1) AS balance_date
       FROM accounts a
       ORDER BY a.created_at ASC`
    )
    .all() as Array<Record<string, any>>;
  return rows.map(({ balance_date, ...account }) => {
    const b = balances.get(account.id);
    return { ...account, balance: b?.balance ?? null, currency: b?.currency ?? null, balance_date };
  });
}

export function updateAccount(
  id: string,
  patch: {
    account_subtype?: 'checking' | 'savings' | 'credit_card';
    owner_label?: string | null;
    credit_limit?: number | null;
    savings_goal?: number | null;
    name?: string;
  }
) {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (patch.account_subtype !== undefined) { sets.push('account_subtype = ?'); values.push(patch.account_subtype); }
  if (patch.owner_label !== undefined)     { sets.push('owner_label = ?');     values.push(patch.owner_label); }
  if (patch.credit_limit !== undefined)    { sets.push('credit_limit = ?');    values.push(patch.credit_limit); }
  if (patch.savings_goal !== undefined)    { sets.push('savings_goal = ?');    values.push(patch.savings_goal); }
  if (patch.name !== undefined)            { sets.push('name = ?');            values.push(patch.name); }

  if (sets.length === 0) return undefined;
  values.push(id);
  return db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...(values as any[])) as { changes: number };
}
