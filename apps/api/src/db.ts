import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'crypto';

const dbPath = process.env.DB_PATH || path.resolve('data', 'finance.db');

const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir) && dataDir !== ':memory:') {
  fs.mkdirSync(dataDir, { recursive: true });
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
      transaction_group_id TEXT,
      FOREIGN KEY(raw_transaction_id) REFERENCES raw_transactions(id),
      FOREIGN KEY(import_session_id) REFERENCES import_sessions(id),
      FOREIGN KEY(account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS transaction_groups (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      canonical_transaction_id TEXT
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

    CREATE INDEX IF NOT EXISTS idx_import_sessions_overlap ON import_sessions(overlap_key);
    CREATE INDEX IF NOT EXISTS idx_normalized_booking_date ON normalized_transactions(booking_date);
    CREATE INDEX IF NOT EXISTS idx_normalized_account_date ON normalized_transactions(account_id, booking_date);
    CREATE INDEX IF NOT EXISTS idx_normalized_group ON normalized_transactions(transaction_group_id);
    CREATE INDEX IF NOT EXISTS idx_transaction_groups_canonical ON transaction_groups(canonical_transaction_id);
    CREATE INDEX IF NOT EXISTS idx_normalized_counterparty_iban ON normalized_transactions(counterparty_iban);
    CREATE INDEX IF NOT EXISTS idx_catdec_tx ON categorization_decisions(transaction_id);
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
}

export function seedDefaultCategories() {
  const defaults = [
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
    'Tulopuoli ja palkka',
    'Palautukset ja hyvitykset',
    'Muut ja epäselvät',
  ];
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT name FROM categories').all() as Array<{ name: string }>;
  const existingNames = new Set(existing.map((c) => c.name));
  const insert = db.prepare(
    'INSERT INTO categories (id, created_at, name, built_in) VALUES (?, ?, ?, ?)'
  );
  for (const name of defaults) {
    if (existingNames.has(name)) continue;
    insert.run(crypto.randomUUID(), now, name, 1);
  }
}
