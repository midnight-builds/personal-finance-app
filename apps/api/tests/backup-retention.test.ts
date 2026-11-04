import './setup/testDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKUP_FILE, backupFileName, pruneBackups } from '../scripts/backupRetention.js';

test('backup file names match the retention pattern and sort chronologically', () => {
  const a = backupFileName(new Date('2026-01-02T03:04:05.006Z'));
  const b = backupFileName(new Date('2026-11-04T00:00:00.000Z'));
  assert.equal(a, 'finance-2026-01-02T03-04-05-006Z.db');
  assert.ok(BACKUP_FILE.test(a) && BACKUP_FILE.test(b));
  assert.ok(a < b);
});

test('pruneBackups keeps the newest n and never touches other files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-retention-'));
  try {
    const names = [1, 2, 3, 4].map((d) => backupFileName(new Date(`2026-01-0${d}T00:00:00Z`)));
    for (const name of [...names, 'finance.db', 'notes.txt']) fs.writeFileSync(path.join(dir, name), '');

    const deleted = pruneBackups(dir, 2).map((p) => path.basename(p));
    assert.deepEqual(deleted, names.slice(0, 2));
    assert.deepEqual(fs.readdirSync(dir).sort(), [...names.slice(2), 'finance.db', 'notes.txt'].sort());
    assert.throws(() => pruneBackups(dir, 0), /positive integer/);

    // A file "from the future" (skewed clock) must not cause the new backup to be pruned.
    const future = backupFileName(new Date('2099-01-01T00:00:00Z'));
    const fresh = backupFileName(new Date('2026-02-01T00:00:00Z'));
    for (const name of [future, fresh]) fs.writeFileSync(path.join(dir, name), '');
    pruneBackups(dir, 1, path.join(dir, fresh));
    assert.ok(fs.existsSync(path.join(dir, fresh)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
