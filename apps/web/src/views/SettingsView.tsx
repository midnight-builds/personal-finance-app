import { useEffect, useState } from 'react';
import { isLiabilityType } from '@finance-app/shared';
import {
  getSettings,
  getLogs,
  getBalanceAdjustments,
  getAccounts,
  getTransactions,
  getCategories,
  type Account,
  type Settings,
  type LogRow,
  type BalanceAdjustment,
  type Category,
} from '../api/client';
import { API, formatDate, formatAmount, showToast } from '../utils';
import AccountSettings from '../components/AccountSettings';

// Minimal Account shape used for props (compatible with both App.tsx local Account and api/client Account)
type AccountProp = { id: string; name: string; balance: number; currency: string };


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

  // Adjustments correct the bank's balance, so they are for imported accounts; a manual account's
  // balance is only its observations (account settings, BalanceObservations.tsx).
  const balanceAccounts = accounts.filter((a) => a.tracking !== 'manual');
  // Default adjAccountId to first account
  useEffect(() => {
    if (!adjAccountId && balanceAccounts.length) setAdjAccountId(balanceAccounts[0].id);
  }, [balanceAccounts, adjAccountId]);

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

  const adjAccount = accounts.find((a) => a.id === adjAccountId);
  // An account without any balance gets its first one as a balance observation; an adjustment only
  // corrects an existing balance.
  const settingFirstBalance = adjAccount != null && adjAccount.balance == null;
  // Adjustments saved before the account had a balance start counting once it has one.
  const waitingAdjustments = balanceAdjustments.filter((ba) => ba.account_id === adjAccountId && !ba.applied);

  const balanceErrorText: Record<string, string> = {
    balance_snapshot_missing: 'Tilillä ei ole saldoa – aseta ensin sen saldo',
    snapshot_exists: 'Tälle päivälle on jo saldo – korjaa se saldo-oikaisulla',
    date_in_future: 'Päivä ei voi olla tulevaisuudessa',
    observation_exists: 'Tälle päivälle on jo saldohavainto – muokkaa sitä tilin Saldot-kohdassa',
    debt_negative: 'Kirjaa velka positiivisena summana',
  };

  const createBalanceAdjustmentApi = async () => {
    const amountNum = Number(adjAmount);
    if (!adjAccountId) { showToast(setToast, 'Valitse tili'); return; }
    if (!adjDate) { showToast(setToast, 'Päivä puuttuu'); return; }
    if (adjAmount.trim() === '' || !Number.isFinite(amountNum)) { showToast(setToast, 'Summa ei ole numero'); return; }
    const res = settingFirstBalance
      ? await fetch(`${API}/accounts/${encodeURIComponent(adjAccountId)}/balance-observations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: adjDate, amount: amountNum }),
        })
      : await fetch(`${API}/balance-adjustments`, {
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
      const code = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
      const fallback = settingFirstBalance ? 'Saldon asetus epäonnistui' : 'Saldo-oikaisun lisäys epäonnistui';
      showToast(setToast, (code && balanceErrorText[code]) || fallback, 4000);
      return;
    }
    setAdjAmount('');
    setAdjReason('');
    showToast(setToast, settingFirstBalance ? 'Saldo asetettu' : 'Saldo-oikaisu lisätty');
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
      showToast(setToast, 'Kategoria poistettu käytöstä ja rivit siirretty');
      if (tx) await refreshAll();
    } else {
      const data = await res.json().catch(() => ({}));
      if (data.error === 'category_has_role') {
        showToast(setToast, 'Tätä kategoriaa ei voi poistaa', 4000);
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
                    />
                    {c.role && <small className="muted">Suojattu</small>}
                  </span>
                  <span className="actions-row">
                    <button
                      className="ghost mini"
                      type="button"
                      onClick={() => deleteCategoryApi(c.id)}
                      disabled={Boolean(c.role)}
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
          <AccountSettings accounts={accounts} reload={async () => { await loadAccounts(); await refreshAll(); }} setToast={setToast} />

          <div className="balance-adjustments">
            <div className="card-head inner">
              <div>
                <p className="eyebrow">Saldo</p>
                <h3>Saldo-oikaisut</h3>
              </div>
            </div>
            <p className="muted">
              {settingFirstBalance
                ? 'Tilillä ei ole pankin ilmoittamaa saldoa, joten oikaistavaa ei ole. Aseta tilin saldo valittuna päivänä (luottokortin velka positiivisena summana: 600 = velkaa 600). Se tallentuu saldohavaintona, jota voit muokata tai poistaa tilin Saldot-kohdassa. Etusivu ja nettovarallisuus käyttävät sitä siitä päivästä alkaen. Saldohistoria pitää sitä tunnettuna vain siihen asti, kunnes tilille tuodaan sitä myöhempiä tapahtumia – lisää silloin uusi havainto.'
                : 'Saldo-oikaisu korjaa pankin ilmoittamaa saldoa summalla, ja se otetaan huomioon oikaisupäivänä ja sen jälkeen päivätyissä saldoissa. Tilille, jolla ei vielä ole saldoa, asetetaan ensin saldo.'}
            </p>

            {settingFirstBalance && waitingAdjustments.length > 0 && (
              <p className="neg">
                Tilillä on {waitingAdjustments.length} käyttämätöntä saldo-oikaisua. Asetettu saldo saa ne käyttöön, jos ne on
                päivätty saldon päivänä tai aiemmin, ja ne lisätään saldoon. Jos asettamasi saldo jo sisältää ne, poista ne alta.
              </p>
            )}
            <div className="settings-grid">
              <label>
                Tili
                <select value={adjAccountId} onChange={(e) => setAdjAccountId(e.target.value)}>
                  <option value="">–</option>
                  {balanceAccounts.map((a) => (
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
                {settingFirstBalance ? (adjAccount && isLiabilityType(adjAccount.account_subtype) ? 'Velka' : 'Saldo') : 'Summa'} ({adjAccount?.currency ?? 'EUR'})
                <input type="number" step="0.01" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} />
              </label>
              {!settingFirstBalance && (
                <label>
                  Syy (optional)
                  <input type="text" value={adjReason} onChange={(e) => setAdjReason(e.target.value)} />
                </label>
              )}
            </div>
            <div className="settings-actions">
              <button type="button" onClick={createBalanceAdjustmentApi}>
                {settingFirstBalance ? 'Aseta saldo' : 'Lisää saldo-oikaisu'}
              </button>
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
                    <span>
                      {ba.reason ?? '–'}
                      {!ba.applied && (
                        <span className="muted">
                          {' '}· Ei käytössä: tilillä ei ole saldoa tältä päivältä tai myöhemmin
                        </span>
                      )}
                    </span>
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
