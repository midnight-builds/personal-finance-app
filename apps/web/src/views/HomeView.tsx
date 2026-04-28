import { useCallback, useMemo, useState, useEffect } from 'react';
import { API, formatDate, formatAmount, showToast } from '../utils';
import { getHouseholdSummary, importCsv, importXlsx } from '../api/client';
import type { HouseholdSummary } from '../api/client';
import CfoStatePanel from '../components/CfoStatePanel';
import ImportPrompt from '../components/ImportPrompt';
import BriefingPanel from '../components/BriefingPanel';

type Account = { id: string; name: string; balance: number; currency: string; date: string };
type Summary = {
  totalBalance: number;
  monthlyNet: number;
  monthlyNetWithTransfers: number;
  runwayMonths: number | null;
  accounts: Account[];
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
  severity: 'info' | 'warn';
  transactionIds: string[];
  recommendation?: string;
};
type Settings = { payday: number; paydayFlexDays: number; openaiConfigured: boolean };

interface HomeViewProps {
  transactions: Transaction[];
  categories: Category[];
  accounts: Account[];
  summary: Summary | null;
  monthly: MonthlyRow[];
  insights: Insight[];
  settings: Settings;
  refreshAll: () => Promise<void>;
  setToast: (v: string) => void;
}

export default function HomeView({
  transactions,
  categories,
  accounts: _accounts,
  summary,
  monthly,
  insights,
  settings,
  refreshAll,
  setToast,
}: HomeViewProps) {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState('');
  const [showTransfers, setShowTransfers] = useState(false);
  const [txFilterIds, setTxFilterIds] = useState<string[] | null>(null);
  const [aiLoading, setAiLoading] = useState<string | null>(null);
  const [householdSummary, setHouseholdSummary] = useState<HouseholdSummary | null>(null);
  const [briefingRefreshKey, setBriefingRefreshKey] = useState(0);

  const loadHousehold = useCallback(async () => {
    const data = await getHouseholdSummary();
    setHouseholdSummary(data);
  }, []);

  useEffect(() => {
    loadHousehold();
  }, [loadHousehold]);

  const heroMood = useMemo(() => {
    const net = summary?.monthlyNet ?? 0;
    if (net > 200) return 'positive';
    if (net < -200) return 'negative';
    return 'neutral';
  }, [summary]);

  const visibleTransactions = useMemo(() => {
    return transactions
      .filter((tx) => showTransfers || !tx.isTransfer)
      .filter((tx) => !txFilterIds || txFilterIds.includes(tx.id));
  }, [transactions, showTransfers, txFilterIds]);

  function csvEscape(value: unknown) {
    const s = value === null || value === undefined ? '' : String(value);
    if (/["\n\r,;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  const handleImportFile = async (selectedFile: File) => {
    setStatus('Ladataan...');
    try {
      const payload = selectedFile.name.toLowerCase().endsWith('.xlsx')
        ? await importXlsx(selectedFile)
        : await importCsv(selectedFile);
      const overlapNote = payload.overlapDetected
        ? ` (päällekkäinen importti havaittu, ${payload.alreadyImportedCount} riviä aiemmin)`
        : '';
      const skippedNote = payload.skippedCount ? `, ${payload.skippedCount} riviä ohitettiin` : '';
      const format = selectedFile.name.toLowerCase().endsWith('.xlsx') ? 'XLSX' : 'CSV';
      const msg = `Import ok (${format}): ${payload.normalizedCount} riviä${overlapNote}${skippedNote}`;
      setStatus(msg);
      showToast(setToast, msg);
      await refreshAll();
      await loadHousehold();
      setBriefingRefreshKey((k) => k + 1);
    } catch {
      setStatus('Import epäonnistui.');
      showToast(setToast, 'Import epäonnistui', 4000);
    }
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) {
      setStatus('Valitse CSV tai XLSX -tiedosto.');
      return;
    }
    await handleImportFile(file);
  };

  const changeCategory = async (id: string, categoryId: string) => {
    await fetch(`${API}/transactions/${id}/category`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId }),
    });
    await refreshAll();
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

  const downloadTransactionsCsv = () => {
    const headers = [
      'Päivä',
      'Summa',
      'Valuutta',
      'Vastapuoli',
      'Kuvaus',
      'Kategoria',
      'Tili',
      'Onko tilisiirto',
      'Tilisiirron suunta',
    ];
    const lines = [headers.join(',')];
    for (const tx of visibleTransactions) {
      lines.push(
        [
          csvEscape(tx.bookingDate ?? ''),
          csvEscape(tx.amount),
          csvEscape(tx.currency),
          csvEscape(tx.counterpartyName ?? ''),
          csvEscape(tx.description ?? ''),
          csvEscape(tx.categoryName ?? ''),
          csvEscape(tx.account?.name ?? ''),
          csvEscape(tx.isTransfer ? 'kyllä' : 'ei'),
          csvEscape(tx.transfer?.direction ?? ''),
        ].join(',')
      );
    }
    const today = new Date().toISOString().slice(0, 10);
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tapahtumat-' + today + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(setToast, 'CSV ladattu (' + visibleTransactions.length + ' riviä)');
  };

  const downloadBackup = () => {
    const a = document.createElement('a');
    a.href = API + '/backup';
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast(setToast, 'Varmuuskopion (.sqlite) lataus käynnistetty');
  };

  return (
    <>
      {householdSummary && householdSummary.dataAgeDays > 7 && (
        <ImportPrompt
          dataAgeDays={householdSummary.dataAgeDays}
          onImport={handleImportFile}
          status={status}
        />
      )}
      {householdSummary && (
        <CfoStatePanel summary={householdSummary} />
      )}
      <BriefingPanel
        setToast={setToast}
        onFilterTransactions={(ids) => setTxFilterIds(ids)}
        refreshKey={briefingRefreshKey}
      />
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
          <div className="balance-grid">
            {summary.accounts.map((a) => (
              <div className="balance" key={a.id}>
                <div className="label">{a.name}</div>
                <div className="value">{formatAmount(a.balance, a.currency)}</div>
                <div className="sub">Päivitetty {formatDate(a.date)}</div>
              </div>
            ))}
          </div>
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
                      showToast(setToast, 'Suodatettu insightin tapahtumiin');
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
            <button className="mini ghost" type="button" onClick={downloadBackup}>Lataa varmuuskopio</button>
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
}
