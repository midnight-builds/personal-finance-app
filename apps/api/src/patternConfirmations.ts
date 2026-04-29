import crypto from 'crypto';
import { db } from './db.js';

export type PatternConfirmation = {
  id: string;
  created_at: string;
  account_id: string;
  counterparty_name: string;
  typical_month: number;
  typical_amount: number;
  currency: string;
  status: string;
};

export function listPendingConfirmations(): PatternConfirmation[] {
  return db.prepare(
    'SELECT * FROM pattern_confirmations WHERE status = ? ORDER BY typical_amount DESC LIMIT 10'
  ).all('pending') as PatternConfirmation[];
}

export function confirmPatternConfirmation(id: string): void {
  const conf = db.prepare('SELECT * FROM pattern_confirmations WHERE id = ?').get(id) as PatternConfirmation | undefined;
  if (!conf) throw new Error('not_found');

  const now = new Date().toISOString();
  const approxDate = `${new Date().getFullYear()}-${String(conf.typical_month).padStart(2, '0')}-01`;

  const existing = db.prepare(
    'SELECT id FROM recurring_patterns WHERE account_id = ? AND counterparty_name = ?'
  ).get(conf.account_id, conf.counterparty_name) as { id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE recurring_patterns SET updated_at = ?, pattern_type = 'annual',
        interval_days = 365, typical_amount = ?, is_active = 1,
        typical_month = ?, user_confirmed = 1
      WHERE id = ?
    `).run(now, conf.typical_amount, conf.typical_month, existing.id);
  } else {
    db.prepare(`
      INSERT INTO recurring_patterns
        (id, created_at, updated_at, account_id, counterparty_name, pattern_type,
         interval_days, typical_amount, currency, first_seen, last_seen,
         occurrence_count, is_active, typical_month, user_confirmed)
      VALUES (?, ?, ?, ?, ?, 'annual', 365, ?, ?, ?, ?, 1, 1, ?, 1)
    `).run(
      crypto.randomUUID(), now, now, conf.account_id, conf.counterparty_name,
      conf.typical_amount, conf.currency, approxDate, approxDate, conf.typical_month
    );
  }

  db.prepare('UPDATE pattern_confirmations SET status = ?, resolved_at = ? WHERE id = ?')
    .run('confirmed', now, id);
}

export function rejectPatternConfirmation(id: string): void {
  const conf = db.prepare('SELECT id FROM pattern_confirmations WHERE id = ?').get(id);
  if (!conf) throw new Error('not_found');
  db.prepare('UPDATE pattern_confirmations SET status = ?, resolved_at = ? WHERE id = ?')
    .run('rejected', new Date().toISOString(), id);
}
