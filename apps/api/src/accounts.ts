import { db } from './db.js';

export function listAccounts() {
  return db
    .prepare(
      `SELECT a.id, a.name, a.iban, a.type, a.account_subtype, a.owner_label,
              a.credit_limit, a.savings_goal,
              (SELECT balance FROM balance_snapshots bs WHERE bs.account_id = a.id ORDER BY date DESC LIMIT 1)
                + COALESCE((
                    SELECT SUM(amount)
                    FROM balance_adjustments ba
                    WHERE ba.account_id = a.id
                      AND ba.date <= (SELECT date FROM balance_snapshots bs2 WHERE bs2.account_id = a.id ORDER BY date DESC LIMIT 1)
                  ), 0) AS balance,
              (SELECT currency FROM balance_snapshots bs WHERE bs.account_id = a.id ORDER BY date DESC LIMIT 1) AS currency,
              (SELECT date FROM balance_snapshots bs WHERE bs.account_id = a.id ORDER BY date DESC LIMIT 1) AS balance_date
       FROM accounts a
       ORDER BY a.created_at ASC`
    )
    .all() as Array<any>;
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

  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}
