import { db } from './db.js';

export type ForecastItem = { counterparty: string; amount: number };
export type AnnualForecastItem = { counterparty: string; amount: number; month: number };

export type MonthlyForecast = {
  targetMonth: string;
  knownFixed: ForecastItem[];
  historicalAvg: number;
  annualItems: AnnualForecastItem[];
  projectedTotal: number;
};

export function computeMonthlyForecast(targetMonthOffset: number): MonthlyForecast {
  const targetDate = new Date();
  targetDate.setDate(1);
  targetDate.setMonth(targetDate.getMonth() + targetMonthOffset);
  const targetMonth = targetDate.getMonth() + 1; // 1–12
  const targetYear = targetDate.getFullYear();
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
  const historicalRows = db.prepare(`
    SELECT SUM(ABS(amount)) AS total
    FROM normalized_transactions
    WHERE strftime('%m', booking_date) = ?
      AND strftime('%Y', booking_date) < ?
      AND amount < 0
      AND id NOT IN (
        SELECT from_transaction_id FROM transfer_links
        UNION SELECT to_transaction_id FROM transfer_links
      )
    GROUP BY strftime('%Y', booking_date)
    ORDER BY booking_date DESC
    LIMIT 3
  `).all(monthPad, String(targetYear)) as Array<{ total: number }>;

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

export function getForecast(): MonthlyForecast[] {
  return [1, 2, 3].map((offset) => computeMonthlyForecast(offset));
}
