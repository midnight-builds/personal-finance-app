import crypto from 'crypto';
import { db } from './db.js';
import { refreshLapse } from './patterns.js';

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

// Pending confirmations still worth asking: the account has no active pattern for the
// counterparty (detected, confirmed or created since the question was made). One
// pattern per account and counterparty, so such a question is never asked; it is
// hidden, and creating a pattern resolves it (`supersedeConfirmations`).
const OPEN = `c.status = 'pending' AND NOT EXISTS (
  SELECT 1 FROM recurring_patterns p
  WHERE p.account_id = c.account_id AND p.counterparty_name = c.counterparty_name AND p.is_active = 1)`;

export function listPendingConfirmations(): PatternConfirmation[] {
  return db.prepare(
    `SELECT c.* FROM pattern_confirmations c WHERE ${OPEN} ORDER BY c.typical_amount DESC LIMIT 10`
  ).all() as PatternConfirmation[];
}

/** Ids of every open confirmation (`listPendingConfirmations` without its limit). */
export function openConfirmationIds(): Set<string> {
  const rows = db.prepare(`SELECT c.id FROM pattern_confirmations c WHERE ${OPEN}`).all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * Resolves the pending confirmations of an account and counterparty as `superseded`:
 * a pattern was created for it (patternCreation.ts), so the question is answered.
 */
export function supersedeConfirmations(accountId: string, counterparty: string, now: string): void {
  db.prepare(
    `UPDATE pattern_confirmations SET status = 'superseded', resolved_at = ?
     WHERE account_id = ? AND counterparty_name = ? AND status = 'pending'`
  ).run(now, accountId, counterparty);
}

export function confirmPatternConfirmation(id: string): void {
  const conf = db.prepare('SELECT * FROM pattern_confirmations WHERE id = ?').get(id) as PatternConfirmation | undefined;
  if (!conf) throw new Error('not_found');

  const now = new Date().toISOString();
  const approxDate = `${new Date().getFullYear()}-${String(conf.typical_month).padStart(2, '0')}-01`;

  const existing = db.prepare(
    'SELECT id, origin FROM recurring_patterns WHERE account_id = ? AND counterparty_name = ?'
  ).get(conf.account_id, conf.counterparty_name) as { id: string; origin: string } | undefined;
  // A created pattern is changed only by pattern decisions (GLOSSARY.md, "Created pattern").
  if (existing?.origin === 'created') throw new Error('pattern_exists');

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
  // Its charge may be old: the annual pattern may have lapsed already.
  refreshLapse(conf.account_id);
}

export function rejectPatternConfirmation(id: string): void {
  const conf = db.prepare('SELECT id FROM pattern_confirmations WHERE id = ?').get(id);
  if (!conf) throw new Error('not_found');
  db.prepare('UPDATE pattern_confirmations SET status = ?, resolved_at = ? WHERE id = ?')
    .run('rejected', new Date().toISOString(), id);
}
