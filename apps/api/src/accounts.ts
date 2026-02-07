import { db } from './db.js';

export function listAccounts() {
  return db
    .prepare(
      `SELECT a.id, a.name, a.iban, a.type,
              (SELECT balance FROM balance_snapshots bs WHERE bs.account_id = a.id ORDER BY date DESC LIMIT 1) AS balance,
              (SELECT currency FROM balance_snapshots bs WHERE bs.account_id = a.id ORDER BY date DESC LIMIT 1) AS currency
       FROM accounts a
       ORDER BY a.created_at ASC`
    )
    .all() as Array<any>;
}
