import crypto from 'crypto';
import { db } from './db.js';

const SUBSCRIPTION_KEYWORDS = [
  'netflix', 'spotify', 'hbo', 'disney', 'apple', 'google', 'youtube',
  'amazon', 'microsoft', 'adobe', 'dropbox', 'github', 'linkedin',
  'telia', 'elisa', 'dna', 'helen', 'vattenfall',
];

function isSubscriptionLike(counterparty: string, amount: number): boolean {
  const lower = counterparty.toLowerCase();
  if (SUBSCRIPTION_KEYWORDS.some((k) => lower.includes(k))) return true;
  return Math.abs(amount) < 50;
}

export function detectPatterns(accountId: string): void {
  const now = new Date().toISOString();
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400_000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT counterparty_name, amount, booking_date
    FROM normalized_transactions
    WHERE account_id = ?
      AND booking_date >= ?
      AND amount < 0
      AND counterparty_name IS NOT NULL
      -- Exclude counterparties where ANY transaction is transfer-linked — prevents
      -- intra-account transfer counterparties (e.g. "Siirto") from appearing as recurring spend.
      AND counterparty_name NOT IN (
        SELECT DISTINCT counterparty_name
        FROM normalized_transactions
        WHERE account_id = ?
          AND id IN (
            SELECT from_transaction_id FROM transfer_links
            UNION SELECT to_transaction_id FROM transfer_links
          )
      )
    ORDER BY counterparty_name, booking_date
  `).all(accountId, sixMonthsAgo, accountId) as Array<{ counterparty_name: string; amount: number; booking_date: string }>;

  // Group by counterparty
  const byCounterparty = new Map<string, Array<{ amount: number; date: string }>>();
  for (const r of rows) {
    const key = r.counterparty_name;
    if (!byCounterparty.has(key)) byCounterparty.set(key, []);
    byCounterparty.get(key)!.push({ amount: r.amount, date: r.booking_date });
  }

  for (const [counterparty, occurrences] of byCounterparty) {
    if (occurrences.length < 2) continue;

    // Check interval consistency — sort by date
    const sorted = occurrences.sort((a, b) => a.date.localeCompare(b.date));
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const a = new Date(sorted[i - 1].date).getTime();
      const b = new Date(sorted[i].date).getTime();
      intervals.push((b - a) / 86400_000);
    }

    const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    // Monthly: 25–35 day interval
    if (avgInterval < 25 || avgInterval > 35) continue;

    // Check amount consistency (±20%)
    // typical_amount is stored as a positive absolute value (e.g. 15.99, not -15.99)
    const amounts = sorted.map((o) => Math.abs(o.amount));
    const avgAmount = amounts.reduce((s, v) => s + v, 0) / amounts.length;
    if (avgAmount === 0) continue;
    const consistent = amounts.every((a) => Math.abs(a - avgAmount) / avgAmount <= 0.2);
    if (!consistent) continue;

    const patternType = isSubscriptionLike(counterparty, avgAmount) ? 'subscription' : 'recurring';
    const firstSeen = sorted[0].date;
    const lastSeen = sorted[sorted.length - 1].date;

    // Upsert by account_id + counterparty_name
    const existing = db.prepare(
      'SELECT id FROM recurring_patterns WHERE account_id = ? AND counterparty_name = ?'
    ).get(accountId, counterparty) as { id: string } | undefined;

    if (existing) {
      db.prepare(`
        UPDATE recurring_patterns
        SET updated_at = ?, pattern_type = ?, interval_days = ?, typical_amount = ?,
            last_seen = ?, occurrence_count = ?, is_active = 1
        WHERE id = ?
      `).run(now, patternType, Math.round(avgInterval), avgAmount, lastSeen, sorted.length, existing.id);
    } else {
      db.prepare(`
        INSERT INTO recurring_patterns
          (id, created_at, updated_at, account_id, counterparty_name, pattern_type,
           interval_days, typical_amount, currency, first_seen, last_seen, occurrence_count, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, 1)
      `).run(
        crypto.randomUUID(), now, now, accountId, counterparty, patternType,
        Math.round(avgInterval), avgAmount, firstSeen, lastSeen, sorted.length
      );
    }
  }
}
