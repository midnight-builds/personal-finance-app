import fs from 'node:fs';
import path from 'node:path';

function usage(): never {
  console.error(`Usage: npm run restore --workspace apps/api -- --from <backup.db> [--db <path>] [--force]

Restores the main SQLite DB file from a backup.

Options:
  --from   Backup file path (required)
  --db     Target DB path (defaults to DB_PATH env or data/finance.db)
  --force  Overwrite existing DB file
`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const out: { from?: string; db?: string; force?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') out.from = argv[++i];
    else if (a === '--db') out.db = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '-h' || a === '--help') usage();
    else usage();
  }
  return out;
}

const { from, db: dbArg, force } = parseArgs(process.argv.slice(2));
if (!from) usage();

const fromPath = path.resolve(from);
const dbPath = path.resolve(dbArg || process.env.DB_PATH || path.resolve('data', 'finance.db'));

if (!fs.existsSync(fromPath)) {
  console.error(`Backup not found: ${fromPath}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

if (fs.existsSync(dbPath) && !force) {
  console.error(`Refusing to overwrite existing DB: ${dbPath} (use --force)`);
  process.exit(1);
}

// Also clear WAL/SHM sidecars if present.
for (const sidecar of [dbPath + '-wal', dbPath + '-shm']) {
  if (fs.existsSync(sidecar)) fs.rmSync(sidecar);
}

fs.copyFileSync(fromPath, dbPath);
console.log(`OK: restored ${dbPath} from ${fromPath}`);
