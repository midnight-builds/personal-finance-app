// Creates a demo database filled with fictional data (src/demo/demoData.ts).
//
//   npm run seed:demo -w apps/api -- --db data/demo.db [--anchor 2026-11-05]
//
// Then run the API against it on a spare port, e.g.
//   DB_PATH=data/demo.db PORT=3101 npm run dev -w apps/api
//
// Only creates a new file, and refuses any database that has transactions:
// demo rows must never mix with real ones.
import path from 'node:path';
import fs from 'node:fs';

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbArg = arg('db');
if (!dbArg) {
  console.error('Usage: seed-demo --db <path> [--anchor YYYY-MM-DD]');
  process.exit(1);
}
const dbPath = path.resolve(dbArg);
// Only ever a brand-new file: an existing one (or a symlink to one) may be real data.
if (fs.existsSync(dbPath) || path.basename(dbPath) === 'finance.db') {
  console.error(`Refusing to seed ${dbPath}: pick a path that does not exist yet.`);
  process.exit(1);
}
const anchor = arg('anchor') ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Helsinki' });
if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
  console.error(`Invalid --anchor ${anchor}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
process.env.DB_PATH = dbPath;
const { db, initDb, seedDefaultCategories } = await import('../src/db.js');
initDb();
seedDefaultCategories();

const existing = db.prepare('SELECT COUNT(*) AS n FROM normalized_transactions').get() as { n: number };
if (existing.n > 0) {
  console.error(`Refusing to seed ${dbPath}: it already has ${existing.n} transactions.`);
  process.exit(1);
}

const { seedDemo } = await import('../src/demo/demoData.js');
const result = await seedDemo(anchor);
const count = db.prepare('SELECT COUNT(*) AS n FROM normalized_transactions').get() as { n: number };
console.log(`Seeded ${dbPath} (anchor ${anchor}): ${count.n} transactions, imports ${result.importSessionIds.length}`);
