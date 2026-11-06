import crypto from 'crypto';
import { db } from './db.js';
import { getOpenAIApiKey } from './settings.js';
import { enhanceBriefingDescriptions } from './ai/briefingEnhancer.js';
import { listPendingConfirmations } from './patternConfirmations.js';
import { computeMonthlyForecast } from './forecast.js';
import { accountBalances, daysBefore, ledgerEntries, ledgerTotals, today } from './ledger.js';

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

/** Counterparties of active recurring patterns: their charges are not one-offs. */
function recurringCounterparties(): Set<string> {
  const rows = db.prepare(
    'SELECT counterparty_name FROM recurring_patterns WHERE is_active = 1 AND counterparty_name IS NOT NULL'
  ).all() as Array<{ counterparty_name: string }>;
  return new Set(rows.map((r) => r.counterparty_name));
}

function oneOffImpact(asOf: string): FindingInput[] {
  const recurring = recurringCounterparties();
  const oneOffExpenses = (from: string, to: string) =>
    ledgerEntries({ from, to }).filter(
      (e) => e.amount < 0 && (e.counterparty === null || !recurring.has(e.counterparty))
    );

  // Baseline: average single-transaction amount for non-transfer, non-recurring txs in the 60 days before the last 30
  const prior = oneOffExpenses(daysBefore(asOf, 90), daysBefore(asOf, 31));
  const baseline = prior.length > 0 ? prior.reduce((s, e) => s + Math.abs(e.amount), 0) / prior.length : 100;
  const threshold = baseline * 2;

  const largeOnes = oneOffExpenses(daysBefore(asOf, 30), asOf)
    .filter((e) => Math.abs(e.amount) > threshold)
    .sort((a, b) => a.amount - b.amount)
    .slice(0, 3);

  // The description quotes the booking date as stored.
  const bookingDate = db.prepare('SELECT booking_date FROM normalized_transactions WHERE id = ?');

  return largeOnes.map((tx) => {
    const { booking_date } = bookingDate.get(tx.id) as { booking_date: string };
    return {
      finding_type: 'one_off_impact',
      title: `Kertaluonteinen hankinta: ${tx.counterparty ?? 'Tuntematon'} ${fmt(tx.amount)}`,
      description: `Ostit ${tx.counterparty ?? 'tuntematon kauppias'} ${fmt(tx.amount)} (${booking_date}). Tämä on yli 2× tyypillinen yksittäinen kulusi.`,
      severity: (Math.abs(tx.amount) > threshold * 2 ? 'warn' : 'info') as 'warn' | 'info',
      impact_eur: Math.abs(tx.amount),
      transaction_ids: [tx.id],
    };
  });
}

/** Accounts of a subtype and their balance on any day; balances are looked up once per day. */
function balancesOf(subtype: string) {
  const accounts = db
    .prepare('SELECT id, name FROM accounts WHERE account_subtype = ? ORDER BY created_at ASC, id ASC')
    .all(subtype) as Array<{ id: string; name: string }>;
  const byDay = new Map<string, Map<string, { balance: number | null; date: string | null }>>();
  const on = (accountId: string, day: string) => {
    if (!byDay.has(day)) byDay.set(day, new Map(accountBalances(day).map((b) => [b.accountId, b])));
    return byDay.get(day)!.get(accountId) ?? { balance: null, date: null };
  };
  return { accounts, on };
}

/** Last day of the month `k` months before `asOf`'s month (k = 1: last month). */
function monthEnd(asOf: string, k: number): string {
  const [y, m] = asOf.split('-').map(Number);
  return new Date(Date.UTC(y, m - k, 0)).toISOString().slice(0, 10);
}

function savingsProgress(asOf: string): FindingInput[] {
  const findings: FindingInput[] = [];
  const { accounts, on } = balancesOf('savings');
  for (const { id, name } of accounts) {
    // The 30 days up to the latest snapshot: imports may lag behind today.
    const now = on(id, asOf);
    if (now.balance === null || now.date === null) continue;
    const before = on(id, daysBefore(now.date, 30));
    if (before.balance === null) continue;
    const latest = now.balance;
    const delta = Math.round((latest - before.balance) * 100) / 100;
    const trend = delta > 0 ? 'kasvanut' : delta < 0 ? 'laskenut' : 'pysynyt samana';
    const severity: 'info' | 'warn' = delta < 0 ? 'warn' : 'info';
    findings.push({
      finding_type: 'savings_progress',
      title: `Säästötili ${name}: ${delta >= 0 ? '+' : ''}${fmt(delta)}`,
      description: `Säästötilisi ${name} saldo on ${trend} ${fmt(Math.abs(delta))} viimeisen 30 päivän aikana. Nykyinen saldo: ${fmt(latest)}.`,
      severity,
      impact_eur: Math.abs(delta),
      metadata: { currentBalance: latest, delta },
    });
  }
  return findings;
}

function creditHealth(asOf: string): FindingInput[] {
  const findings: FindingInput[] = [];
  const { accounts, on } = balancesOf('credit_card');
  for (const { id, name } of accounts) {
    // Month-end balances of the last four months, oldest first. Debt is
    // negative, so growing debt means each month ends lower than the last.
    const ends = [4, 3, 2, 1].map((k) => on(id, monthEnd(asOf, k)).balance);
    if (ends.some((b) => b === null)) continue;
    const balances = ends as number[];
    if (!balances.slice(1).every((b, i) => b < balances[i])) continue;
    const latest = Math.abs(on(id, asOf).balance ?? balances[3]);
    const delta = Math.round((Math.abs(balances[3]) - Math.abs(balances[0])) * 100) / 100;
    findings.push({
      finding_type: 'credit_health',
      title: `Luottokorttivelka kasvaa: ${name}`,
      description: `Luottokorttisi ${name} velka on kasvanut 3 kuukautta peräkkäin (kuukauden lopun saldot). Nykyinen velka: ${fmt(latest)}.`,
      severity: 'warn',
      impact_eur: delta,
      metadata: { currentDebt: latest },
    });
  }
  return findings;
}

/** Spend (positive, cents) per category name of categorized purchases from `from` to `to`. */
function spendByCategory(from: string, to: string): Map<string, number> {
  const spend = new Map<string, number>();
  for (const e of ledgerEntries({ from, to })) {
    if (e.amount >= 0 || e.categoryName === null) continue;
    spend.set(e.categoryName, (spend.get(e.categoryName) ?? 0) + Math.abs(e.amount) * 100);
  }
  return new Map([...spend].map(([cat, c]) => [cat, Math.round(c) / 100]));
}

/** Calendar days from `from` to `to`, both included. */
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;

/**
 * A category's last 30 days against its normal 30 days. "Normal" is the
 * average over the history before those 30 days, at most 24 months, scaled
 * by the time the data actually covers; under 30 days of history is too
 * little to call anything unusual.
 */
function spendingAnomaly(asOf: string): FindingInput[] {
  const baselineEnd = daysBefore(asOf, 31);
  const [y, m, d] = asOf.split('-').map(Number);
  const earliest = new Date(Date.UTC(y - 2, m - 1, d)).toISOString().slice(0, 10);
  const first = ledgerEntries({ to: baselineEnd })[0]?.date;
  if (!first) return [];
  const baselineStart = first > earliest ? first : earliest;
  const coveredDays = daysBetween(baselineStart, baselineEnd);
  if (coveredDays < 30) return [];

  const recent = spendByCategory(daysBefore(asOf, 30), asOf);
  const baseline = spendByCategory(baselineStart, baselineEnd);

  const rows = [...recent]
    .filter(([cat]) => baseline.has(cat))
    .map(([cat, spend_30d]) => ({
      cat,
      spend_30d,
      avg_30d: Math.round((baseline.get(cat)! / coveredDays) * 30 * 100) / 100,
    }))
    .filter((r) => r.spend_30d > r.avg_30d * 2 && r.avg_30d > 20)
    .sort((a, b) => (b.spend_30d - b.avg_30d) - (a.spend_30d - a.avg_30d))
    .slice(0, 3);

  return rows.map((r) => ({
    finding_type: 'spending_anomaly',
    title: `${r.cat}: ${fmt(r.spend_30d)} tässä kuussa`,
    description: `Kategoriassa "${r.cat}" kului ${fmt(r.spend_30d)} viimeisen 30 päivän aikana — yli 2× normaali (${fmt(r.avg_30d)}/kk).`,
    severity: 'warn' as const,
    impact_eur: Math.round((r.spend_30d - r.avg_30d) * 100) / 100,
    metadata: { category: r.cat, spend30d: r.spend_30d, avg30d: r.avg_30d },
  }));
}

function pendingConfirmations(): FindingInput[] {
  const MONTHS = ['tammikuu', 'helmikuu', 'maaliskuu', 'huhtikuu', 'toukokuu', 'kesäkuu',
                  'heinäkuu', 'elokuu', 'syyskuu', 'lokakuu', 'marraskuu', 'joulukuu'];

  return listPendingConfirmations().slice(0, 3).map((c) => ({
    finding_type: 'pattern_confirmation',
    title: `Tuleeko ${c.counterparty_name} ensi vuonna uudelleen?`,
    description: `${fmt(c.typical_amount)} veloitus ${MONTHS[c.typical_month - 1]}ssa — onko tämä vuosittainen maksu?`,
    severity: 'info' as const,
    impact_eur: c.typical_amount,
    metadata: { confirmationId: c.id, counterparty: c.counterparty_name, month: c.typical_month },
  }));
}

function monthlyForecast(asOf: string): FindingInput[] {
  const MONTHS = ['tammikuu', 'helmikuu', 'maaliskuu', 'huhtikuu', 'toukokuu', 'kesäkuu',
                  'heinäkuu', 'elokuu', 'syyskuu', 'lokakuu', 'marraskuu', 'joulukuu'];

  const forecast = computeMonthlyForecast(1, asOf);
  if (forecast.projectedTotal === 0) return [];

  // Average spend of the first three calendar months touched by the last 90 days.
  const spendByMonth = ledgerTotals('month', { from: daysBefore(asOf, 90), to: asOf })
    .map((m) => -m.expense)
    .filter((spend) => spend > 0)
    .slice(0, 3);
  const recentAvg = spendByMonth.length > 0 ? spendByMonth.reduce((s, x) => s + x, 0) / spendByMonth.length : 0;
  const isExpensive = recentAvg > 0 && forecast.projectedTotal >= recentAvg * 1.3;

  const [year, month] = forecast.targetMonth.split('-');
  const monthName = MONTHS[parseInt(month, 10) - 1];

  const annualNote =
    forecast.annualItems.length > 0
      ? ` + vuosikuluja: ${forecast.annualItems.map((i) => `${i.counterparty} ${fmt(i.amount)}`).join(', ')}`
      : '';

  return [{
    finding_type: 'monthly_forecast',
    title: `Ennuste ${monthName}lle ${year}: ${fmt(forecast.projectedTotal)}`,
    description: `Tiedossa: ${forecast.knownFixed.length} kuukausimaksua (${fmt(forecast.knownFixed.reduce((s, i) => s + i.amount, 0))})${annualNote}. Historiakeskiarvo ${monthName}lle: ${forecast.historicalAvg > 0 ? fmt(forecast.historicalAvg) : 'ei dataa'}.`,
    severity: isExpensive ? 'warn' : 'info',
    impact_eur: forecast.projectedTotal,
    metadata: {
      targetMonth: forecast.targetMonth,
      projectedTotal: forecast.projectedTotal,
      knownFixedCount: forecast.knownFixed.length,
      annualItemsCount: forecast.annualItems.length,
    },
  }];
}

// ── Engine ────────────────────────────────────────────────────────

const GENERATORS: Array<(asOf: string) => FindingInput[]> = [
  subscriptionCreep,
  newRecurring,
  oneOffImpact,
  savingsProgress,
  creditHealth,
  spendingAnomaly,
  pendingConfirmations,
  monthlyForecast,
];

const SEVERITY_ORDER: Record<string, number> = { alert: 0, warn: 1, info: 2 };

export async function runBriefing(importSessionId: string, asOf: string = today()): Promise<string> {
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
      const results = generator(asOf);
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

  const apiKey = getOpenAIApiKey();
  if (apiKey && allFindings.length > 0) {
    try {
      const enhanced = await enhanceBriefingDescriptions(allFindings, apiKey);
      enhanced.forEach((desc, i) => { allFindings[i].description = desc; });
    } catch (err) {
      console.error('[briefing] AI enhancement failed, using original descriptions:', err);
    }
  }

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
