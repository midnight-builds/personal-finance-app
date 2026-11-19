import { useEffect, useState } from 'react';
import { isLiabilityType, type AccountBalanceObservations } from '@finance-app/shared';
import {
  AccountRequestError,
  addBalanceObservation,
  correctBalanceObservation,
  deleteBalanceObservation,
  getBalanceObservations,
  type Account,
} from '../api/client';
import { formatAmount, formatDate, showToast } from '../utils';

// An account's dated balance observations (GLOSSARY.md, "Balance observation"):
// for a manual account its only balance, for an imported one an anchor between
// the bank's balances. Each add, correction and deletion is an account change
// set (undoable, with the actor). Debt is entered as a positive amount.

const ERRORS: Record<string, string> = {
  date_in_future: 'Päivä ei voi olla tulevaisuudessa.',
  observation_exists: 'Tälle päivälle on jo saldohavainto – muokkaa sitä.',
  snapshot_exists: 'Tälle päivälle on jo pankin ilmoittama saldo – korjaa se saldo-oikaisulla.',
  account_archived: 'Tili on arkistoitu.',
  nothing_to_change: 'Ei muutettavaa.',
  invalid_request: 'Tarkista päivä ja summa.',
  debt_negative: 'Kirjaa velka positiivisena summana. Luottoa (plussalla olevaa korttia) ei voi kirjata velaksi.',
  account_has_observations: 'Tilin tyyppi tai valuutta on muuttunut, joten aiempaa havaintoa ei voi palauttaa.',
};
const message = (err: unknown) =>
  err instanceof AccountRequestError ? (ERRORS[err.code] ?? `Tallennus epäonnistui (${err.code}).`) : 'Tallennus epäonnistui.';

const todayInHelsinki = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Helsinki' });
const parseAmount = (text: string) => {
  const n = Number(text.replace(/\s/g, '').replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) ? n : null;
};

export function StaleBadge({ stale, ageDays }: { stale: boolean; ageDays: number | null }) {
  if (!stale) return null;
  return (
    <span className="chip soft neg" title="Saldo on vanhempi kuin tilin päivitysväli">
      Vanhentunut{ageDays !== null ? ` (${ageDays} pv)` : ''}
    </span>
  );
}

export default function BalanceObservations({
  account,
  onChanged,
  setToast,
}: {
  account: Account;
  onChanged: () => Promise<void>;
  setToast: (v: string) => void;
}) {
  const [data, setData] = useState<AccountBalanceObservations | null>(null);
  const [draft, setDraft] = useState({ date: todayInHelsinki(), amount: '', note: '' });
  const [editing, setEditing] = useState<{ id: string; date: string; amount: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const debt = isLiabilityType(account.account_subtype);
  const amountLabel = debt ? 'Velka' : 'Saldo';
  // The entered amount of an observation: a liability's debt (positive), otherwise its balance.
  const shown = (o: { balance: number; debt: number | null }) => (debt ? (o.debt ?? -o.balance) : o.balance);

  const load = async () => {
    try {
      setData(await getBalanceObservations(account.id));
    } catch (err) {
      showToast(setToast, message(err));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, account.account_subtype]);

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      showToast(setToast, done);
      await load();
      await onChanged();
      return true;
    } catch (err) {
      showToast(setToast, message(err), 4000);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const amount = parseAmount(draft.amount);
    if (!draft.date) return showToast(setToast, 'Päivä puuttuu.');
    if (amount === null) return showToast(setToast, 'Summa ei ole numero.');
    if (debt && amount < 0) return showToast(setToast, ERRORS.debt_negative, 4000);
    const ok = await run(
      () => addBalanceObservation(account.id, { date: draft.date, amount, ...(draft.note.trim() ? { note: draft.note.trim() } : {}) }),
      'Saldohavainto lisätty.'
    );
    if (ok) setDraft({ date: todayInHelsinki(), amount: '', note: '' });
  };

  const saveEdit = async () => {
    if (!editing) return;
    const original = data?.observations.find((o) => o.id === editing.id);
    if (!original) return;
    const amount = parseAmount(editing.amount);
    if (amount === null) return showToast(setToast, 'Summa ei ole numero.');
    // Only what the user changed is sent: an untouched amount is never re-entered (and re-signed).
    const patch: { date?: string; amount?: number; note?: string } = {};
    if (editing.date !== original.date) patch.date = editing.date;
    if (editing.amount !== String(shown(original))) {
      if (debt && amount < 0) return showToast(setToast, ERRORS.debt_negative, 4000);
      patch.amount = amount;
    }
    if (editing.note.trim() !== (original.note ?? '')) patch.note = editing.note.trim();
    if (Object.keys(patch).length === 0) return setEditing(null);
    const ok = await run(() => correctBalanceObservation(editing.id, patch), 'Saldohavainto korjattu.');
    if (ok) setEditing(null);
  };

  return (
    <div className="balance-observations">
      <p className="muted">
        {account.tracking === 'manual'
          ? 'Manuaalisen tilin saldo on sen viimeisin saldohavainto. Havaintojen välille ei arvioida mitään, eikä ennen ensimmäistä havaintoa saldoa tiedetä.'
          : 'Havainto on kiintopiste pankin ilmoittamien saldojen välissä, esimerkiksi korttilaskun päätössaldo. Se ei luo tapahtumia; ero tapahtumiin näytetään.'}{' '}
        {debt && 'Kirjaa velka positiivisena summana: 1 200 tarkoittaa, että velkaa on 1 200.'} Jokainen muutos tallentuu
        muutoshistoriaan ja on peruttavissa.
      </p>
      {data && (
        <p>
          {data.latest ? (
            <>
              Viimeisin {amountLabel.toLowerCase()}: <strong>{formatAmount(shown(data.latest), data.currency)}</strong> (
              {formatDate(data.latest.date)}, {data.latest.source === 'manual' ? 'havainto' : 'pankin saldo'}){' '}
              <StaleBadge stale={data.stale} ageDays={data.ageDays} />
            </>
          ) : (
            <span className="muted">Saldoa ei tiedetä.</span>
          )}
          {data.imported.count > 0 && (
            <span className="muted"> · Pankin saldoja {data.imported.count} kpl</span>
          )}
        </p>
      )}
      {data && data.observations.length > 0 && (
        <div className="table mini">
          <div className="row mini header">
            <span>Päivä</span>
            <span>{amountLabel}</span>
            <span>Lähde / huomio</span>
            <span>Kirjaaja</span>
            <span>{account.tracking === 'imported' ? 'Ero tapahtumiin' : ''}</span>
            <span />
          </div>
          {data.observations.map((o) =>
            editing?.id === o.id ? (
              <div className="row mini" key={o.id}>
                <span>
                  <input type="date" value={editing.date} max={todayInHelsinki()} onChange={(e) => setEditing({ ...editing, date: e.target.value })} />
                </span>
                <span>
                  <input type="text" inputMode="decimal" value={editing.amount} aria-label={amountLabel} onChange={(e) => setEditing({ ...editing, amount: e.target.value })} />
                </span>
                <span>
                  <input type="text" value={editing.note} aria-label="Huomio" onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
                </span>
                <span />
                <span />
                <span className="actions-row">
                  <button type="button" onClick={saveEdit} disabled={busy}>
                    Tallenna
                  </button>
                  <button type="button" className="ghost mini" onClick={() => setEditing(null)}>
                    Peru
                  </button>
                </span>
              </div>
            ) : (
              <div className="row mini" key={o.id}>
                <span>{formatDate(o.date)}</span>
                <span>{formatAmount(shown(o), o.currency)}</span>
                <span>{o.note ?? '—'}</span>
                <span className="muted">{o.actor === 'user' ? 'sinä' : o.actor}</span>
                <span className={o.reconciliation && o.reconciliation.difference !== 0 ? 'neg' : 'muted'}>
                  {o.reconciliation
                    ? o.reconciliation.difference === 0
                      ? 'Täsmää'
                      : `${formatAmount(o.reconciliation.difference, o.currency)} (${formatDate(o.reconciliation.previousDate)} jälkeen)`
                    : ''}
                </span>
                <span className="actions-row">
                  <button
                    type="button"
                    className="ghost mini"
                    onClick={() => setEditing({ id: o.id, date: o.date, amount: String(shown(o)), note: o.note ?? '' })}
                  >
                    Muokkaa
                  </button>
                  <button
                    type="button"
                    className="ghost mini"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Poistetaanko ${formatDate(o.date)} saldohavainto? Muutoshistoria säilyttää sen.`)) return;
                      void run(() => deleteBalanceObservation(o.id), 'Saldohavainto poistettu.');
                    }}
                  >
                    Poista
                  </button>
                </span>
              </div>
            )
          )}
        </div>
      )}
      <div className="settings-grid manual-account-form">
        <label>
          Päivä
          <input type="date" value={draft.date} max={todayInHelsinki()} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
        </label>
        <label>
          {amountLabel} ({account.currency})
          <input type="text" inputMode="decimal" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
        </label>
        <label>
          Lähde / huomio (valinnainen)
          <input type="text" value={draft.note} placeholder="esim. korttilasku" onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        </label>
        <button type="button" onClick={add} disabled={busy}>
          Lisää saldohavainto
        </button>
      </div>
    </div>
  );
}
