import crypto from 'crypto';
import { db } from './db.js';
import { refreshLapse } from './patterns.js';
import { annualPatterns } from './patternDecisions.js';

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

/** A yearly payment: its month (1–12) and amount (positive). */
export type YearlyPayment = { month: number; amount: number };

/**
 * Whether a confirmation asks about this yearly payment: within a month of its month
 * and 25 % of its amount (detection's annual tolerance). Questions are asked once per
 * counterparty and month across accounts (patterns.ts, `detectConfirmationCandidates`),
 * so the same payment moved to another account is asked under the other account.
 */
function asksAbout(c: PatternConfirmation, p: YearlyPayment): boolean {
  const months = (((c.typical_month - p.month) % 12) + 12) % 12;
  return (months <= 1 || months === 11) && Math.abs(c.typical_amount - p.amount) <= 0.25 * p.amount;
}

/**
 * Pending confirmations still worth asking, largest first. Not one whose account has
 * an active pattern for the counterparty (detected, confirmed or created since the
 * question was made): there is one pattern per account and counterparty, and
 * confirming would retype it. Nor one about a yearly payment that an annual pattern on
 * another account already counts (`asksAbout`; counted: not rejected, withdrawn or
 * lapsed), so the payment is not counted twice. Creating a pattern also resolves them
 * (`supersedeConfirmations`).
 */
function openConfirmations(): PatternConfirmation[] {
  const pending = db
    .prepare("SELECT * FROM pattern_confirmations WHERE status = 'pending' ORDER BY typical_amount DESC")
    .all() as PatternConfirmation[];
  if (pending.length === 0) return [];
  const patterned = new Set(
    (db.prepare('SELECT account_id, counterparty_name FROM recurring_patterns WHERE is_active = 1').all() as Array<{
      account_id: string;
      counterparty_name: string | null;
    }>).map((p) => `${p.account_id}\u0000${p.counterparty_name}`)
  );
  const counted = annualPatterns().filter((p) => !p.lapsed && p.typical_month !== null);
  return pending.filter(
    (c) =>
      !patterned.has(`${c.account_id}\u0000${c.counterparty_name}`) &&
      !counted.some(
        (p) =>
          p.counterparty_name === c.counterparty_name &&
          asksAbout(c, { month: p.typical_month!, amount: p.typical_amount ?? 0 })
      )
  );
}

export function listPendingConfirmations(): PatternConfirmation[] {
  return openConfirmations().slice(0, 10);
}

/** Ids of every open confirmation (`listPendingConfirmations` without its limit). */
export function openConfirmationIds(): Set<string> {
  return new Set(openConfirmations().map((c) => c.id));
}

/**
 * Resolves pending confirmations as `superseded`: a pattern was created for the
 * counterparty (patternCreation.ts), so the question is answered. Those of its
 * account, and for a yearly pattern (`yearly`) those of other accounts about the same
 * yearly payment (`asksAbout`).
 */
export function supersedeConfirmations(
  accountId: string,
  counterparty: string,
  yearly: YearlyPayment | null,
  now: string
): void {
  const pending = db
    .prepare("SELECT * FROM pattern_confirmations WHERE counterparty_name = ? AND status = 'pending'")
    .all(counterparty) as PatternConfirmation[];
  const resolve = db.prepare("UPDATE pattern_confirmations SET status = 'superseded', resolved_at = ? WHERE id = ?");
  for (const c of pending) {
    if (c.account_id === accountId || (yearly && asksAbout(c, yearly))) resolve.run(now, c.id);
  }
}

/**
 * Confirms an open confirmation as an annual pattern. One no longer pending (already
 * answered or superseded) is `not_pending`; one hidden because the counterparty has a
 * pattern (`OPEN`) is `pattern_exists`: confirming it would retype or double that one.
 */
export function confirmPatternConfirmation(id: string): void {
  const conf = db.prepare('SELECT * FROM pattern_confirmations WHERE id = ?').get(id) as PatternConfirmation | undefined;
  if (!conf) throw new Error('not_found');
  if (conf.status !== 'pending') throw new Error('not_pending');
  if (!openConfirmationIds().has(id)) throw new Error('pattern_exists');

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
