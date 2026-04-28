import crypto from 'crypto';
import { db } from './db.js';

type FindingInput = {
  finding_type: string;
  title: string;
  description: string;
  severity: 'info' | 'warn' | 'alert';
  impact_eur?: number;
  transaction_ids?: string[];
  metadata?: Record<string, unknown>;
};

function fmt(n: number) {
  return `${Math.abs(n).toFixed(2)} €`;
}

// ── Generators ────────────────────────────────────────────────────

function subscriptionCreep(): FindingInput[] {
  const subs = db.prepare(`
    SELECT counterparty_name, typical_amount, account_id, created_at
    FROM recurring_patterns
    WHERE pattern_type = 'subscription' AND is_active = 1
    ORDER BY typical_amount DESC
  `).all() as Array<{ counterparty_name: string; typical_amount: number; account_id: string; created_at: string }>;

  if (subs.length === 0) return [];

  const total = subs.reduce((s, r) => s + r.typical_amount, 0);
  const newSubs = subs.filter((s) => {
    const age = (Date.now() - new Date(s.created_at).getTime()) / 86400_000;
    return age <= 60;
  });

  const list = subs.map((s) => `${s.counterparty_name} ${fmt(s.typical_amount)}`).join(', ');
  const newList = newSubs.map((s) => s.counterparty_name).join(', ');

  let description = `Sinulla on ${subs.length} aktiivista tilauspalvelua — yhteensä ${fmt(total)}/kk. Palvelut: ${list}.`;
  if (newSubs.length > 0) {
    description += ` Uudet (60 pv sisällä): ${newList}.`;
  }

  return [{
    finding_type: 'subscription_creep',
    title: `${subs.length} tilauspalvelua — yhteensä ${fmt(total)}/kk`,
    description,
    severity: total > 80 ? 'warn' : 'info',
    impact_eur: total,
    metadata: { count: subs.length, totalMonthly: total, newCount: newSubs.length },
  }];
}

function newRecurring(): FindingInput[] {
  const cutoff = new Date(Date.now() - 60 * 86400_000).toISOString();
  const patterns = db.prepare(`
    SELECT counterparty_name, pattern_type, typical_amount, interval_days
    FROM recurring_patterns
    WHERE is_active = 1 AND created_at >= ?
    ORDER BY typical_amount DESC
  `).all(cutoff) as Array<{ counterparty_name: string; pattern_type: string; typical_amount: number; interval_days: number }>;

  return patterns.map((p) => ({
    finding_type: 'new_recurring',
    title: `Uusi toistuva veloitus: ${p.counterparty_name}`,
    description: `Uusi ${p.pattern_type === 'subscription' ? 'tilaus' : 'toistuva maksu'} tunnistettu: ${p.counterparty_name} noin ${fmt(p.typical_amount)} n. ${p.interval_days} päivän välein.`,
    severity: 'info' as const,
    impact_eur: p.typical_amount,
  }));
}

function oneOffImpact(): FindingInput[] {
  const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const ninetyAgo = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

  // Baseline: average single-transaction amount for non-transfer, non-recurring txs in prior 60 days
  const baselineRow = db.prepare(`
    SELECT AVG(ABS(amount)) AS avg_amount
    FROM normalized_transactions
    WHERE booking_date BETWEEN ? AND ?
      AND amount < 0
      AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
      AND (counterparty_name IS NULL OR counterparty_name NOT IN (SELECT counterparty_name FROM recurring_patterns WHERE is_active = 1))
  `).get(ninetyAgo, thirtyAgo) as { avg_amount: number | null };

  const baseline = baselineRow.avg_amount ?? 100;
  const threshold = baseline * 2;

  const largeOnes = db.prepare(`
    SELECT id, counterparty_name, amount, booking_date
    FROM normalized_transactions
    WHERE booking_date >= ?
      AND amount < 0
      AND ABS(amount) > ?
      AND id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
      AND (counterparty_name IS NULL OR counterparty_name NOT IN (SELECT counterparty_name FROM recurring_patterns WHERE is_active = 1))
    ORDER BY amount ASC
    LIMIT 3
  `).all(thirtyAgo, threshold) as Array<{ id: string; counterparty_name: string | null; amount: number; booking_date: string }>;

  return largeOnes.map((tx) => ({
    finding_type: 'one_off_impact',
    title: `Kertaluonteinen hankinta: ${tx.counterparty_name ?? 'Tuntematon'} ${fmt(tx.amount)}`,
    description: `Ostit ${tx.counterparty_name ?? 'tuntematon kauppias'} ${fmt(tx.amount)} (${tx.booking_date}). Tämä on yli 2× tyypillinen yksittäinen kulusi.`,
    severity: (Math.abs(tx.amount) > threshold * 2 ? 'warn' : 'info') as 'warn' | 'info',
    impact_eur: Math.abs(tx.amount),
    transaction_ids: [tx.id],
  }));
}

function savingsProgress(): FindingInput[] {
  // Single query: get the last 4 balance snapshots for all savings accounts
  const rows = db.prepare(`
    SELECT a.id AS accountId, a.name AS accountName, bs.balance, bs.date
    FROM accounts a
    JOIN balance_snapshots bs ON bs.account_id = a.id
    WHERE a.account_subtype = 'savings'
      AND bs.date IN (
        SELECT date FROM balance_snapshots
        WHERE account_id = a.id
        ORDER BY date DESC LIMIT 4
      )
    ORDER BY a.id, bs.date DESC
  `).all() as Array<{ accountId: string; accountName: string; balance: number; date: string }>;

  // Group by account
  const byAccount = new Map<string, { name: string; snapshots: Array<{ balance: number; date: string }> }>();
  for (const r of rows) {
    if (!byAccount.has(r.accountId)) byAccount.set(r.accountId, { name: r.accountName, snapshots: [] });
    byAccount.get(r.accountId)!.snapshots.push({ balance: r.balance, date: r.date });
  }

  const findings: FindingInput[] = [];
  for (const [, { name, snapshots }] of byAccount) {
    if (snapshots.length < 2) continue;
    const latest = snapshots[0].balance;
    const prev = snapshots[snapshots.length - 1].balance;
    const delta = latest - prev;
    const trend = delta > 0 ? 'kasvanut' : delta < 0 ? 'laskenut' : 'pysynyt samana';
    const severity: 'info' | 'warn' = delta < 0 ? 'warn' : 'info';
    findings.push({
      finding_type: 'savings_progress',
      title: `Säästötili ${name}: ${delta >= 0 ? '+' : ''}${fmt(delta)}`,
      description: `Säästötilisi ${name} saldo on ${trend} ${fmt(Math.abs(delta))} seurantajaksolla. Nykyinen saldo: ${fmt(latest)}.`,
      severity,
      impact_eur: Math.abs(delta),
      metadata: { currentBalance: latest, delta },
    });
  }
  return findings;
}

function creditHealth(): FindingInput[] {
  const rows = db.prepare(`
    SELECT a.id AS accountId, a.name AS accountName, bs.balance, bs.date
    FROM accounts a
    JOIN balance_snapshots bs ON bs.account_id = a.id
    WHERE a.account_subtype = 'credit_card'
      AND bs.date IN (
        SELECT date FROM balance_snapshots
        WHERE account_id = a.id
        ORDER BY date DESC LIMIT 4
      )
    ORDER BY a.id, bs.date DESC
  `).all() as Array<{ accountId: string; accountName: string; balance: number; date: string }>;

  const byAccount = new Map<string, { name: string; snapshots: number[] }>();
  for (const r of rows) {
    if (!byAccount.has(r.accountId)) byAccount.set(r.accountId, { name: r.accountName, snapshots: [] });
    byAccount.get(r.accountId)!.snapshots.push(r.balance);
  }

  const findings: FindingInput[] = [];
  for (const [, { name, snapshots }] of byAccount) {
    // Need at least 4 snapshots for 3 consecutive months of comparison
    if (snapshots.length < 4) continue;
    // snapshots[0] = newest; growing debt = each newer snapshot is MORE negative (lower)
    const growingDebt = snapshots.slice(0, -1).every((s, i) => s < snapshots[i + 1]);
    if (!growingDebt) continue;
    const latest = Math.abs(snapshots[0]);
    const oldest = Math.abs(snapshots[snapshots.length - 1]);
    const delta = latest - oldest;
    findings.push({
      finding_type: 'credit_health',
      title: `Luottokorttivelka kasvaa: ${name}`,
      description: `Luottokorttisi ${name} velka on kasvanut 3 kuukautta peräkkäin. Nykyinen velka: ${fmt(latest)}.`,
      severity: 'warn',
      impact_eur: delta,
      metadata: { currentDebt: latest },
    });
  }
  return findings;
}

function spendingAnomaly(): FindingInput[] {
  const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const ninetyAgo = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    WITH recent AS (
      SELECT c.name AS cat, SUM(ABS(nt.amount)) AS spend_30d
      FROM normalized_transactions nt
      JOIN categorization_decisions cd ON cd.transaction_id = nt.id
      JOIN categories c ON c.id = cd.category_id
      WHERE nt.booking_date >= ? AND nt.amount < 0
        AND nt.id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
      GROUP BY c.name
    ),
    baseline AS (
      SELECT c.name AS cat, SUM(ABS(nt.amount)) / 3.0 AS avg_30d
      FROM normalized_transactions nt
      JOIN categorization_decisions cd ON cd.transaction_id = nt.id
      JOIN categories c ON c.id = cd.category_id
      WHERE nt.booking_date BETWEEN ? AND ?
        AND nt.amount < 0
        AND nt.id NOT IN (SELECT from_transaction_id FROM transfer_links UNION SELECT to_transaction_id FROM transfer_links)
      GROUP BY c.name
    )
    SELECT r.cat, r.spend_30d, b.avg_30d
    FROM recent r JOIN baseline b ON r.cat = b.cat
    WHERE r.spend_30d > b.avg_30d * 2 AND b.avg_30d > 20
    ORDER BY (r.spend_30d - b.avg_30d) DESC
    LIMIT 3
  `).all(thirtyAgo, ninetyAgo, thirtyAgo) as Array<{ cat: string; spend_30d: number; avg_30d: number }>;

  return rows.map((r) => ({
    finding_type: 'spending_anomaly',
    title: `${r.cat}: ${fmt(r.spend_30d)} tässä kuussa`,
    description: `Kategoriassa "${r.cat}" kului ${fmt(r.spend_30d)} viimeisen 30 päivän aikana — yli 2× normaali (${fmt(r.avg_30d)}/kk).`,
    severity: 'warn' as const,
    impact_eur: r.spend_30d - r.avg_30d,
    metadata: { category: r.cat, spend30d: r.spend_30d, avg30d: r.avg_30d },
  }));
}

// ── Engine ────────────────────────────────────────────────────────

const GENERATORS = [
  subscriptionCreep,
  newRecurring,
  oneOffImpact,
  savingsProgress,
  creditHealth,
  spendingAnomaly,
];

const SEVERITY_ORDER: Record<string, number> = { alert: 0, warn: 1, info: 2 };

export function runBriefing(importSessionId: string): string {
  const now = new Date().toISOString();
  const briefingId = crypto.randomUUID();

  const stmtInsertFinding = db.prepare(`
    INSERT INTO insight_findings
      (id, created_at, briefing_session_id, finding_type, title, description, severity, impact_eur, transaction_ids, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.prepare(
    'INSERT INTO briefing_sessions (id, created_at, import_session_id, finding_count) VALUES (?, ?, ?, 0)'
  ).run(briefingId, now, importSessionId);

  const allFindings: FindingInput[] = [];

  for (const generator of GENERATORS) {
    try {
      const results = generator();
      allFindings.push(...results);
    } catch (err) {
      console.error(`[briefing] generator ${generator.name} threw:`, err);
    }
  }

  // Sort: severity first, then impact_eur descending
  allFindings.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 2;
    const sb = SEVERITY_ORDER[b.severity] ?? 2;
    if (sa !== sb) return sa - sb;
    return (b.impact_eur ?? 0) - (a.impact_eur ?? 0);
  });

  for (const f of allFindings) {
    stmtInsertFinding.run(
      crypto.randomUUID(), now, briefingId,
      f.finding_type, f.title, f.description, f.severity,
      f.impact_eur ?? null,
      f.transaction_ids ? JSON.stringify(f.transaction_ids) : null,
      f.metadata ? JSON.stringify(f.metadata) : null
    );
  }

  db.prepare('UPDATE briefing_sessions SET finding_count = ? WHERE id = ?')
    .run(allFindings.length, briefingId);

  return briefingId;
}
