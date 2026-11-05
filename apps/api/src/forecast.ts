import { db } from './db.js';
import { ledgerTotals, today, type LedgerTotal } from './ledger.js';

export type ForecastItem = { counterparty: string; amount: number };
export type AnnualForecastItem = { counterparty: string; amount: number; month: number };

export type MonthlyForecast = {
  targetMonth: string;
  knownFixed: ForecastItem[];
  historicalAvg: number;
  annualItems: AnnualForecastItem[];
  projectedTotal: number;
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

  const monthlyPatterns = db.prepare(`
    SELECT counterparty_name, typical_amount FROM recurring_patterns
    WHERE pattern_type IN ('subscription', 'recurring') AND is_active = 1
    ORDER BY typical_amount DESC
  `).all() as Array<{ counterparty_name: string; typical_amount: number }>;

  const knownFixed: ForecastItem[] = monthlyPatterns.map((p) => ({
    counterparty: p.counterparty_name,
    amount: p.typical_amount,
  }));

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

  const knownFixedTotal = knownFixed.reduce((s, i) => s + i.amount, 0);
  const annualTotal = annualItems.reduce((s, i) => s + i.amount, 0);
  const variableBase = Math.max(historicalAvg, knownFixedTotal);
  const projectedTotal = variableBase + annualTotal;

  return { targetMonth: targetMonthStr, knownFixed, historicalAvg, annualItems, projectedTotal };
}

export function getForecast(asOf: string = today()): MonthlyForecast[] {
  // Every month up to the end of this year covers all three targets' history.
  const [year] = asOf.split('-').map(Number);
  const months = monthTotalsBefore(year + 1);
  return [1, 2, 3].map((offset) => computeMonthlyForecast(offset, asOf, months));
}
