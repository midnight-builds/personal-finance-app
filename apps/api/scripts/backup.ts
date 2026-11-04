import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { backupFileName, pruneBackups } from './backupRetention.js';

function usage(): never {
  console.error(`Usage: npm run backup --workspace apps/api -- [--db <path>] [--out <path> | --dir <dir> [--keep <n>]]

Creates a consistent SQLite backup using VACUUM INTO. Safe while the API is running.

Options:
  --db    Path to main DB file (defaults to DB_PATH env or data/finance.db)
  --out   Backup file path
  --dir   Backup directory; file is named finance-<timestamp>.db (default: backups/)
  --keep  With --dir: keep only the newest <n> backups in that directory
`);
  process.exit(2);
}

type Args = { db?: string; out?: string; dir?: string; keep?: number };

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '-h' || flag === '--help' || value === undefined) usage();
    i++;
    if (flag === '--db') args.db = value;
    else if (flag === '--out') args.out = value;
    else if (flag === '--dir') args.dir = value;
    else if (flag === '--keep') args.keep = Number(value);
    else usage();
  }
  if (args.out && args.dir) usage();
  if (args.keep !== undefined && !args.dir) usage();
  if (args.keep !== undefined && (!Number.isInteger(args.keep) || args.keep < 1)) usage();
  return args;
}

const args = parseArgs(process.argv.slice(2));

const dbPath = args.db || process.env.DB_PATH || path.resolve('data', 'finance.db');
const outDir = path.resolve(args.dir ?? 'backups');
const outPath = path.resolve(args.out ?? path.join(outDir, backupFileName()));

if (!fs.existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });

// Open in read-only mode; VACUUM INTO reads a consistent snapshot and writes a new file.
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  // SQLite requires the file to not already exist.
  if (fs.existsSync(outPath)) {
    console.error(`Backup destination already exists: ${outPath}`);
    process.exit(1);
  }

  db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}';`);
  fs.chmodSync(outPath, 0o600);
  const stat = fs.statSync(outPath);
  console.log(`OK: wrote backup ${outPath} (${stat.size} bytes)`);
} finally {
  db.close();
}

if (args.keep !== undefined) {
  for (const file of pruneBackups(outDir, args.keep, outPath)) console.log(`Pruned old backup ${file}`);
}
