import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'crypto';
import { collapseDuplicateGroups } from './migrations/collapseDuplicates.js';
import { ensurePendingTransactions } from './migrations/pendingTransactions.js';

const IN_MEMORY = ':memory:';

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/**
 * True when this process runs tests, however it was started: `node --test`,
 * `tsx --test`, or a test file executed directly (`tsx tests/x.test.ts`).
 */
function isTestProcess() {
  const args = [...process.execArgv, ...process.argv];
  return (
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    args.some((a) => a === '--test' || a.startsWith('--test=') || TEST_FILE.test(a))
  );
}

function resolveDbPath() {
  // No default: real data and the demo database live outside the repo
  // (docs/ENVIRONMENTS.md), and guessing a path is how a dev run once opened
  // the wrong one. The systemd units and npm scripts always set DB_PATH.
  const configured = process.env.DB_PATH;
  if (!configured) {
    throw new Error('DB_PATH is not set. See docs/ENVIRONMENTS.md (production: ~/finance-app-data/finance.db, development: npm run dev uses the demo database).');
  }
  // Tests wipe tables in beforeEach, so a test process must never open a file
  // database. Test files import tests/setup/testDb.ts first; this is the backstop.
  if (configured !== IN_MEMORY && isTestProcess()) {
    throw new Error(
      `Refusing to open ${configured} from a test process; import tests/setup/testDb.ts first or set DB_PATH=${IN_MEMORY}`
    );
  }
  // A mistyped or forgotten path must fail, not start the app on a fresh empty
  // database that looks like real data. Only callers that mean to create one
  // (the demo seed) set DB_CREATE=1.
  if (configured !== IN_MEMORY && !fs.existsSync(configured) && process.env.DB_CREATE !== '1') {
    throw new Error(`Database ${configured} does not exist. Check DB_PATH (docs/ENVIRONMENTS.md); set DB_CREATE=1 to create a new one.`);
  }
  return configured;
}

const dbPath = resolveDbPath();

if (dbPath !== IN_MEMORY) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

export const db = new DatabaseSync(dbPath);

export function initDb() {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      name TEXT NOT NULL,
      iban TEXT,
      type TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_iban ON accounts(iban);

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      name TEXT NOT NULL,
      built_in INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name ON categories(name);

    CREATE TABLE IF NOT EXISTS categorization_decisions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      transaction_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      source TEXT NOT NULL,
      rule_id TEXT,
      FOREIGN KEY(transaction_id) REFERENCES normalized_transactions(id),
      FOREIGN KEY(category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS category_rules (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      category_id TEXT NOT NULL,
      pattern TEXT NOT NULL,
      match_field TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS import_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      source_bank TEXT NOT NULL,
      format TEXT NOT NULL,
      file_checksum TEXT,
      row_count INTEGER,
      overlap_key TEXT
    );

    CREATE TABLE IF NOT EXISTS raw_transactions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      import_session_id TEXT NOT NULL,
      data TEXT NOT NULL,
      booking_date TEXT,
      amount REAL,
      currency TEXT,
      FOREIGN KEY(import_session_id) REFERENCES import_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS normalized_transactions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      raw_transaction_id TEXT UNIQUE,
      import_session_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      booking_date TEXT,
      transaction_date TEXT,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      counterparty_name TEXT,
      counterparty_iban TEXT,
      description TEXT,
      FOREIGN KEY(raw_transaction_id) REFERENCES raw_transactions(id),
      FOREIGN KEY(import_session_id) REFERENCES import_sessions(id),
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS transfer_links (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      from_transaction_id TEXT NOT NULL,
      to_transaction_id TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      FOREIGN KEY(from_transaction_id) REFERENCES normalized_transactions(id),
      FOREIGN KEY(to_transaction_id) REFERENCES normalized_transactions(id)
    );

    CREATE TABLE IF NOT EXISTS balance_snapshots (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      balance REAL NOT NULL,
      currency TEXT NOT NULL,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS balance_adjustments (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      reason TEXT,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );

    
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- Secrets are not stored in DB; keep API keys in env only
    DELETE FROM app_settings WHERE key = 'openaiApiKey';

    CREATE TABLE IF NOT EXISTS event_log (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      type TEXT NOT NULL,
      scope TEXT,
      message TEXT NOT NULL,
      payload TEXT
    );

    CREATE TABLE IF NOT EXISTS briefing_sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      import_session_id TEXT,
      finding_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(import_session_id) REFERENCES import_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS insight_findings (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      briefing_session_id TEXT,
      finding_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      impact_eur REAL,
      transaction_ids TEXT,
      metadata TEXT,
      dismissed_at TEXT,
      FOREIGN KEY(briefing_session_id) REFERENCES briefing_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS recurring_patterns (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      account_id TEXT NOT NULL,
      counterparty_name TEXT,
      pattern_type TEXT NOT NULL,
      interval_days INTEGER,
      typical_amount REAL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS rule_suggestions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      category_id TEXT NOT NULL,
      category_name TEXT NOT NULL,
      pattern TEXT NOT NULL,
      match_field TEXT NOT NULL DEFAULT 'counterparty',
      sample_counterparty TEXT,
      ai_reason TEXT,
      confidence REAL NOT NULL DEFAULT 0.8,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_at TEXT,
      FOREIGN KEY(category_id) REFERENCES categories(id)
    );
    CREATE INDEX IF NOT EXISTS idx_rule_suggestions_status ON rule_suggestions(status);

    CREATE TABLE IF NOT EXISTS pattern_confirmations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      account_id TEXT NOT NULL,
      counterparty_name TEXT NOT NULL,
      typical_month INTEGER NOT NULL,
      typical_amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_at TEXT,
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pattern_conf_status ON pattern_confirmations(status);
    CREATE INDEX IF NOT EXISTS idx_pattern_conf_account ON pattern_confirmations(account_id);

    CREATE TABLE IF NOT EXISTS feature_proposals (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      problem TEXT NOT NULL,
      evidence TEXT NOT NULL,
      proposal TEXT NOT NULL,
      acceptance_criteria TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      resolved_at TEXT,
      decision_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feature_proposals_status ON feature_proposals(status);
    CREATE TABLE IF NOT EXISTS feature_proposal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id TEXT NOT NULL REFERENCES feature_proposals(id),
      at TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      resolution TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feature_proposal_events_proposal ON feature_proposal_events(proposal_id);

    CREATE INDEX IF NOT EXISTS idx_import_sessions_overlap ON import_sessions(overlap_key);
    CREATE INDEX IF NOT EXISTS idx_normalized_booking_date ON normalized_transactions(booking_date);
    CREATE INDEX IF NOT EXISTS idx_normalized_account_date ON normalized_transactions(account_id, booking_date);
    CREATE INDEX IF NOT EXISTS idx_normalized_counterparty_iban ON normalized_transactions(counterparty_iban);
    DROP INDEX IF EXISTS idx_catdec_tx;
    CREATE INDEX IF NOT EXISTS idx_catdec_tx_latest ON categorization_decisions(transaction_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_transfer_links_from ON transfer_links(from_transaction_id);
    CREATE INDEX IF NOT EXISTS idx_transfer_links_to ON transfer_links(to_transaction_id);
    CREATE INDEX IF NOT EXISTS idx_event_log_created_at ON event_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_recurring_account ON recurring_patterns(account_id);
    CREATE INDEX IF NOT EXISTS idx_findings_briefing ON insight_findings(briefing_session_id);
    CREATE INDEX IF NOT EXISTS idx_findings_type ON insight_findings(finding_type);
    DELETE FROM balance_snapshots WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM balance_snapshots GROUP BY account_id, date
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_snapshots_account_date ON balance_snapshots(account_id, date);
  `);

  // Idempotent column migrations for existing tables
  function safeExec(sql: string) {
    try { db.exec(sql); } catch { /* column already exists — safe to ignore */ }
  }

  safeExec(`ALTER TABLE accounts ADD COLUMN account_subtype TEXT NOT NULL DEFAULT 'checking'`);
  safeExec(`ALTER TABLE accounts ADD COLUMN owner_label TEXT`);
  safeExec(`ALTER TABLE accounts ADD COLUMN credit_limit REAL`);
  safeExec(`ALTER TABLE accounts ADD COLUMN savings_goal REAL`);

  safeExec(`ALTER TABLE recurring_patterns ADD COLUMN typical_month INTEGER`);
  safeExec(`ALTER TABLE recurring_patterns ADD COLUMN user_confirmed INTEGER`);

  safeExec(`ALTER TABLE feature_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'feature'`);
  safeExec(`ALTER TABLE feature_proposals ADD COLUMN resolution TEXT`);
  safeExec(`ALTER TABLE feature_proposals ADD COLUMN updated_at TEXT`);
  // Decisions made before the event log existed become its first entry.
  db.exec(`
    INSERT INTO feature_proposal_events (proposal_id, at, status, note)
    SELECT id, resolved_at, status, decision_note FROM feature_proposals p
    WHERE status != 'new' AND resolved_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM feature_proposal_events e WHERE e.proposal_id = p.id)
  `);

  // Categories: a role marks the special ones (found by role, never by name);
  // archived categories are hidden but keep their decisions.
  safeExec(`ALTER TABLE categories ADD COLUMN role TEXT`);
  safeExec(`ALTER TABLE categories ADD COLUMN archived_at TEXT`);
  safeExec(`ALTER TABLE categories ADD COLUMN merged_into_id TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_role ON categories(role) WHERE role IS NOT NULL`);
  // Databases from before roles: the default categories take their roles by
  // their (then fixed) names, unless some category already has the role.
  const assignRole = db.prepare(
    `UPDATE categories SET role = ? WHERE name = ? AND role IS NULL
       AND NOT EXISTS (SELECT 1 FROM categories WHERE role = ?)`
  );
  for (const [role, name] of Object.entries(ROLE_DEFAULT_NAMES)) assignRole.run(role, name, role);

  // Rules: built-in rules live in the table too, below user rules; a disabled
  // rule stops matching but is kept.
  safeExec(`ALTER TABLE category_rules ADD COLUMN match_type TEXT NOT NULL DEFAULT 'contains'`);
  safeExec(`ALTER TABLE category_rules ADD COLUMN amount_sign TEXT`);
  safeExec(`ALTER TABLE category_rules ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0`);
  safeExec(`ALTER TABLE category_rules ADD COLUMN disabled_at TEXT`);
  safeExec(`ALTER TABLE category_rules ADD COLUMN actor TEXT`);

  // Decisions: who made them (null = before actors existed) and why.
  safeExec(`ALTER TABLE categorization_decisions ADD COLUMN actor TEXT`);
  safeExec(`ALTER TABLE categorization_decisions ADD COLUMN reason TEXT`);

  // Change sets: every categorization change, with what it changed and the
  // before values its undo needs (src/categorization.ts). Decisions and rules
  // a set wrote point back to it; a rule also records the set that disabled it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS change_sets (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      reason TEXT,
      plan_token TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'applied',
      undo_of_id TEXT REFERENCES change_sets(id)
    );
    CREATE INDEX IF NOT EXISTS idx_change_sets_undo_of ON change_sets(undo_of_id);
  `);
  safeExec(`ALTER TABLE categorization_decisions ADD COLUMN change_set_id TEXT`);
  safeExec(`ALTER TABLE category_rules ADD COLUMN change_set_id TEXT`);
  safeExec(`ALTER TABLE category_rules ADD COLUMN disabled_change_set_id TEXT`);

  safeExec(`
    DELETE FROM category_rules WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM category_rules
      GROUP BY pattern, category_id, match_field, match_type, amount_sign
    )
  `);

  // A transaction is stored once: databases that still hold re-imported
  // copies grouped with the first one are collapsed (runs once).
  collapseDuplicateGroups(db);

  // Pending rows: one transaction from reservation to booking (or void).
  ensurePendingTransactions(db);
}

export type CategoryRole = 'fallback' | 'income' | 'refund';

/** The name a role category gets when it has to be created. */
const ROLE_DEFAULT_NAMES: Record<CategoryRole, string> = {
  fallback: 'Muut ja epäselvät',
  income: 'Tulopuoli ja palkka',
  refund: 'Palautukset ja hyvitykset',
};

const DEFAULT_CATEGORIES = [
  'Ruoka ja päivittäistavarat',
  'Asuminen ja asumiskulut',
  'Auto ja liikkuminen',
  'Autojen lyhennys',
  'Terveys ja hyvinvointi',
  'Vakuutukset',
  'Laskut ja sopimukset',
  'Viihde ja harrastukset',
  'Lapsiin liittyvät kulut',
  'Sijoitukset ja säästäminen',
  ROLE_DEFAULT_NAMES.income,
  ROLE_DEFAULT_NAMES.refund,
  ROLE_DEFAULT_NAMES.fallback,
];

/**
 * The keyword heuristics categorization started with, as built-in rules:
 * matched case-insensitively against counterparty + description, in this
 * order, after every user rule. A target is a role or a default category's
 * name, resolved to an id when the rules are seeded, so renaming the category
 * later changes nothing.
 */
const BUILTIN_RULES: Array<{
  pattern: string;
  target: { role: CategoryRole } | { name: string };
  amountSign?: 'positive';
}> = [
  { pattern: 'palkka|salary|payroll', target: { role: 'income' }, amountSign: 'positive' },
  { pattern: 'hyvitys|palautus|refund', target: { role: 'refund' }, amountSign: 'positive' },
  { pattern: 'sähkö|energia|läm[p]?ö|electric', target: { name: 'Laskut ja sopimukset' } },
  { pattern: 'jäte|jätteen|waste|trash|recycling', target: { name: 'Laskut ja sopimukset' } },
  { pattern: 'puhelin|internet|laajakaista|mobiili|mobile|broadband', target: { name: 'Laskut ja sopimukset' } },
  { pattern: 'vakuutus', target: { name: 'Vakuutukset' } },
  { pattern: 'ruoka|market|k[- ]?market|s-market|prisma|lid[l]?', target: { name: 'Ruoka ja päivittäistavarat' } },
  { pattern: 'auto|bensa|poltto|tankkaus|fuel|huolto', target: { name: 'Auto ja liikkuminen' } },
  { pattern: 'palkka|salary|payroll', target: { role: 'income' } },
];

/** Priority of the first built-in rule, the rest count down; user rules use 10. */
const BUILTIN_TOP_PRIORITY = 0;

/**
 * Default categories go only into an empty table, so a renamed default is not
 * brought back. Afterwards every role has a category, and the built-in rules
 * exist.
 */
export function seedDefaultCategories() {
  const now = new Date().toISOString();
  const insert = db.prepare(
    'INSERT INTO categories (id, created_at, name, built_in, role) VALUES (?, ?, ?, 1, ?)'
  );
  if (!db.prepare('SELECT 1 FROM categories LIMIT 1').get()) {
    const roleOf = new Map<string, string>(Object.entries(ROLE_DEFAULT_NAMES).map(([role, name]) => [name, role]));
    for (const name of DEFAULT_CATEGORIES) insert.run(crypto.randomUUID(), now, name, roleOf.get(name) ?? null);
  }
  for (const [role, name] of Object.entries(ROLE_DEFAULT_NAMES)) {
    if (db.prepare('SELECT 1 FROM categories WHERE role = ?').get(role)) continue;
    // A category without a role may hold the default name: it takes the role
    // (and is back in use, since a role category cannot be archived). A name
    // held by another role's category is left alone; the role stays unfilled.
    const named = db
      .prepare('UPDATE categories SET role = ?, archived_at = NULL WHERE name = ? AND role IS NULL')
      .run(role, name);
    if (Number(named.changes) > 0) continue;
    if (!db.prepare('SELECT 1 FROM categories WHERE name = ?').get(name)) insert.run(crypto.randomUUID(), now, name, role);
  }
  seedBuiltinRules(now);
}

/**
 * Inserts the built-in rules unless they are there. Rules are disabled, never
 * deleted, so any built-in row means they were seeded. A rule whose target
 * category does not exist is skipped.
 */
function seedBuiltinRules(now: string) {
  if (db.prepare('SELECT 1 FROM category_rules WHERE builtin = 1 LIMIT 1').get()) return;
  const insert = db.prepare(
    `INSERT INTO category_rules
       (id, created_at, category_id, pattern, match_field, priority, match_type, amount_sign, builtin)
     VALUES (?, ?, ?, ?, 'text', ?, 'regex', ?, 1)`
  );
  BUILTIN_RULES.forEach((rule, i) => {
    const target = (
      'role' in rule.target
        ? db.prepare('SELECT id FROM categories WHERE role = ?').get(rule.target.role)
        : db.prepare('SELECT id FROM categories WHERE name = ? AND archived_at IS NULL').get(rule.target.name)
    ) as { id: string } | undefined;
    if (!target) return;
    insert.run(crypto.randomUUID(), now, target.id, rule.pattern, BUILTIN_TOP_PRIORITY - i, rule.amountSign ?? null);
  });
}

