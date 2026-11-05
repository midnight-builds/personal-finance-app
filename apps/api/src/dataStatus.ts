import { db } from './db.js';

/** Which data a database holds. Only the demo seed marks a database; unmarked means real. */
export type Dataset = 'real' | 'demo';

const DATASET_KEY = 'dataset';

export type DataStatus = {
  /** When the latest import that stored rows ran (ISO 8601 UTC), null before the first one. */
  lastImportAt: string | null;
  /** Latest booking date in the data (YYYY-MM-DD); pending rows without a date are ignored. */
  dataAsOf: string | null;
  dataset: Dataset;
};

export function getDataset(): Dataset {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(DATASET_KEY) as
    | { value: string }
    | undefined;
  return row?.value === 'demo' ? 'demo' : 'real';
}

/** Marks the database as demo data. Only the demo seed calls this. */
export function markDemoDataset() {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, 'demo', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(DATASET_KEY, new Date().toISOString());
}

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
  return {
    lastImportAt: row.lastImportAt ?? null,
    dataAsOf: row.dataAsOf ? String(row.dataAsOf).slice(0, 10) : null,
    dataset: getDataset(),
  };
}
