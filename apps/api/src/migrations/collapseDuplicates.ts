import crypto from 'crypto';
import type { DatabaseSync } from 'node:sqlite';

// One-time cleanup for databases from before "a transaction is stored once".
// An overlapping import used to store every row again and group the copies
// with the first one (normalized_transactions.transaction_group_id, table
// transaction_groups); reports, search and the AI tools counted only the
// group's canonical row, the earliest imported, while the transaction list
// showed every copy with its own category picker. This keeps the canonical
// row, moves everything that points at the other copies onto it, deletes the
// copies with their raw rows and drops the grouping schema. The dropped column
// is the marker: it runs once, in one transaction, and does nothing on a
// database without the column.
//
// Categorization: one row's history is kept on top, untouched, so its
// category and manual state stay exactly as they were. That is the canonical
// row's (what the reports showed), unless a copy's category is a manual choice
// newer than any manual one on the canonical row: manual beats rule, and a
// choice made on a copy in the list is the user's. Decisions of the other rows
// are merged below the kept history when older than all of it (and the undo
// walk of `isManual` in categorization.ts cannot reach them); newer ones would
// change the category, so they are dropped. Both, and every copy whose manual
// choice won, are written to the event log (type
// `migration.collapse_duplicates`).

type Decision = { id: string; rowid: number; transaction_id: string; category_id: string; source: string; created_at: string };
type Report = {
  groups: number;
  removedTransactions: number;
  mergedDecisions: number;
  /** Groups whose kept history is a copy's: its manual choice was the newest one. */
  manualFromCopy: Array<{ transactionId: string; fromCopy: string; categoryBefore: string | null; categoryAfter: string }>;
  droppedDecisions: Array<{ id: string; transactionId: string; keptTransactionId: string; categoryId: string; source: string; createdAt: string }>;
  removedTransferLinks: Array<{ id: string; from: string; to: string; reason: 'duplicate' | 'self' }>;
  transactionsInSeveralLinks: number;
  changeSetsRewritten: number;
  findingsRewritten: number;
};

const hasColumn = (db: DatabaseSync, table: string, column: string) =>
  db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column) !== undefined;

/** Ordered newest first, like LATEST_DECISION_ORDER. */
const newestFirst = (a: Decision, b: Decision) =>
  a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.rowid - a.rowid;

/**
 * How far `isManual` (categorization.ts) reads into a newest-first history:
 * an `undo` stands for the decision two below it. Merged decisions must lie
 * below this point.
 */
function manualWalkEnd(history: Decision[]): number {
  let i = 0;
  while (history[i]?.source === 'undo') i += 2;
  return i;
}

/** `isManual` (categorization.ts) on a newest-first history. */
function isManualHistory(history: Decision[]): boolean {
  return history[manualWalkEnd(history)]?.source === 'user';
}

/** Collapses duplicate groups; returns the report, or null when there is nothing to do. */
export function collapseDuplicateGroups(db: DatabaseSync): Report | null {
  if (!hasColumn(db, 'normalized_transactions', 'transaction_group_id')) return null;

  db.exec('BEGIN');
  try {
    const report = collapse(db);
    db.exec('COMMIT');
    return report;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function collapse(db: DatabaseSync): Report {
  // Copy id → canonical id. Canonical = the earliest imported row of the
  // group, which is the row every view showed (the stored
  // transaction_groups.canonical_transaction_id was set by the same order).
  const members = db
    .prepare(
      `SELECT id, transaction_group_id AS g FROM normalized_transactions
       WHERE transaction_group_id IS NOT NULL
       ORDER BY transaction_group_id, created_at ASC, id ASC`
    )
    .all() as Array<{ id: string; g: string }>;
  const canonicalOf = new Map<string, string>();
  const groupCanonical = new Map<string, string>();
  for (const m of members) {
    const canonical = groupCanonical.get(m.g);
    if (canonical === undefined) groupCanonical.set(m.g, m.id);
    else canonicalOf.set(m.id, canonical);
  }
  const groups = new Set([...canonicalOf.values()]).size;
  const report: Report = {
    groups,
    removedTransactions: canonicalOf.size,
    mergedDecisions: 0,
    manualFromCopy: [],
    droppedDecisions: [],
    removedTransferLinks: [],
    transactionsInSeveralLinks: 0,
    changeSetsRewritten: 0,
    findingsRewritten: 0,
  };
  const mapId = (id: string) => canonicalOf.get(id) ?? id;

  db.exec('CREATE TEMP TABLE collapse_map (copy_id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL)');
  const insertMap = db.prepare('INSERT INTO collapse_map (copy_id, canonical_id) VALUES (?, ?)');
  for (const [copy, canonical] of canonicalOf) insertMap.run(copy, canonical);

  // 1. Categorization decisions.
  const decisions = db
    .prepare(
      `SELECT d.rowid AS rowid, d.id, d.transaction_id, d.category_id, d.source, d.created_at
       FROM categorization_decisions d
       WHERE d.transaction_id IN (SELECT copy_id FROM collapse_map)
          OR d.transaction_id IN (SELECT canonical_id FROM collapse_map)`
    )
    .all() as Decision[];
  const byTx = new Map<string, Decision[]>();
  for (const d of decisions) {
    const list = byTx.get(d.transaction_id) ?? [];
    list.push({ ...d });
    byTx.set(d.transaction_id, list);
  }
  const membersOf = new Map<string, string[]>(); // canonical → every row of its group, canonical first
  for (const [copy, canonical] of canonicalOf) membersOf.set(canonical, [...(membersOf.get(canonical) ?? [canonical]), copy]);
  const winnerOf = new Map<string, string>(); // canonical → the row whose history it keeps
  const repoint = db.prepare('UPDATE categorization_decisions SET transaction_id = ? WHERE id = ?');
  const dropDecision = db.prepare('DELETE FROM categorization_decisions WHERE id = ?');
  for (const [canonical, rows] of membersOf) {
    const histories = new Map(rows.map((id) => [id, (byTx.get(id) ?? []).sort(newestFirst)]));
    // Manual beats rule: the newest manual choice on any copy wins; without
    // one, the canonical row's history (what the reports showed) stays.
    // A copy that agrees with a manual canonical row changes nothing: the canonical row stays.
    const manual = rows.filter((id) => isManualHistory(histories.get(id)!));
    const newest = manual.sort((a, b) => newestFirst(histories.get(a)![0], histories.get(b)![0]))[0] ?? canonical;
    const sameAsCanonical =
      manual.includes(canonical) && histories.get(newest)![0].category_id === histories.get(canonical)![0].category_id;
    const winner = sameAsCanonical ? canonical : newest;
    winnerOf.set(canonical, winner);
    if (winner !== canonical) {
      const before = histories.get(canonical)![0];
      report.manualFromCopy.push({
        transactionId: canonical,
        fromCopy: winner,
        categoryBefore: before?.category_id ?? null,
        categoryAfter: histories.get(winner)![0].category_id,
      });
    }
    const kept = histories.get(winner)!;
    // Decisions of the other rows go below the kept history, and only where
    // the undo walk of isManual stays inside it, so they cannot change the
    // category or its manual state.
    const oldest = kept.length > 0 && manualWalkEnd(kept) < kept.length ? kept[kept.length - 1] : null;
    for (const d of kept) {
      if (d.transaction_id !== canonical) repoint.run(canonical, d.id);
    }
    for (const id of rows) {
      if (id === winner) continue;
      for (const d of histories.get(id)!) {
        if (oldest && newestFirst(d, oldest) > 0) {
          if (d.transaction_id !== canonical) repoint.run(canonical, d.id);
          report.mergedDecisions += 1;
        } else {
          dropDecision.run(d.id);
          report.droppedDecisions.push({
            id: d.id,
            transactionId: id,
            keptTransactionId: canonical,
            categoryId: d.category_id,
            source: d.source,
            createdAt: d.created_at,
          });
        }
      }
    }
  }

  // 2. Transfer links: onto the canonical rows; a link that becomes a copy of
  // another, or links a row to itself, goes. Links to different rows are all
  // kept (each other side stays a transfer), and counted in the report.
  db.exec(`
    UPDATE transfer_links SET from_transaction_id = (SELECT canonical_id FROM collapse_map WHERE copy_id = from_transaction_id)
      WHERE from_transaction_id IN (SELECT copy_id FROM collapse_map);
    UPDATE transfer_links SET to_transaction_id = (SELECT canonical_id FROM collapse_map WHERE copy_id = to_transaction_id)
      WHERE to_transaction_id IN (SELECT copy_id FROM collapse_map);
  `);
  const extraLinks = db
    .prepare(
      `SELECT id, from_transaction_id AS f, to_transaction_id AS t,
              CASE WHEN from_transaction_id = to_transaction_id THEN 'self' ELSE 'duplicate' END AS reason
       FROM transfer_links l
       WHERE from_transaction_id = to_transaction_id
          OR rowid != (SELECT MIN(rowid) FROM transfer_links k
                       WHERE k.from_transaction_id = l.from_transaction_id AND k.to_transaction_id = l.to_transaction_id)`
    )
    .all() as Array<{ id: string; f: string; t: string; reason: 'duplicate' | 'self' }>;
  const dropLink = db.prepare('DELETE FROM transfer_links WHERE id = ?');
  for (const l of extraLinks) {
    dropLink.run(l.id);
    report.removedTransferLinks.push({ id: l.id, from: l.f, to: l.t, reason: l.reason });
  }
  report.transactionsInSeveralLinks = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT x FROM (SELECT from_transaction_id AS x FROM transfer_links UNION ALL SELECT to_transaction_id FROM transfer_links)
             GROUP BY x HAVING COUNT(*) > 1)`
        )
        .get() as { n: number }
    ).n
  );

  // 3. Change sets: each transaction once, on its canonical row. Of a set's
  // rows for one transaction the kept history's row's own is kept (its
  // decision is the one an undo checks); exceptions likewise. A payload that
  // is not JSON stops the migration: categorization.ts could not read it either.
  const sets = db.prepare('SELECT id, payload FROM change_sets').all() as Array<{ id: string; payload: string }>;
  const writeSet = db.prepare('UPDATE change_sets SET payload = ? WHERE id = ?');
  for (const set of sets) {
    const payload = JSON.parse(set.payload) as {
      op?: { transactionIds?: string[] };
      rows?: Array<{ transactionId: string }>;
      exceptions?: Array<{ transactionId?: string; reason: string }>;
    };
    let changed = false;
    if (Array.isArray(payload.op?.transactionIds)) {
      const ids = [...new Set(payload.op.transactionIds.map(mapId))];
      if (ids.length !== payload.op.transactionIds.length || ids.some((id, i) => id !== payload.op!.transactionIds![i])) {
        payload.op.transactionIds = ids;
        changed = true;
      }
    }
    if (Array.isArray(payload.rows)) {
      const kept = new Map<string, { transactionId: string }>();
      for (const row of payload.rows) {
        const target = mapId(row.transactionId);
        // The kept history's row: its decision is the one an undo checks.
        const own = row.transactionId === (winnerOf.get(target) ?? target);
        if (target !== row.transactionId) changed = true;
        if (!kept.has(target) || own) kept.set(target, { ...row, transactionId: target });
      }
      const order = [...new Set(payload.rows.map((r) => mapId(r.transactionId)))];
      payload.rows = order.map((id) => kept.get(id)!);
    }
    if (Array.isArray(payload.exceptions)) {
      const seen = new Set<string>();
      const next: typeof payload.exceptions = [];
      for (const e of payload.exceptions) {
        const mapped = e.transactionId ? { ...e, transactionId: mapId(e.transactionId) } : e;
        if (mapped.transactionId !== e.transactionId) changed = true;
        const key = JSON.stringify([mapped.transactionId ?? null, mapped.reason, (mapped as { categoryId?: string }).categoryId ?? null, (mapped as { ruleId?: string }).ruleId ?? null]);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(mapped);
      }
      payload.exceptions = next;
    }
    if (changed) {
      writeSet.run(JSON.stringify(payload), set.id);
      report.changeSetsRewritten += 1;
    }
  }

  // 4. Insight findings: their linked transactions (an unreadable list is left as it is).
  const findings = db
    .prepare('SELECT id, transaction_ids FROM insight_findings WHERE transaction_ids IS NOT NULL')
    .all() as Array<{ id: string; transaction_ids: string }>;
  const writeFinding = db.prepare('UPDATE insight_findings SET transaction_ids = ? WHERE id = ?');
  for (const f of findings) {
    let ids: unknown;
    try {
      ids = JSON.parse(f.transaction_ids);
    } catch {
      continue;
    }
    if (!Array.isArray(ids)) continue;
    if (!ids.some((id) => typeof id === 'string' && canonicalOf.has(id))) continue;
    const next = [...new Set(ids.map((id) => (typeof id === 'string' ? mapId(id) : id)))];
    writeFinding.run(JSON.stringify(next), f.id);
    report.findingsRewritten += 1;
  }

  // 5. The copies, then their raw rows (foreign keys are enforced).
  db.exec(`
    CREATE TEMP TABLE collapse_raw AS
      SELECT raw_transaction_id AS id FROM normalized_transactions
      WHERE id IN (SELECT copy_id FROM collapse_map) AND raw_transaction_id IS NOT NULL;
    DELETE FROM normalized_transactions WHERE id IN (SELECT copy_id FROM collapse_map);
    DELETE FROM raw_transactions WHERE id IN (SELECT id FROM collapse_raw);
    DROP TABLE collapse_raw;
  `);

  // Nothing may point at a removed row any more.
  const dangling = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM categorization_decisions WHERE transaction_id IN (SELECT copy_id FROM collapse_map)) +
         (SELECT COUNT(*) FROM transfer_links WHERE from_transaction_id IN (SELECT copy_id FROM collapse_map)
                                                OR to_transaction_id IN (SELECT copy_id FROM collapse_map)) AS n`
    )
    .get() as { n: number };
  if (Number(dangling.n) !== 0) throw new Error(`collapseDuplicateGroups: ${dangling.n} references to removed rows remain`);

  // 6. The grouping schema.
  db.exec(`
    DROP TABLE collapse_map;
    DROP INDEX IF EXISTS idx_normalized_group;
    DROP INDEX IF EXISTS idx_transaction_groups_canonical;
    ALTER TABLE normalized_transactions DROP COLUMN transaction_group_id;
    DROP TABLE IF EXISTS transaction_groups;
  `);

  db.prepare('INSERT INTO event_log (id, created_at, type, scope, message, payload) VALUES (?, ?, ?, ?, ?, ?)').run(
    crypto.randomUUID(),
    new Date().toISOString(),
    'migration.collapse_duplicates',
    null,
    `Collapsed ${report.groups} duplicate groups: removed ${report.removedTransactions} copies`,
    JSON.stringify(report)
  );
  return report;
}
