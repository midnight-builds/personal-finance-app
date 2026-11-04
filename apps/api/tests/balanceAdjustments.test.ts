import './setup/testDb.js';
import { test } from "node:test";
import assert from "node:assert/strict";

import { initDb, db } from "../src/db.js";
import { createBalanceAdjustment, getAdjustmentSumForAccountAtOrBeforeDate } from "../src/balanceAdjustments.js";

initDb();

test("balance adjustments sum applies up to date", () => {
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("DELETE FROM balance_adjustments;");
  db.exec("PRAGMA foreign_keys=ON;");

  const accountId = "acc-1";
  db.prepare("INSERT OR REPLACE INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)").run(accountId, new Date().toISOString(), "Test account", null, "checking");
  createBalanceAdjustment({ accountId, date: "2026-01-01", amount: 10, reason: "fix" });
  createBalanceAdjustment({ accountId, date: "2026-02-01", amount: -3, reason: "fix2" });

  assert.equal(getAdjustmentSumForAccountAtOrBeforeDate(accountId, "2025-12-31"), 0);
  assert.equal(getAdjustmentSumForAccountAtOrBeforeDate(accountId, "2026-01-01"), 10);
  assert.equal(getAdjustmentSumForAccountAtOrBeforeDate(accountId, "2026-01-15"), 10);
  assert.equal(getAdjustmentSumForAccountAtOrBeforeDate(accountId, "2026-02-01"), 7);
});
