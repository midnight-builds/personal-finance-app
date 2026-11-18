import crypto from "crypto";
import { db } from "./db.js";
import { DomainError } from "./http/errors.js";

export type BalanceAdjustment = {
  id: string;
  created_at: string;
  account_id: string;
  date: string;
  amount: number;
  reason: string | null;
};

export type ListedBalanceAdjustment = BalanceAdjustment & {
  /**
   * The Ledger uses it: some balance snapshot is dated on or after it. False while
   * the account has no balance yet or every snapshot is older (it waits for one).
   */
  applied: boolean;
};

export function listBalanceAdjustments(): ListedBalanceAdjustment[] {
  const rows = db
    .prepare(
      `SELECT ba.id, ba.created_at, ba.account_id, ba.date, ba.amount, ba.reason,
              EXISTS (SELECT 1 FROM balance_snapshots s
                      WHERE s.account_id = ba.account_id
                        AND substr(s.date, 1, 10) >= substr(ba.date, 1, 10)) AS applied
       FROM balance_adjustments ba
       ORDER BY ba.date DESC, ba.created_at DESC`
    )
    .all() as Array<BalanceAdjustment & { applied: number }>;
  return rows.map((r) => ({ ...r, applied: r.applied === 1 }));
}

export function createBalanceAdjustment(input: {
  accountId: string;
  date: string;
  amount: number;
  reason?: string | null;
}): BalanceAdjustment {
  if (!db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(input.accountId)) throw DomainError.notFound();
  // An adjustment corrects a balance; without one the Ledger would drop it silently.
  // The account's first balance is a manual snapshot (balanceSnapshots.ts) instead.
  if (!db.prepare("SELECT 1 FROM balance_snapshots WHERE account_id = ?").get(input.accountId)) {
    throw DomainError.conflict("balance_snapshot_missing");
  }
  const now = new Date().toISOString();
  const row: BalanceAdjustment = {
    id: crypto.randomUUID(),
    created_at: now,
    account_id: input.accountId,
    date: input.date,
    amount: Number(input.amount),
    reason: input.reason ? String(input.reason) : null,
  };

  db.prepare(
    `INSERT INTO balance_adjustments (id, created_at, account_id, date, amount, reason)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.created_at, row.account_id, row.date, row.amount, row.reason);

  return row;
}

export function deleteBalanceAdjustment(id: string): boolean {
  const res = db.prepare(`DELETE FROM balance_adjustments WHERE id = ?`).run(id);
  return res.changes > 0;
}

export function getAdjustmentSumForAccountAtOrBeforeDate(accountId: string, date: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS sum
       FROM balance_adjustments
       WHERE account_id = ? AND date <= ?`
    )
    .get(accountId, date) as { sum: number };
  return Number(row?.sum ?? 0);
}
