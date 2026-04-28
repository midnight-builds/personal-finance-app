import { useEffect, useState } from 'react';
import { getRawTransactions, getMonthlyOverview, getSubscriptions, getAccounts, type MonthlyRow, type RawRow, type RecurringPattern } from '../api/client';
import { formatDate, formatAmount } from '../utils';
import BalanceChart from '../charts/BalanceChart';
import MonthlyNetChart from '../charts/MonthlyNetChart';
import SubscriptionChart from '../charts/SubscriptionChart';

interface ExplorerViewProps {
  setToast: (v: string) => void;
}

export default function ExplorerView({ setToast: _setToast }: ExplorerViewProps) {
  const [rawRows, setRawRows] = useState<RawRow[]>([]);
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [subscriptions, setSubscriptions] = useState<RecurringPattern[]>([]);
  const [balanceChartData, setBalanceChartData] = useState<Array<{ date: string; [key: string]: string | number }>>([]);
  const [accountNames, setAccountNames] = useState<string[]>([]);

  useEffect(() => {
    getRawTransactions()
      .then(setRawRows)
      .catch(() => {/* silently ignore on error */});

    getMonthlyOverview()
      .then(setMonthly)
      .catch(() => {});

    getSubscriptions()
      .then(setSubscriptions)
      .catch(() => {});

    getAccounts().then(accts => {
      const names = accts.filter(a => a.balance != null).map(a => a.name);
      const byDate = new Map<string, Record<string, string | number>>();
      for (const a of accts) {
        if (a.balance == null || !a.balance_date) continue;
        const dateKey = a.balance_date.slice(0, 10);
        const existing = byDate.get(dateKey) ?? { date: dateKey };
        existing[a.name] = a.balance;
        byDate.set(dateKey, existing);
      }
      setBalanceChartData((Array.from(byDate.values()) as Array<{ date: string; [key: string]: string | number }>).sort((a, b) => a.date.localeCompare(b.date)));
      setAccountNames(names);
    }).catch(() => {});
  }, []);

  return (
    <>
      <section className="card glass">
        <div className="card-head"><div><p className="eyebrow">Saldot</p><h2>Tilihistoria</h2></div></div>
        <BalanceChart data={balanceChartData} accountNames={accountNames} />
      </section>

      <section className="card glass">
        <div className="card-head"><div><p className="eyebrow">Kuukaudet</p><h2>Tulot vs. menot</h2></div></div>
        <MonthlyNetChart data={monthly} />
      </section>

      <section className="card glass">
        <div className="card-head"><div><p className="eyebrow">Tilaukset</p><h2>Kuukausiveloitukset</h2></div></div>
        <SubscriptionChart data={subscriptions} />
      </section>

      <section className="card glass">
        <div className="card-head">
          <div>
            <p className="eyebrow">Raaka data</p>
            <h2>CSV/XLSX rivit</h2>
          </div>
        </div>
        <div className="table">
          <div className="row header">
            <span>Päivä</span>
            <span>Summa</span>
            <span>Lähde</span>
            <span>Data</span>
          </div>
          {rawRows.map((r) => (
            <div className="row" key={r.id}>
              <span>{formatDate(r.bookingDate)}</span>
              <span>{r.amount !== null ? formatAmount(r.amount, r.currency ?? 'EUR') : '—'}</span>
              <span>{r.sourceBank} ({r.format})</span>
              <span className="json">{JSON.stringify(r.data)}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
