import fs from 'node:fs';
import path from 'node:path';

export const BACKUP_FILE = /^finance-\d{4}-\d{2}-\d{2}T[\d-]+Z\.db$/;

export function backupFileName(now = new Date()) {
  return `finance-${now.toISOString().replace(/[:.]/g, '-')}.db`;
}

/**
 * Deletes the oldest backups in `dir`, keeping the newest `keep`. Only files
 * matching this script's naming scheme are considered, and `protect` (the backup
 * just written) is never deleted, even if a skewed clock left newer-named files.
 * Returns the deleted paths.
 */
export function pruneBackups(dir: string, keep: number, protect?: string): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep must be a positive integer, got ${keep}`);
  const protectedName = protect ? path.basename(protect) : undefined;
  // ISO timestamps in the name sort chronologically.
  const backups = fs
    .readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .sort();
  const doomed = backups
    .slice(0, Math.max(0, backups.length - keep))
    .filter((name) => name !== protectedName)
    .map((name) => path.join(dir, name));
  for (const file of doomed) fs.unlinkSync(file);
  return doomed;
}
