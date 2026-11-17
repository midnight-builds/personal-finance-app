import type { DatabaseSync } from 'node:sqlite';

/**
 * The life of a pending row ("Varaus", no booking date) beside its
 * transaction, so `normalized_transactions` keeps its shape:
 *
 * - `pending`: listed as pending by the latest export that covered it.
 * - `booked`: a later export booked it; the transaction was promoted in place
 *   (same id, booking date set, raw link moved to the booked raw row). The
 *   pending raw row stays as `pending_raw_transaction_id`.
 * - `void`: a newer export of the same period lists it neither pending nor
 *   booked (a cancelled authorisation). Kept, but counted and listed nowhere.
 *
 * Days are the latest booked day of the export (YYYY-MM-DD): an export does
 * not say when it was made, and its newest booked row is the closest the data
 * gets. `first_seen_day` is that of the export that first listed the row,
 * `last_seen_day` of the newest one that did; `resolved_day` that of the export
 * that booked or voided it.
 */
export function ensurePendingTransactions(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_transactions (
      transaction_id TEXT PRIMARY KEY REFERENCES normalized_transactions(id),
      status TEXT NOT NULL,
      first_seen_session_id TEXT NOT NULL,
      first_seen_day TEXT NOT NULL,
      last_seen_session_id TEXT NOT NULL,
      last_seen_day TEXT NOT NULL,
      pending_raw_transaction_id TEXT,
      resolved_session_id TEXT,
      resolved_day TEXT,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_transactions_status ON pending_transactions(status);
  `);
  backfillPendingTransactions(db);
}

/**
 * Pending rows stored before the lifecycle existed get their row, as pending
 * and seen by their own import only. Idempotent: rows that have one are left
 * alone. Nothing is deleted or merged here: copies a re-import used to store
 * are paired one-to-one by the next current export, and the extra ones go void
 * then (src/importer.ts).
 */
function backfillPendingTransactions(db: DatabaseSync) {
  db.exec(`
    INSERT INTO pending_transactions
      (transaction_id, status, first_seen_session_id, first_seen_day, last_seen_session_id, last_seen_day, pending_raw_transaction_id)
    SELECT t.id, 'pending', t.import_session_id, d.day, t.import_session_id, d.day, t.raw_transaction_id
    FROM normalized_transactions t
    JOIN (
      SELECT t2.id,
             COALESCE(
               (SELECT MAX(substr(r.booking_date, 1, 10)) FROM raw_transactions r WHERE r.import_session_id = t2.import_session_id),
               (SELECT substr(s.created_at, 1, 10) FROM import_sessions s WHERE s.id = t2.import_session_id),
               substr(t2.created_at, 1, 10)) AS day
      FROM normalized_transactions t2
      WHERE t2.booking_date IS NULL
    ) d ON d.id = t.id
    WHERE t.booking_date IS NULL
      AND NOT EXISTS (SELECT 1 FROM pending_transactions p WHERE p.transaction_id = t.id)
  `);
}
