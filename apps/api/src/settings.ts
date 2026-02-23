import { db } from './db.js';

export type AppSettings = {
  payday: number; // 1-28
  paydayFlexDays: number; // 0-7
  openaiConfigured: boolean;
};

const defaults: AppSettings = {
  payday: 15,
  paydayFlexDays: 2,
  openaiConfigured: false,
};

function getRaw(): Record<string, any> {
  const rows = db.prepare('SELECT key, value FROM app_settings').all() as Array<{ key: string; value: string }>;
  const map: Record<string, any> = {};
  for (const row of rows) {
    try {
      map[row.key] = JSON.parse(row.value);
    } catch {
      map[row.key] = row.value;
    }
  }
  return map;
}

export function getSettings(): AppSettings {
  const raw = getRaw();
  return {
    payday: Number(raw.payday ?? defaults.payday),
    paydayFlexDays: Number(raw.paydayFlexDays ?? defaults.paydayFlexDays),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
  };
}

export function updateSettings(input: Pick<AppSettings, 'payday' | 'paydayFlexDays'>) {
  const current = getSettings();
  const next = { ...current, ...input } as AppSettings;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  stmt.run('payday', JSON.stringify(next.payday), now);
  stmt.run('paydayFlexDays', JSON.stringify(next.paydayFlexDays), now);
  return next;
}

export function getOpenAIApiKey(): string | null {
  return process.env.OPENAI_API_KEY || null;
}
