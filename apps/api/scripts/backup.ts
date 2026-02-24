import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

function usage(): never {
  console.error(`Usage: npm run backup --workspace apps/api -- [--db <path>] [--out <path>]

Creates a consistent SQLite backup using VACUUM INTO.

Options:
  --db   Path to main DB file (defaults to DB_PATH env or data/finance.db)
  --out  Backup file path (defaults to backups/finance-<timestamp>.db)
`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const out: { db?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '-h' || a === '--help') usage();
    else usage();
  }
  return out;
}

const { db: dbArg, out: outArg } = parseArgs(process.argv.slice(2));

const dbPath = dbArg || process.env.DB_PATH || path.resolve('data', 'finance.db');
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const defaultOut = path.resolve('backups', `finance-${ts}.db`);
const outPath = path.resolve(outArg || defaultOut);

if (!fs.existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });

// Open in read-only mode; VACUUM INTO reads the entire DB and writes a new one.
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  // SQLite requires the file to not already exist.
  if (fs.existsSync(outPath)) {
    console.error(`Backup destination already exists: ${outPath}`);
    process.exit(1);
  }

  db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}';`);
  const stat = fs.statSync(outPath);
  console.log(`OK: wrote backup ${outPath} (${stat.size} bytes)`);
} finally {
  db.close();
}
