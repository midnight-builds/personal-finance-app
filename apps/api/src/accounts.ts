import { db } from './db.js';

export function listAccounts() {
  return db
    .prepare(
      `SELECT a.id, a.name, a.iban, a.type,
              (SELECT balance FROM balance_snapshots bs WHERE bs.account_id = a.id ORDER BY date DESC LIMIT 1)
                + COALESCE((
                    SELECT SUM(amount)
                    FROM balance_adjustments ba
                    WHERE ba.account_id = a.id
                      AND ba.date <= (SELECT date FROM balance_snapshots bs2 WHERE bs2.account_id = a.id ORDER BY date DESC LIMIT 1)
                  ), 0) AS balance,
              (SELECT currency FROM balance_snapshots bs WHERE bs.account_id = a.id ORDER BY date DESC LIMIT 1) AS currency
       FROM accounts a
       ORDER BY a.created_at ASC`
    )
    .all() as Array<any>;
}
