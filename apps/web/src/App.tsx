import { useCallback, useEffect, useMemo, useState } from 'react';
import './App.css';

type Account = { id: string; name: string; balance: number; currency: string; date: string };
type Summary = {
  totalBalance: number;
  monthlyNet: number;
  monthlyNetWithTransfers: number;
  runwayMonths: number | null;
  accounts: Account[];
};

type BalanceAdjustment = {
  id: string;
  created_at: string;
  account_id: string;
  date: string;
  amount: number;
  reason: string | null;
};

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

type MonthlyRow = { month: string; income: number; expense: number; net: number; direction: string };
type Category = { id: string; name: string };
type Insight = {
  id: string;
  title: string;
  description: string;
  severity: "info" | "warn";
  transactionIds: string[];
  recommendation?: string;
};
type RawRow = {
  id: string;
  createdAt: string;
  bookingDate: string | null;
  amount: number | null;
  currency: string | null;
  data: Record<string, unknown>;
  sourceBank: string;
  format: string;
};
type Settings = { payday: number; paydayFlexDays: number; openaiConfigured: boolean };
type LogRow = { id: string; created_at: string; type: string; scope?: string | null; message: string; payload?: unknown };

const API = '/api';


async function safeFetch(input: RequestInfo | URL, init?: RequestInit) {
  try {
    return await fetch(input, init);
  } catch (err: unknown) {
    throw new Error(`Network error: ${String(err)}`, { cause: err });
  }
}

function formatDate(value: string | null) {
  if (!value) return '-';
  const d = new Date(value);
  return d.toLocaleDateString('fi-FI');
}


function showToast(setToast: (v: string) => void, msg: string, ms = 2400) {
  setToast(msg);
  window.setTimeout(() => setToast(''), ms);
}

function formatAmount(amount: number | null | undefined, currency = 'EUR') {
  if (amount === null || amount === undefined) return '—';
  return `${amount.toFixed(2)} ${currency}`;
}

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState('');
  const [toast, setToast] = useState('');
  const [tab, setTab] = useState<'analytics' | 'raw' | 'settings'>('analytics');
  useEffect(() => {
    setToast('');
  }, [tab]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [showTransfers, setShowTransfers] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [txFilterIds, setTxFilterIds] = useState<string[] | null>(null);
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [rawRows, setRawRows] = useState<RawRow[]>([]);
  const [settings, setSettings] = useState<Settings>({ payday: 15, paydayFlexDays: 2, openaiConfigured: false });
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [balanceAdjustments, setBalanceAdjustments] = useState<BalanceAdjustment[]>([]);
  const [adjAccountId, setAdjAccountId] = useState<string>("");
  const [adjDate, setAdjDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [adjAmount, setAdjAmount] = useState<string>("");
  const [adjReason, setAdjReason] = useState<string>("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [openaiKey, setOpenaiKey] = useState('');
  const [aiLoading, setAiLoading] = useState<string | null>(null);


  const refreshAll = useCallback(async () => {
    await Promise.all([
      (async () => {
        const res = await safeFetch(`${API}/transactions`);
        if (!res.ok) return;
        setTransactions(await res.json());
      })(),
      (async () => {
        const res = await safeFetch(`${API}/categories`);
        if (!res.ok) return;
        setCategories(await res.json());
      })(),
      (async () => {
        const res = await safeFetch(`${API}/summary`);
        if (!res.ok) return;
        setSummary(await res.json());
      })(),
      (async () => {
        const res = await safeFetch(`${API}/insights`);
        if (!res.ok) return;
        setInsights(await res.json());
      })(),
      (async () => {
        const res = await safeFetch(`${API}/monthly`);
        if (!res.ok) return;
        setMonthly(await res.json());
      })(),
      loadRaw(),
      (async () => {
        const res = await safeFetch(`${API}/settings`);
        if (!res.ok) return;
        setSettings(await res.json());
      })(),
      loadLogs(),
      (async () => {
        const res = await safeFetch(`${API}/accounts`);
        if (!res.ok) return;
        setAccounts(await res.json());
      })(),
      (async () => {
        const res = await safeFetch(`${API}/balance-adjustments`);
        if (!res.ok) return;
        setBalanceAdjustments(await res.json());
      })(),
    ]);
  }, []);

  const heroMood = useMemo(() => {
    const net = summary?.monthlyNet ?? 0;
    if (net > 200) return 'positive';
    if (net < -200) return 'negative';
    return 'neutral';
  }, [summary]);

  const loadTransactions = async () => {
    const res = await safeFetch(`${API}/transactions`);
    if (!res.ok) return;
    setTransactions(await res.json());
  };

  const loadCategories = async () => {
    const res = await safeFetch(`${API}/categories`);
    if (!res.ok) return;
    setCategories(await res.json());
  };

  const loadSummary = async () => {
    const res = await safeFetch(`${API}/summary`);
    if (!res.ok) return;
    setSummary(await res.json());
  };

  const loadAccounts = async () => {
    const res = await safeFetch(`${API}/accounts`);
    if (!res.ok) return;
    setAccounts(await res.json());
  };

  const loadBalanceAdjustments = async () => {
    const res = await safeFetch(`${API}/balance-adjustments`);
    if (!res.ok) return;
    setBalanceAdjustments(await res.json());
  };

  const loadInsights = async () => {
    const res = await safeFetch(`${API}/insights`);
    if (!res.ok) return;
    setInsights(await res.json());
  };

  const loadMonthly = async () => {
    const res = await safeFetch(`${API}/monthly`);
    if (!res.ok) return;
    setMonthly(await res.json());
  };

  const loadRaw = async () => {
    const res = await safeFetch(`${API}/raw`);
    if (!res.ok) return;
    setRawRows(await res.json());
  };

  const loadSettings = async () => {
    const res = await safeFetch(`${API}/settings`);
    if (!res.ok) return;
    setSettings(await res.json());
  };

  const loadLogs = async () => {
    const res = await safeFetch(`${API}/log`);
    if (!res.ok) return;
    setLogs(await res.json());
  };


  useEffect(() => {
    refreshAll();
    const interval = setInterval(loadLogs, 5000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  useEffect(() => {
    if (!adjAccountId && accounts.length) setAdjAccountId(accounts[0].id);
  }, [accounts, adjAccountId]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) {
      setStatus('Valitse CSV tai XLSX -tiedosto.');
      return;
    }
    setStatus('Ladataan...');
    const form = new FormData();
    form.append('file', file);
    const endpoint = file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
    const res = await safeFetch(`${API}/imports/nordea/${endpoint}`, { method: 'POST', body: form });
    if (!res.ok) {
      setStatus('Import epäonnistui.');
      showToast(setToast, 'Import epäonnistui', 4000);
      return;
    }
    const payload = await res.json();
    const overlapNote = payload.overlapDetected
      ? ` (päällekkäinen importti havaittu, ${payload.alreadyImportedCount} riviä aiemmin)`
      : '';
    const skippedNote = payload.skippedCount ? `, ${payload.skippedCount} riviä ohitettiin` : '';
    const msg = `Import ok (${endpoint.toUpperCase()}): ${payload.normalizedCount} riviä${overlapNote}${skippedNote}`;
    setStatus(msg);
    showToast(setToast, msg);
    await refreshAll();
  };

  const clearAll = async () => {
    await safeFetch(`${API}/debug/clear`, { method: 'POST' });
    setStatus('Data tyhjennetty.');
    await refreshAll();
  };

  const clearImports = async () => {
    await safeFetch(`${API}/debug/clear-imports`, { method: 'POST' });
    setStatus('Import-data tyhjennetty (kategoriat säilyivät).');
    await refreshAll();
  };

  const createBalanceAdjustmentApi = async () => {
    const amountNum = Number(adjAmount);
    if (!adjAccountId) {
      showToast(setToast, 'Valitse tili');
      return;
    }
    if (!adjDate) {
      showToast(setToast, 'Päivä puuttuu');
      return;
    }
    if (!Number.isFinite(amountNum)) {
      showToast(setToast, 'Summa ei ole numero');
      return;
    }
    const res = await fetch(`${API}/balance-adjustments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: adjAccountId,
        date: adjDate,
        amount: amountNum,
        reason: adjReason?.trim() ? adjReason.trim() : null,
      }),
    });
    if (!res.ok) {
      showToast(setToast, 'Saldo-oikaisun lisäys epäonnistui', 4000);
      return;
    }
    setAdjAmount('');
    setAdjReason('');
    showToast(setToast, 'Saldo-oikaisu lisätty');
    await Promise.all([loadBalanceAdjustments(), loadSummary(), loadAccounts()]);
  };

  const deleteBalanceAdjustmentApi = async (id: string) => {
    const res = await fetch(`${API}/balance-adjustments/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      showToast(setToast, 'Saldo-oikaisun poisto epäonnistui', 4000);
      return;
    }
    showToast(setToast, 'Saldo-oikaisu poistettu');
    await Promise.all([loadBalanceAdjustments(), loadSummary(), loadAccounts()]);
  };

  const changeCategory = async (id: string, categoryId: string) => {
    await fetch(`${API}/transactions/${id}/category`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId }),
    });
    await Promise.all([loadTransactions(), loadInsights(), loadMonthly()]);
  };

  const aiSuggest = async (tx: Transaction) => {
    setStatus('Haetaan AI-ehdotusta...');
    setAiLoading(tx.id);
    try {
      const res = await fetch(`${API}/ai/categorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          counterparty: tx.counterpartyName,
          description: tx.description,
          amount: tx.amount,
          currency: tx.currency,
        }),
      });
      if (!res.ok) {
        showToast(setToast, 'AI-ehdotus epäonnistui', 4000);
        return;
      }
      const data = await res.json();
      if (data.mode === 'existing' && data.categoryId) {
        await changeCategory(tx.id, data.categoryId);
        showToast(setToast, `AI valitsi: ${data.categoryName}`);
        return;
      }
      if (data.mode === 'options' && data.options?.length) {
        const best = data.options[0];
        await changeCategory(tx.id, best.categoryId);
        showToast(setToast, `AI ehdotti: ${best.categoryName}`);
        return;
      }
      showToast(setToast, 'AI ei löytänyt selkeää kategoriaa');
    } finally {
      setAiLoading(null);
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    const res = await fetch(`${API}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...settings, openaiApiKey: openaiKey }),
    });
    setSavingSettings(false);
    if (!res.ok) {
      showToast(setToast, 'Asetusten tallennus epäonnistui', 4000);
      return;
    }
    showToast(setToast, 'Asetukset tallennettu');
    setOpenaiKey('');
    await Promise.all([loadMonthly(), loadTransactions(), loadSettings()]);
  };

  const createCategory = async (name: string) => {
    const res = await fetch(`${API}/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      await loadCategories();
      showToast(setToast, 'Kategoria lisätty');
    } else {
      showToast(setToast, 'Kategorian lisäys epäonnistui', 4000);
    }
  };

  const renameCategoryApi = async (id: string, name: string) => {
    const res = await fetch(`${API}/categories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      await loadCategories();
      showToast(setToast, 'Kategoria nimettiin');
    } else {
      showToast(setToast, 'Kategorian nimeäminen epäonnistui', 4000);
    }
  };

  const deleteCategoryApi = async (id: string) => {
    const res = await fetch(`${API}/categories/${id}`, { method: 'DELETE' });
    if (res.ok) {
      await loadCategories();
      await loadTransactions();
      showToast(setToast, 'Kategoria poistettu ja rivit siirretty');
    } else {
      const data = await res.json().catch(() => ({}));
      if (data.error === 'cannot_delete_misc') {
        showToast(setToast, 'Muut ja epäselvät -kategoriaa ei voi poistaa', 4000);
      } else {
        showToast(setToast, 'Kategorian poisto epäonnistui', 4000);
      }
    }
  };


  const visibleTransactions = useMemo(() => {
    return transactions
      .filter((tx) => showTransfers || !tx.isTransfer)
      .filter((tx) => !txFilterIds || txFilterIds.includes(tx.id));
  }, [transactions, showTransfers, txFilterIds]);
  function csvEscape(value: unknown) {
    const s = value === null || value === undefined ? "" : String(value);
    if (/["\n\r,;]/.test(s)) return "\"" + s.replace(/"/g, "\"\"") + "\"";
    return s;
  }

  const downloadTransactionsCsv = () => {
    const headers = [
      "Päivä",
      "Summa",
      "Valuutta",
      "Vastapuoli",
      "Kuvaus",
      "Kategoria",
      "Tili",
      "Onko tilisiirto",
      "Tilisiirron suunta",
    ];

    const lines = [headers.join(",")];
    for (const tx of visibleTransactions) {
      lines.push(
        [
          csvEscape(tx.bookingDate ?? ""),
          csvEscape(tx.amount),
          csvEscape(tx.currency),
          csvEscape(tx.counterpartyName ?? ""),
          csvEscape(tx.description ?? ""),
          csvEscape(tx.categoryName ?? ""),
          csvEscape(tx.account?.name ?? ""),
          csvEscape(tx.isTransfer ? "kyllä" : "ei"),
          csvEscape(tx.transfer?.direction ?? ""),
        ].join(",")
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tapahtumat-" + today + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(setToast, "CSV ladattu (" + visibleTransactions.length + " riviä)");
  };



  const downloadBackup = () => {
    // Let the browser handle Content-Disposition downloads (less memory vs fetching DB into JS).
    const a = document.createElement("a");
    a.href = API + "/backup";
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast(setToast, "Varmuuskopion (.sqlite) lataus käynnistetty");
  };

  const analyticsView = (
    <>
      <section className={`hero hero-${heroMood}`}>
        <div>
          <p className="eyebrow">Palkkapäivä {settings.payday}. ±{settings.paydayFlexDays} pv</p>
          <h1>Talouden co-pilotti</h1>
          <p className="lede">CSV/XLSX sisään → analyysi ulos. OpenAI-tyylinen nopeus ja selkeys.</p>
          <div className="actions">
            <label className="upload">
              <input
                type="file"
                accept=".csv,.xlsx"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? `Valittu: ${file.name}` : 'Valitse CSV/XLSX'}
            </label>
            <button type="button" onClick={onSubmit} disabled={!file}>
              Tuo & analysoi
            </button>
            <span className="muted">{status}</span>
          </div>
        </div>
        {summary && (
          <div className="hero-card">
            <div className="metric">
              <span>Netto 30 pv</span>
              <strong className={summary.monthlyNet < 0 ? 'neg' : 'pos'}>
                {formatAmount(summary.monthlyNet)}
              </strong>
            </div>
            <div className="metric">
              <span>Kokonais­saldot</span>
              <strong>{formatAmount(summary.totalBalance)}</strong>
            </div>
            <div className="metric">
              <span>Runway</span>
              <strong>{summary.runwayMonths === null ? '—' : `${summary.runwayMonths.toFixed(1)} kk`}</strong>
            </div>
          </div>
        )}
      </section>

      <section className="card glass">
        <div className="card-head">
          <div>
            <p className="eyebrow">Yhteenveto</p>
            <h2>Saldot ja suunta</h2>
          </div>
          <div className="chips">
            <span className="chip">Ilman siirtoja: {formatAmount(summary?.monthlyNet ?? 0)}</span>
            <span className="chip soft">Siirrot mukana: {formatAmount(summary?.monthlyNetWithTransfers ?? 0)}</span>
          </div>
        </div>
        {summary ? (
          <>
            <div className="balance-grid">
              {summary.accounts.map((a) => (
                <div className="balance" key={a.id}>
                  <div className="label">{a.name}</div>
                  <div className="value">{formatAmount(a.balance, a.currency)}</div>
                  <div className="sub">Päivitetty {formatDate(a.date)}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p>Ei saldoja vielä.</p>
        )}
      </section>

      <section className="card glass">
        <div className="card-head">
          <div>
            <p className="eyebrow">Palkkasykli</p>
            <h2>Kuukausikatsaus</h2>
          </div>
        </div>
        <div className="table mini">
          <div className="row mini header">
            <span>Jakso</span>
            <span>Tulot</span>
            <span>Menot</span>
            <span>Netto</span>
            <span>Suunta</span>
          </div>
          {monthly.map((m) => (
            <div className="row mini" key={m.month}>
              <span>{m.month}</span>
              <span className="pos">{formatAmount(m.income)}</span>
              <span className="neg">{formatAmount(m.expense)}</span>
              <span className={m.net < 0 ? 'neg' : 'pos'}>{formatAmount(m.net)}</span>
              <span>{m.direction === 'up' ? '↑' : m.direction === 'down' ? '↓' : '→'}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card glass">
        <div className="card-head">
          <div>
            <p className="eyebrow">Havainnot</p>
            <h2>Insights</h2>
          </div>
        </div>
        <div className="insights">
          {insights.length === 0 && <p>Ei havaintoja vielä.</p>}
          {insights.map((ins) => (
            <div className="insight" key={ins.id}>
              <div className="insight-title">
                <span className={`chip ${ins.severity === 'warn' ? 'chip-out' : 'chip-in'}`}>
                  {ins.severity === 'warn' ? 'Varoitus' : 'Info'}
                </span>
                {ins.title}
              </div>
              <div className="insight-desc">{ins.description}</div>
              {ins.recommendation && <div className="insight-rec">{ins.recommendation}</div>}
              {ins.transactionIds && ins.transactionIds.length > 0 && (
                <div className="insight-actions">
                  <button
                    className="mini"
                    type="button"
                    onClick={() => {
                      setTxFilterIds(ins.transactionIds);
                      showToast(setToast, "Suodatettu insightin tapahtumiin");
                    }}
                  >
                    Näytä tapahtumat
                  </button>
                  <button className="mini" type="button" onClick={() => setTxFilterIds(null)}>
                    Poista suodatus
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="card glass">
        <div className="card-head">
          <div>
            <p className="eyebrow">Tapahtumat</p>
            <h2>Listaus</h2>
          </div>
          <div className="tx-actions">
            <button className="mini" type="button" onClick={downloadTransactionsCsv}>Lataa CSV</button>
            <label className="toggle">
              <input type="checkbox" checked={showTransfers} onChange={(e) => setShowTransfers(e.target.checked)} />
              Näytä tilisiirrot
            </label>
          </div>
        </div>
        {txFilterIds && (
          <div className="filter-banner">
            <span>Suodatus päällä: {txFilterIds.length} tapahtumaa</span>
            <button className="mini" type="button" onClick={() => setTxFilterIds(null)}>Poista</button>
          </div>
        )}
        <div className="table">
          <div className="row header">
            <span>Päivä</span>
            <span>Summa</span>
            <span>Vastapuoli</span>
            <span>Kuvaus</span>
            <span>Kategoria</span>
            <span>Tili</span>
          </div>
          {visibleTransactions.map((tx) => (
              <div className="row" key={tx.id}>
                <span>{formatDate(tx.bookingDate)}</span>
                <span className={tx.amount < 0 ? 'neg' : 'pos'}>{formatAmount(tx.amount, tx.currency)}</span>
                <span>{tx.counterpartyName ?? '-'}</span>
                <span>{tx.description ?? '-'}</span>
                <span className="cat-cell">
                  <select value={tx.categoryId ?? ''} onChange={(e) => changeCategory(tx.id, e.target.value)}>
                    <option value="">–</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <button className="mini" type="button" onClick={() => aiSuggest(tx)} disabled={aiLoading === tx.id}>
                    {aiLoading === tx.id ? '…' : 'AI'}
                  </button>
                </span>
                <span className="account-cell">
                  {tx.account.name}
                  {tx.isTransfer && tx.transfer && (
                    <span className={`chip ${tx.transfer.direction === 'out' ? 'chip-out' : 'chip-in'}`}>
                      {tx.transfer.direction === 'out' ? 'Siirto ulos' : 'Siirto sisään'}
                    </span>
                  )}
                  {tx.groupSize && tx.groupSize > 1 && <span className="chip chip-dupe">Dupl {tx.groupSize}x</span>}
                  {tx.recurringDaily ? (
                    <span className="chip chip-recurring">Toistuva (pv)</span>
                  ) : tx.recurringWeekly ? (
                    <span className="chip chip-recurring">Toistuva (vko)</span>
                  ) : tx.recurringMonthly ? (
                    <span className="chip chip-recurring">Toistuva (kk)</span>
                  ) : null}
                </span>
              </div>
            ))}
        </div>
      </section>
    </>
  );

  const rawView = (
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
  );

  const settingsView = (
    <section className="card glass">
      <div className="card-head">
        <div>
          <p className="eyebrow">Asetukset</p>
          <h2>Palkkapäivä, debug & logi</h2>
        </div>
        <div className="chips">
          <span className="chip">Payday {settings.payday}</span>
          <span className="chip soft">Jousto ±{settings.paydayFlexDays} pv</span>
          <span className={`chip ${settings.openaiConfigured ? 'chip-in' : 'chip-out'}`}>
            OpenAI {settings.openaiConfigured ? 'asetettu' : 'puuttuu'}
          </span>
        </div>
      </div>
      <div className="settings-layout">
        <div className="settings-column">
          <div className="settings-grid">
            <label>
              Palkkapäivä (1–28)
              <input
                type="number"
                min={1}
                max={28}
                value={settings.payday}
                onChange={(e) => setSettings((prev) => ({ ...prev, payday: Number(e.target.value) }))}
              />
            </label>
            <label>
              Joustomarginaali (pv)
              <input
                type="number"
                min={0}
                max={7}
                value={settings.paydayFlexDays}
                onChange={(e) => setSettings((prev) => ({ ...prev, paydayFlexDays: Number(e.target.value) }))}
              />
            </label>
            <label>
              OpenAI API avain (ei näytetä tallennuksen jälkeen)
              <input
                type="password"
                placeholder="sk-..."
                value={openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
              />
            </label>
          </div>
          <div className="settings-actions">
            <button type="button" onClick={saveSettings} disabled={savingSettings}>
              Tallenna asetukset
            </button>
            <button type="button" className="ghost" onClick={downloadBackup}>
              Lataa varmuuskopio (.sqlite)
            </button>
            <button
              type="button"
              className="ghost"
              onClick={async () => {
                setOpenaiKey('');
                setSavingSettings(true);
                await fetch(`${API}/settings`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ...settings, openaiApiKey: '' }),
                });
                setSavingSettings(false);
                showToast(setToast, 'AI-avain tyhjennetty');
                await loadSettings();
              }}
            >
              Tyhjennä AI-avain
            </button>
            <button className="ghost" type="button" onClick={clearAll}>
              Tyhjennä kaikki (debug)
            </button>
            <button className="ghost" type="button" onClick={clearImports}>
              Tyhjennä importit (debug)
            </button>
          </div>
          <div className="logs">
            <div className="card-head">
              <div>
                <p className="eyebrow">Logi</p>
                <h3>Import + AI</h3>
              </div>
            </div>
            <div className="table mini">
              <div className="row mini header">
                <span>Aika</span>
                <span>Tyyppi</span>
                <span>Viesti</span>
                <span>Payload</span>
              </div>
              {logs.map((l) => (
                <div className="row mini" key={l.id}>
                  <span>{new Date(l.created_at).toLocaleTimeString('fi-FI')}</span>
                  <span>{l.type}</span>
                  <span>{l.message}</span>
                  <span className="json tiny">{l.payload ? JSON.stringify(l.payload) : '-'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="settings-column">
          <div className="category-editor">
            <div className="card-head inner">
              <div>
                <p className="eyebrow">Kategoriat</p>
                <h3>Lisää, nimeä, poista</h3>
              </div>
            </div>
            <div className="table mini two-col">
              <div className="row mini header">
                <span>Nimi</span>
                <span>Toiminnot</span>
              </div>
              {categories.map((c) => (
                <div className="row mini" key={c.id}>
                  <span>
                    <input
                      type="text"
                      defaultValue={c.name}
                      onBlur={(e) => {
                        const val = e.target.value;
                        if (val !== c.name) renameCategoryApi(c.id, val);
                      }}
                      disabled={c.name === 'Muut ja epäselvät'}
                    />
                    {c.name === 'Muut ja epäselvät' && <small className="muted">Suojattu</small>}
                  </span>
                  <span className="actions-row">
                    <button
                      className="ghost mini"
                      type="button"
                      onClick={() => deleteCategoryApi(c.id)}
                      disabled={c.name === 'Muut ja epäselvät'}
                    >
                      Poista
                    </button>
                  </span>
                </div>
              ))}
            </div>
            <div className="settings-actions">
              <input
                type="text"
                placeholder="Uusi kategoria"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    createCategory((e.target as HTMLInputElement).value);
                    (e.target as HTMLInputElement).value = '';
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  const el = document.querySelector<HTMLInputElement>('.category-editor input[type=text]');
                  const name = el?.value ?? '';
                  if (name.trim()) {
                    createCategory(name);
                    if (el) el.value = '';
                  }
                }}
              >
                Lisää kategoria
              </button>
            </div>
          </div>
          <div className="account-editor">
            <div className="card-head inner">
              <div>
                <p className="eyebrow">Tilit</p>
                <h3>Nimeä tilit uudelleen</h3>
              </div>
            </div>
            <div className="table mini two-col">
              <div className="row mini header">
                <span>Tili</span>
                <span>Saldo</span>
              </div>
              {accounts.map((a) => (
                <div className="row mini" key={a.id}>
                  <span>
                    <input
                      type="text"
                      defaultValue={a.name}
                      onBlur={async (e) => {
                        const name = e.target.value;
                        if (name !== a.name) {
                          await fetch(`${API}/accounts/${a.id}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name }),
                          });
                          await Promise.all([loadAccounts(), loadSummary(), loadTransactions()]);
                        }
                      }}
                    />
                  </span>
                  <span>{a.balance != null ? formatAmount(a.balance, a.currency ?? 'EUR') : '—'}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="balance-adjustments">
            <div className="card-head inner">
              <div>
                <p className="eyebrow">Saldo</p>
                <h3>Saldo-oikaisut</h3>
              </div>
            </div>

            <div className="settings-grid">
              <label>
                Tili
                <select value={adjAccountId} onChange={(e) => setAdjAccountId(e.target.value)}>
                  <option value="">–</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Päivä
                <input type="date" value={adjDate} onChange={(e) => setAdjDate(e.target.value)} />
              </label>
              <label>
                Summa ({accounts.find((a) => a.id === adjAccountId)?.currency ?? 'EUR'})
                <input type="number" step="0.01" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} />
              </label>
              <label>
                Syy (optional)
                <input type="text" value={adjReason} onChange={(e) => setAdjReason(e.target.value)} />
              </label>
            </div>
            <div className="settings-actions">
              <button type="button" onClick={createBalanceAdjustmentApi}>Lisää saldo-oikaisu</button>
            </div>

            <div className="table mini">
              <div className="row mini header">
                <span>Päivä</span>
                <span>Tili</span>
                <span>Summa</span>
                <span>Syy</span>
                <span></span>
              </div>
              {balanceAdjustments.length === 0 && (
                <div className="row mini">
                  <span className="muted">Ei oikaisuja.</span>
                  <span></span><span></span><span></span><span></span>
                </div>
              )}
              {balanceAdjustments.map((ba) => {
                const acc = accounts.find((a) => a.id === ba.account_id);
                const cur = acc?.currency ?? 'EUR';
                return (
                  <div className="row mini" key={ba.id}>
                    <span>{ba.date}</span>
                    <span>{acc?.name ?? ba.account_id}</span>
                    <span className={ba.amount < 0 ? 'neg' : 'pos'}>{formatAmount(ba.amount, cur)}</span>
                    <span>{ba.reason ?? '–'}</span>
                    <span className="actions-row">
                      <button className="ghost mini" type="button" onClick={() => deleteBalanceAdjustmentApi(ba.id)}>
                        Poista
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );

  return (
    <div className="shell">
      <nav className="topbar">
        <div className="brand">Finance App</div>
        <div className="tabs">
          <button className={tab === 'analytics' ? 'tab active' : 'tab'} onClick={() => setTab('analytics')}>
            Analytiikka
          </button>
          <button className={tab === 'raw' ? 'tab active' : 'tab'} onClick={() => setTab('raw')}>
            Raaka data
          </button>
          <button className={tab === 'settings' ? 'tab active' : 'tab'} onClick={() => setTab('settings')}>
            Asetukset
          </button>
        </div>
      </nav>

      <main className="content">
        {tab === 'analytics' && analyticsView}
        {tab === 'raw' && rawView}
        {tab === 'settings' && settingsView}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export default App;
