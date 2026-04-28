import { useEffect, useState } from 'react';
import {
  getRawTransactions,
  getMonthlyOverview,
  getSubscriptions,
  getAccounts,
  getBalanceSnapshots,
  type MonthlyRow,
  type RawRow,
  type RecurringPattern,
} from '../api/client';
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
  const [balanceChartData, setBalanceChartData] = useState<
    Array<{ date: string; [key: string]: string | number }>
  >([]);
  const [accountNames, setAccountNames] = useState<string[]>([]);

  useEffect(() => {
    getRawTransactions()
      .then(setRawRows)
      .catch(() => {});

    getMonthlyOverview()
      .then(setMonthly)
      .catch(() => {});

    getSubscriptions()
      .then(setSubscriptions)
      .catch(() => {});

    // Load per-account balance history and build unified date-keyed chart data
    getAccounts().then(async (accts) => {
      const names = accts.map((a) => a.name);

      // Load snapshots for all accounts in parallel; ignore per-account errors
      const snapshotsByAccount = await Promise.all(
        accts.map((a) => getBalanceSnapshots(a.id).catch(() => []))
      );

      // Merge into a map keyed by date; each account contributes its own column
      const byDate = new Map<string, Record<string, string | number>>();
      accts.forEach((a, i) => {
        for (const snap of snapshotsByAccount[i]) {
          const existing = byDate.get(snap.date) ?? { date: snap.date };
          existing[a.name] = snap.balance;
          byDate.set(snap.date, existing);
        }
      });

      const chartData = (
        Array.from(byDate.values()) as Array<{ date: string; [key: string]: string | number }>
      ).sort((a, b) => a.date.localeCompare(b.date));

      setAccountNames(names);
      setBalanceChartData(chartData);
    }).catch(() => {});
  }, []);

  return (
    <>
      <section className="card glass">
        <div className="card-head">
          <div>
            <p className="eyebrow">Saldot</p>
            <h2>Tilihistoria</h2>
          </div>
        </div>
        <BalanceChart data={balanceChartData} accountNames={accountNames} />
      </section>

      <section className="card glass">
        <div className="card-head">
          <div>
            <p className="eyebrow">Kuukaudet</p>
            <h2>Tulot vs. menot</h2>
          </div>
        </div>
        <MonthlyNetChart data={monthly} />
      </section>

      <section className="card glass">
        <div className="card-head">
          <div>
            <p className="eyebrow">Tilaukset</p>
            <h2>Kuukausiveloitukset</h2>
          </div>
        </div>
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
              <span>{formatDate(r.bookingDate ?? '')}</span>
              <span>{r.amount != null ? formatAmount(r.amount) : '—'}</span>
              <span>{r.sourceBank}</span>
              <span>{r.format}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
