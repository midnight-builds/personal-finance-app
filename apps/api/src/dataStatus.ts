import { db } from './db.js';

export type DataStatus = {
  /** When the latest import that stored rows ran (ISO 8601 UTC), null before the first one. */
  lastImportAt: string | null;
  /** Latest booking date in the data (YYYY-MM-DD); pending rows without a date are ignored. */
  dataAsOf: string | null;
};

export function getDataStatus(): DataStatus {
  const row = db
    .prepare(
      // A failed import keeps its session row (written before the row transaction),
      // so only sessions that stored rows count.
      `SELECT (SELECT MAX(s.created_at) FROM import_sessions s
               WHERE EXISTS (SELECT 1 FROM raw_transactions r WHERE r.import_session_id = s.id)) AS lastImportAt,
              (SELECT MAX(booking_date) FROM normalized_transactions WHERE booking_date IS NOT NULL) AS dataAsOf`
    )
    .get() as { lastImportAt: string | null; dataAsOf: string | null };
  return { lastImportAt: row.lastImportAt ?? null, dataAsOf: row.dataAsOf ? String(row.dataAsOf).slice(0, 10) : null };
}
