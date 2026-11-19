import { getSettings } from './settings.js';
import { daysBefore, ledgerEntries, today } from './ledger.js';

const day = (year: number, month: number, date: number) =>
  new Date(Date.UTC(year, month, date)).toISOString().slice(0, 10);

/**
 * Income, expense and net for the last `limit` pay periods, oldest first.
 * A period is labelled by its month and runs from the day after the payday
 * window opens (payday − flex days) up to and including the same day of the
 * next month, so the salary that lands early still counts in its own month.
 * `from` and `to` are the period's inclusive booking-date range: searching
 * transactions over the same range (default scope) gives the same totals.
 * `saving` and `loanRepayment` are the part of the net that went to (negative)
 * or came from manual savings and loan accounts (GLOSSARY.md, "Transfer to a
 * manual account"): included in income, expense and net, shown apart.
 */
export function getMonthlyOverview(limit = 6, asOf: string = today()) {
  const { payday, paydayFlexDays } = getSettings();
  const offset = payday - 1 - paydayFlexDays;
  const [year, month] = asOf.split('-').map(Number);

  const periods = [];
  for (let n = Math.min(limit, 10) - 1; n >= 0; n--) {
    const m = month - 1 - n;
    const from = daysBefore(day(year, m, 1 + offset), -1);
    const to = day(year, m + 1, 1 + offset);
    const entries = ledgerEntries({ from, to });
    let income = 0;
    let expense = 0;
    let saving = 0;
    let loanRepayment = 0;
    for (const e of entries) {
      if (e.amount > 0) income += e.amount * 100;
      else expense += e.amount * 100;
      if (e.ownTransfer?.kind === 'saving') saving += e.amount * 100;
      if (e.ownTransfer?.kind === 'loan_repayment') loanRepayment += e.amount * 100;
    }
    income = Math.round(income) / 100;
    expense = Math.round(expense) / 100;
    const net = Math.round((income + expense) * 100) / 100;
    periods.push({
      month: day(year, m, 1).slice(0, 7),
      from,
      to,
      income,
      expense,
      net,
      saving: Math.round(saving) / 100,
      loanRepayment: Math.round(loanRepayment) / 100,
      direction: net > 0 ? 'up' : net < 0 ? 'down' : 'flat',
    });
  }
  return periods;
}
