import { useEffect, useState } from 'react';
import {
  getSettings,
  getLogs,
  getBalanceAdjustments,
  getAccounts,
  getTransactions,
  getCategories,
  patchAccount,
  type Settings,
  type LogRow,
  type BalanceAdjustment,
  type Category,
} from '../api/client';
import { API, formatDate, formatAmount, showToast } from '../utils';

// Minimal Account shape used for props (compatible with both App.tsx local Account and api/client Account)
type AccountProp = { id: string; name: string; balance: number; currency: string };

// Full Account shape returned by getAccounts() (from api/client)
type Account = {
  id: string;
  name: string;
  iban: string | null;
  type: string;
  account_subtype: 'checking' | 'savings' | 'credit_card';
  owner_label: string | null;
  credit_limit: number | null;
  savings_goal: number | null;
  balance: number;
  currency: string;
  balance_date: string | null;
};

interface SettingsViewProps {
  accounts: AccountProp[];
  categories: Category[];
  refreshAll: () => Promise<void>;
  setToast: (v: string) => void;
}

export default function SettingsView({
  accounts: _accountsProp,
  categories: categoriesProp,
  refreshAll,
  setToast,
}: SettingsViewProps) {
  const [settings, setSettings] = useState<Settings>({ payday: 15, paydayFlexDays: 2, openaiConfigured: false });
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [balanceAdjustments, setBalanceAdjustments] = useState<BalanceAdjustment[]>([]);
  // accounts is the full type fetched directly by this view
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>(categoriesProp);
  const [adjAccountId, setAdjAccountId] = useState<string>('');
  const [adjDate, setAdjDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [adjAmount, setAdjAmount] = useState<string>('');
  const [adjReason, setAdjReason] = useState<string>('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [openaiKey, setOpenaiKey] = useState('');

  // Sync categories from parent
  useEffect(() => { setCategories(categoriesProp); }, [categoriesProp]);

  // Load own data on mount
  useEffect(() => {
    getSettings().then(setSettings).catch(() => {});
    getLogs().then(setLogs).catch(() => {});
    getBalanceAdjustments().then(setBalanceAdjustments).catch(() => {});
    getAccounts().then(setAccounts).catch(() => {});
  }, []);

  // Default adjAccountId to first account
  useEffect(() => {
    if (!adjAccountId && accounts.length) setAdjAccountId(accounts[0].id);
  }, [accounts, adjAccountId]);

  const loadLocalData = async () => {
    const [s, l, ba, ac, cat] = await Promise.all([
      getSettings().catch(() => null),
      getLogs().catch(() => null),
      getBalanceAdjustments().catch(() => null),
      getAccounts().catch(() => null),
      getCategories().catch(() => null),
    ]);
    if (s) setSettings(s);
    if (l) setLogs(l);
    if (ba) setBalanceAdjustments(ba);
    if (ac) setAccounts(ac);
    if (cat) setCategories(cat);
  };

  const loadAccounts = async () => {
    const ac = await getAccounts().catch(() => null);
    if (ac) setAccounts(ac);
  };

  const clearAll = async () => {
    await fetch(`${API}/debug/clear`, { method: 'POST' });
    showToast(setToast, 'Data tyhjennetty.');
    await refreshAll();
    await loadLocalData();
  };

  const clearImports = async () => {
    await fetch(`${API}/debug/clear-imports`, { method: 'POST' });
    showToast(setToast, 'Import-data tyhjennetty (kategoriat säilyivät).');
    await refreshAll();
    await loadLocalData();
  };

  const createBalanceAdjustmentApi = async () => {
    const amountNum = Number(adjAmount);
    if (!adjAccountId) { showToast(setToast, 'Valitse tili'); return; }
    if (!adjDate) { showToast(setToast, 'Päivä puuttuu'); return; }
    if (!Number.isFinite(amountNum)) { showToast(setToast, 'Summa ei ole numero'); return; }
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
    if (!res.ok) { showToast(setToast, 'Saldo-oikaisun lisäys epäonnistui', 4000); return; }
    setAdjAmount('');
    setAdjReason('');
    showToast(setToast, 'Saldo-oikaisu lisätty');
    const [ba, ac] = await Promise.all([
      getBalanceAdjustments().catch(() => null),
      getAccounts().catch(() => null),
    ]);
    if (ba) setBalanceAdjustments(ba);
    if (ac) setAccounts(ac);
    await refreshAll();
  };

  const deleteBalanceAdjustmentApi = async (id: string) => {
    const res = await fetch(`${API}/balance-adjustments/${id}`, { method: 'DELETE' });
    if (!res.ok) { showToast(setToast, 'Saldo-oikaisun poisto epäonnistui', 4000); return; }
    showToast(setToast, 'Saldo-oikaisu poistettu');
    const [ba, ac] = await Promise.all([
      getBalanceAdjustments().catch(() => null),
      getAccounts().catch(() => null),
    ]);
    if (ba) setBalanceAdjustments(ba);
    if (ac) setAccounts(ac);
    await refreshAll();
  };

  const saveSettingsHandler = async () => {
    setSavingSettings(true);
    const res = await fetch(`${API}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...settings, openaiApiKey: openaiKey }),
    });
    setSavingSettings(false);
    if (!res.ok) { showToast(setToast, 'Asetusten tallennus epäonnistui', 4000); return; }
    showToast(setToast, 'Asetukset tallennettu');
    setOpenaiKey('');
    const [s] = await Promise.all([getSettings().catch(() => null)]);
    if (s) setSettings(s);
    await refreshAll();
  };

  const createCategory = async (name: string) => {
    const res = await fetch(`${API}/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const cat = await getCategories().catch(() => null);
      if (cat) setCategories(cat);
      showToast(setToast, 'Kategoria lisätty');
    } else {
      showToast(setToast, 'Kategorian lisäys epäonnistui', 4000);
    }
    await refreshAll();
  };

  const renameCategoryApi = async (id: string, name: string) => {
    const res = await fetch(`${API}/categories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const cat = await getCategories().catch(() => null);
      if (cat) setCategories(cat);
      showToast(setToast, 'Kategoria nimettiin');
    } else {
      showToast(setToast, 'Kategorian nimeäminen epäonnistui', 4000);
    }
    await refreshAll();
  };

  const deleteCategoryApi = async (id: string) => {
    const res = await fetch(`${API}/categories/${id}`, { method: 'DELETE' });
    if (res.ok) {
      const [cat, tx] = await Promise.all([
        getCategories().catch(() => null),
        getTransactions().catch(() => null),
      ]);
      if (cat) setCategories(cat);
      showToast(setToast, 'Kategoria poistettu ja rivit siirretty');
      if (tx) await refreshAll();
    } else {
      const data = await res.json().catch(() => ({}));
      if (data.error === 'cannot_delete_misc') {
        showToast(setToast, 'Muut ja epäselvät -kategoriaa ei voi poistaa', 4000);
      } else {
        showToast(setToast, 'Kategorian poisto epäonnistui', 4000);
      }
    }
  };

  return (
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
            <button type="button" onClick={saveSettingsHandler} disabled={savingSettings}>
              Tallenna asetukset
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
                const s = await getSettings().catch(() => null);
                if (s) setSettings(s);
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
            <div className="table mini">
              <div className="row mini header">
                <span>Tili</span>
                <span>Tyyppi</span>
                <span>Omistaja</span>
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
                          await patchAccount(a.id, { name });
                          await loadAccounts();
                          await refreshAll();
                        }
                      }}
                    />
                  </span>
                  <span>
                    <select
                      value={a.account_subtype}
                      onChange={async (e) => {
                        await patchAccount(a.id, { account_subtype: e.target.value }).catch(() => {});
                        await loadAccounts();
                      }}
                    >
                      <option value="checking">Käyttö</option>
                      <option value="savings">Säästö</option>
                      <option value="credit_card">Luotto</option>
                    </select>
                  </span>
                  <span>
                    <input
                      type="text"
                      defaultValue={a.owner_label ?? ''}
                      onBlur={async (e) => {
                        const val = e.target.value;
                        await patchAccount(a.id, { owner_label: val || null }).catch(() => {});
                        await loadAccounts();
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
                    <span>{formatDate(ba.date)}</span>
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
}
