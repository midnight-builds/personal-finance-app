// Creates the demo database: a fictional household (src/demo/demoData.ts),
// marked as demo so the web shows a DEMO ribbon and the MCP server refuses it.
//
//   npm run seed:demo -w apps/api [-- --db <path>] [--anchor YYYY-MM-DD] [--replace | --if-missing]
//
// Default path: $DEMO_DB_PATH, else ~/finance-app-data/demo/demo.db. The anchor
// (default: today in Helsinki) is the last day of the six-month history.
// Without --replace only a new file is created. --replace recreates an existing
// file, and only if that file is itself marked as demo: real data is never touched.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DEMO_DB = path.join(os.homedir(), 'finance-app-data', 'demo', 'demo.db');

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function isMarkedDemo(file: string) {
  const probe = new DatabaseSync(file, { readOnly: true });
  try {
    const row = probe.prepare(`SELECT value FROM app_settings WHERE key = 'dataset'`).get() as
      | { value: string }
      | undefined;
    return row?.value === 'demo';
  } catch {
    return false; // no app_settings table: not a database this script made
  } finally {
    probe.close();
  }
}

const dbPath = path.resolve(arg('db') || process.env.DEMO_DB_PATH || DEFAULT_DEMO_DB);
const anchor = arg('anchor') ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Helsinki' });
if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) fail(`Invalid --anchor ${anchor}`);

if (fs.existsSync(dbPath)) {
  // `npm run dev` seeds on first use and otherwise leaves the demo as it is.
  if (process.argv.includes('--if-missing')) {
    if (!isMarkedDemo(dbPath)) fail(`Refusing to use ${dbPath} for development: it is not marked as demo data.`);
    process.exit(0);
  }
  if (!process.argv.includes('--replace')) fail(`${dbPath} exists; pass --replace to recreate the demo database.`);
  if (!isMarkedDemo(dbPath)) fail(`Refusing to replace ${dbPath}: it is not marked as demo data.`);
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(file, { force: true });
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
process.env.DB_PATH = dbPath;
process.env.DB_CREATE = '1';
const { db, initDb, seedDefaultCategories } = await import('../src/db.js');
initDb();
seedDefaultCategories();

const { seedDemo } = await import('../src/demo/demoData.js');
const result = await seedDemo(anchor);
const count = db.prepare('SELECT COUNT(*) AS n FROM normalized_transactions').get() as { n: number };
console.log(`Seeded ${dbPath} (anchor ${anchor}): ${count.n} transactions, imports ${result.importSessionIds.length}`);
