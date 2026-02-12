import crypto from "crypto";
import { db } from "./db.js";

export type BalanceAdjustment = {
  id: string;
  created_at: string;
  account_id: string;
  date: string;
  amount: number;
  reason: string | null;
};

export function listBalanceAdjustments(): BalanceAdjustment[] {
  return db
    .prepare(
      `SELECT id, created_at, account_id, date, amount, reason
       FROM balance_adjustments
       ORDER BY date DESC, created_at DESC`
    )
    .all() as BalanceAdjustment[];
}

export function createBalanceAdjustment(input: {
  accountId: string;
  date: string;
  amount: number;
  reason?: string | null;
}): BalanceAdjustment {
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
