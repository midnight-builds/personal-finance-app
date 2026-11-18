import { db } from './db.js';
import { ledgerTotals, today, type LedgerTotal } from './ledger.js';
import { monthlyPatterns } from './patternDecisions.js';
import { chargesInMonth } from './patterns.js';
import type { PatternOrigin, PatternState } from '@finance-app/shared';

export type ForecastItem = {
  counterparty: string;
  /** The month's charges: the typical amount × `chargesInMonth`. */
  amount: number;
  /** Charges expected in the target month: 1 for a monthly pattern, 4 or 5 for a weekly one. */
  chargesInMonth?: number;
  /** Two periods passed without a charge (GLOSSARY.md, "Lapsed pattern"): listed in `lapsedRecurring` only. */
  lapsed?: boolean;
  lapsedSince?: string | null;
  patternId?: string;
  /** subscription or recurring, with the user's decision applied. */
  type?: string;
  state?: PatternState;
  confidence?: number | null;
  /** detected, or created by an actor (GLOSSARY.md, "Created pattern"). */
  origin?: PatternOrigin;
  /** Saved or invested rather than spent (GLOSSARY.md, "Savings pattern"). */
  savings?: boolean;
};
export type AnnualForecastItem = { counterparty: string; amount: number; month: number };

export type MonthlyForecast = {
  targetMonth: string;
  /** Established monthly/weekly patterns: confirmed, or confidence ≥ CONFIDENT. */
  knownFixed: ForecastItem[];
  historicalAvg: number;
  annualItems: AnnualForecastItem[];
  /** max(historicalAvg, knownFixedTotal) + annual items: uncertain patterns do not raise it. */
  projectedTotal: number;
  knownFixedTotal: number;
  /** Unconfirmed patterns below CONFIDENT: maybe fixed costs, kept apart until confirmed or proven. */
  uncertainRecurring: ForecastItem[];
  uncertainRecurringTotal: number;
  /** projectedTotal if every uncertain pattern were a fixed cost too. */
  projectedTotalWithUncertain: number;
  /** Lapsed patterns, established or not: their charges stopped, so they are counted in no total. */
  lapsedRecurring: ForecastItem[];
};

/** Spending per month (key YYYY-MM) for every month before `year`. */
function monthTotalsBefore(year: number): LedgerTotal[] {
  return ledgerTotals('month', { to: `${year - 1}-12-31` });
}

/** The forecast for the month `targetMonthOffset` months after `asOf`'s month. */
export function computeMonthlyForecast(
  targetMonthOffset: number,
  asOf: string = today(),
  months?: LedgerTotal[]
): MonthlyForecast {
  const [year, month] = asOf.split('-').map(Number);
  const targetDate = new Date(Date.UTC(year, month - 1 + targetMonthOffset, 1));
  const targetMonth = targetDate.getUTCMonth() + 1; // 1–12
  const targetYear = targetDate.getUTCFullYear();
  const targetMonthStr = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;

  // Rejected patterns are left out; the user said they are not recurring. A weekly
  // pattern counts every charge that falls in the target month.
  const item = (p: ReturnType<typeof monthlyPatterns>[number]): ForecastItem => {
    const charges = chargesInMonth(p.interval_days, p.last_seen, targetYear, targetMonth);
    return {
      counterparty: p.counterparty_name!,
      amount: Math.round((p.typical_amount ?? 0) * charges * 100) / 100,
      chargesInMonth: charges,
      patternId: p.id,
      type: p.pattern_type,
      state: p.state,
      confidence: p.confidence,
      origin: p.origin,
      savings: p.savings,
      lapsed: p.lapsed,
      lapsedSince: p.lapsed_since,
    };
  };
  const patterns = monthlyPatterns();
  const live = patterns.filter((p) => !p.lapsed);
  const knownFixed = live.filter((p) => p.established).map(item);
  const uncertainRecurring = live.filter((p) => !p.established).map(item);
  const lapsedRecurring = patterns.filter((p) => p.lapsed).map(item);

  const annualPatterns = db.prepare(`
    SELECT counterparty_name, typical_amount, typical_month FROM recurring_patterns
    WHERE pattern_type = 'annual' AND is_active = 1 AND typical_month = ?
      AND (user_confirmed IS NULL OR user_confirmed = 1)
    ORDER BY typical_amount DESC
  `).all(targetMonth) as Array<{ counterparty_name: string; typical_amount: number; typical_month: number }>;

  const annualItems: AnnualForecastItem[] = annualPatterns.map((p) => ({
    counterparty: p.counterparty_name,
    amount: p.typical_amount,
    month: p.typical_month,
  }));

  const monthPad = String(targetMonth).padStart(2, '0');
  // Spending in the same month of the three latest earlier years that have any.
  const historicalRows = (months ?? monthTotalsBefore(targetYear))
    .filter((m) => m.key!.endsWith(`-${monthPad}`) && m.key! < String(targetYear) && m.expense < 0)
    .sort((a, b) => b.key!.localeCompare(a.key!))
    .slice(0, 3)
    .map((m) => ({ total: -m.expense }));

  const historicalAvg =
    historicalRows.length > 0
      ? historicalRows.reduce((s, r) => s + r.total, 0) / historicalRows.length
      : 0;

  const sum = (items: ForecastItem[]) => Math.round(items.reduce((s, i) => s + i.amount * 100, 0)) / 100;
  const knownFixedTotal = sum(knownFixed);
  const uncertainRecurringTotal = sum(uncertainRecurring);
  const annualTotal = annualItems.reduce((s, i) => s + i.amount, 0);
  const projectedTotal = Math.max(historicalAvg, knownFixedTotal) + annualTotal;
  const projectedTotalWithUncertain = Math.max(historicalAvg, knownFixedTotal + uncertainRecurringTotal) + annualTotal;

  return {
    targetMonth: targetMonthStr,
    knownFixed,
    historicalAvg,
    annualItems,
    projectedTotal,
    knownFixedTotal,
    uncertainRecurring,
    uncertainRecurringTotal,
    projectedTotalWithUncertain,
    lapsedRecurring,
  };
}

export function getForecast(asOf: string = today()): MonthlyForecast[] {
  // Every month up to the end of this year covers all three targets' history.
  const [year] = asOf.split('-').map(Number);
  const months = monthTotalsBefore(year + 1);
  return [1, 2, 3].map((offset) => computeMonthlyForecast(offset, asOf, months));
}
