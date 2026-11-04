import { useCallback, useEffect, useState } from 'react';
import './App.css';
import HomeView from './views/HomeView';
import ExplorerView from './views/ExplorerView';
import SettingsView from './views/SettingsView';
import ProposalsView from './views/ProposalsView';
import { safeFetch, API } from './utils';
import type { Category, Summary, MonthlyRow, Insight, Settings } from './api/client';

// Local Account type matches the /summary response shape (uses 'date' not 'balance_date')
type Account = { id: string; name: string; balance: number; currency: string; date: string };

type Transaction = {
  id: string;
  bookingDate: string | null;
  amount: number;
  currency: string;
  counterpartyName: string | null;
  description: string | null;
  account: { id: string; name: string; iban: string | null };
  categoryId?: string | null;
  categoryName?: string | null;
  groupSize?: number | null;
  transfer?: { direction: 'in' | 'out'; otherId: string | null } | null;
  isTransfer?: boolean;
  recurringDaily?: boolean;
  recurringWeekly?: boolean;
  recurringMonthly?: boolean;
};

type Tab = 'analytics' | 'raw' | 'proposals' | 'settings';

function App() {
  const [tab, setTab] = useState<Tab>('analytics');
  const [toast, setToast] = useState('');

  // Shared state — needed by multiple views
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [settings, setSettings] = useState<Settings>({ payday: 15, paydayFlexDays: 2, openaiConfigured: false });

  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    setToast('');
  }, []);

  const loadLogs = useCallback(async () => {
    // Logs are polled; SettingsView loads its own copy on mount.
    // This polling just re-fetches in the background (SettingsView picks up via its own state).
    await safeFetch(`${API}/log`);
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      (async () => {
        const res = await safeFetch(`${API}/transactions`);
        if (res.ok) setTransactions(await res.json());
      })(),
      (async () => {
        const res = await safeFetch(`${API}/categories`);
        if (res.ok) setCategories(await res.json());
      })(),
      (async () => {
        const res = await safeFetch(`${API}/summary`);
        if (res.ok) setSummary(await res.json());
      })(),
      (async () => {
        const res = await safeFetch(`${API}/insights`);
        if (res.ok) setInsights(await res.json());
      })(),
      (async () => {
        const res = await safeFetch(`${API}/monthly`);
        if (res.ok) setMonthly(await res.json());
      })(),
      (async () => {
        const res = await safeFetch(`${API}/settings`);
        if (res.ok) setSettings(await res.json());
      })(),
      (async () => {
        const res = await safeFetch(`${API}/accounts`);
        if (res.ok) setAccounts(await res.json());
      })(),
    ]);
  }, []);

  useEffect(() => {
    refreshAll();
    const interval = setInterval(loadLogs, 5000);
    return () => clearInterval(interval);
  }, [refreshAll, loadLogs]);

  return (
    <div className="shell">
      <nav className="topbar">
        <div className="brand">Finance App</div>
        <div className="tabs">
          <button className={tab === 'analytics' ? 'tab active' : 'tab'} onClick={() => selectTab('analytics')}>
            Analytiikka
          </button>
          <button className={tab === 'raw' ? 'tab active' : 'tab'} onClick={() => selectTab('raw')}>
            Raaka data
          </button>
          <button className={tab === 'proposals' ? 'tab active' : 'tab'} onClick={() => selectTab('proposals')}>
            Ehdotukset
          </button>
          <button className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => selectTab('settings')}>
            Asetukset
          </button>
        </div>
      </nav>

      <main className="content">
        {tab === 'analytics' && (
          <HomeView
            transactions={transactions}
            categories={categories}
            accounts={accounts}
            summary={summary}
            monthly={monthly}
            insights={insights}
            settings={settings}
            refreshAll={refreshAll}
            setToast={setToast}
          />
        )}
        {tab === 'raw' && <ExplorerView setToast={setToast} />}
        {tab === 'proposals' && <ProposalsView setToast={setToast} />}
        {tab === 'settings' && (
          <SettingsView
            accounts={accounts}
            categories={categories}
            refreshAll={refreshAll}
            setToast={setToast}
          />
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export default App;
