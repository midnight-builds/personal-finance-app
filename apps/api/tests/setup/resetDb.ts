import { db, initDb, seedDefaultCategories } from '../../src/db.js';

/**
 * Empties every table of the in-memory test database and restores the default
 * categories. Lists tables from the schema, so new tables are covered without
 * editing a hand-kept DELETE list.
 */
export function resetDb() {
  initDb();
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>;
  db.exec('PRAGMA foreign_keys = OFF');
  for (const { name } of tables) db.exec(`DELETE FROM "${name}"`);
  db.exec('PRAGMA foreign_keys = ON');
  seedDefaultCategories();
}
