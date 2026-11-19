import { useState } from 'react';
import { ACCOUNT_TYPES, isValidIban, type AccountType } from '@finance-app/shared';
import {
  AccountRequestError,
  archiveAccount,
  createManualAccount,
  patchAccount,
  unarchiveAccount,
  type Account,
} from '../api/client';
import { ACCOUNT_TYPE_LABELS } from '../accountTypes';
import { formatAmount, showToast } from '../utils';
import BalanceObservations, { StaleBadge } from './BalanceObservations';

// Account settings (GLOSSARY.md, "Account"): every account's name, type, owner
// and ownership share; for manual accounts also currency, IBAN and update
// interval, and archiving; every account's latest balance, its staleness and
// its dated balance observations (BalanceObservations.tsx). A new account made
// here is manual: nothing is imported into it, and its IBAN makes payments to
// it transfers to it.

const ERRORS: Record<string, string> = {
  iban_in_use: 'Toisella tilillä on jo tämä IBAN.',
  account_name_exists: 'Samanniminen tili on jo olemassa.',
  account_imported: 'Tuodun tilin IBAN ja valuutta tulevat pankin tiedostoista.',
  account_archived: 'Tili on arkistoitu.',
  account_has_observations:
    'Tilillä on saldohavaintoja: valuuttaa tai velka-/varatyyppiä ei voi vaihtaa, koska tallennetut saldot muuttaisivat merkitystään. Poista havainnot ensin.',
  invalid_request: 'Tarkista kentät: IBAN, osuus 0–100 %, valuutta kolmella kirjaimella.',
};
const message = (err: unknown) =>
  err instanceof AccountRequestError ? (ERRORS[err.code] ?? `Tallennus epäonnistui (${err.code}).`) : 'Tallennus epäonnistui.';

const TRACKING_LABEL = { imported: 'Tuotu', manual: 'Manuaalinen' } as const;

function TypeSelect({ value, onChange }: { value: AccountType; onChange: (t: AccountType) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as AccountType)}>
      {ACCOUNT_TYPES.map((t) => (
        <option key={t} value={t}>
          {ACCOUNT_TYPE_LABELS[t]}
        </option>
      ))}
    </select>
  );
}

const parseShare = (text: string) => {
  const n = Number(text.replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};
const parseDays = (text: string) => {
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : null;
};

export default function AccountSettings({
  accounts,
  reload,
  setToast,
}: {
  accounts: Account[];
  reload: () => Promise<void>;
  setToast: (v: string) => void;
}) {
  const [draft, setDraft] = useState({ name: '', type: 'savings' as AccountType, share: '100', currency: 'EUR', iban: '', days: '' });
  const [saving, setSaving] = useState(false);
  const [openBalances, setOpenBalances] = useState<string | null>(null);
  const active = accounts.filter((a) => !a.archived_at);
  const archived = accounts.filter((a) => a.archived_at);

  const save = async (id: string, patch: Parameters<typeof patchAccount>[1], done?: string) => {
    try {
      await patchAccount(id, patch);
      if (done) showToast(setToast, done);
    } catch (err) {
      showToast(setToast, message(err));
    }
    await reload();
  };

  const create = async () => {
    const share = parseShare(draft.share);
    if (!draft.name.trim()) return showToast(setToast, 'Anna tilille nimi.');
    if (share === null) return showToast(setToast, 'Omistusosuus on 0–100 %.');
    if (draft.iban.trim() && !isValidIban(draft.iban)) return showToast(setToast, 'IBAN ei ole kelvollinen.');
    if (draft.days.trim() && parseDays(draft.days) === null) return showToast(setToast, 'Päivitysväli on 1–3650 päivää.');
    setSaving(true);
    try {
      await createManualAccount({
        name: draft.name.trim(),
        type: draft.type,
        ownershipShare: share,
        currency: draft.currency.trim() || 'EUR',
        ...(draft.iban.trim() ? { iban: draft.iban.trim() } : {}),
        ...(draft.days.trim() ? { updateIntervalDays: parseDays(draft.days)! } : {}),
      });
      setDraft({ name: '', type: 'savings', share: '100', currency: 'EUR', iban: '', days: '' });
      showToast(setToast, 'Manuaalinen tili lisätty.');
    } catch (err) {
      showToast(setToast, message(err));
    } finally {
      setSaving(false);
    }
    await reload();
  };

  return (
    <div className="account-editor">
      <div className="card-head inner">
        <div>
          <p className="eyebrow">Tilit</p>
          <h3>Tilit ja manuaaliset tilit</h3>
        </div>
      </div>
      <p className="muted">
        Tuotujen tilien tapahtumat ja saldot tulevat pankin tiedostoista. Manuaaliselle tilille ei tuoda mitään:
        jos annat sille IBANin, tuoduilta tileiltä siihen menevät maksut ovat siirtoja omalle tilille. Säästö- ja
        sijoitustilille ne ovat säästämistä ja lainalle lainanhoitoa – eivät kulutusta, mutta vähentävät silti
        kassaa. Omistusosuutta käytetään vain nettovarallisuudessa, ei kassavirrassa. Saldot-painikkeella kirjaat tilin
        päivätyn saldon (velka positiivisena); manuaalisella tilillä se on ainoa saldo. Jos tilille on asetettu
        päivitysväli ja saldo on sitä vanhempi, se merkitään vanhentuneeksi.
      </p>
      <div className="table mini accounts">
        <div className="row mini header">
          <span>Tili</span>
          <span>Tyyppi</span>
          <span>Seuranta</span>
          <span>Osuus %</span>
          <span>Omistaja</span>
          <span>Saldo</span>
        </div>
        {active.map((a) => (
          <div key={a.id}>
            <div className="row mini">
              <span>
                <input
                  type="text"
                  defaultValue={a.name}
                  aria-label="Tilin nimi"
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== a.name) save(a.id, { name });
                  }}
                />
              </span>
              <span>
                <TypeSelect value={a.account_subtype} onChange={(t) => save(a.id, { account_subtype: t })} />
              </span>
              <span>{TRACKING_LABEL[a.tracking] ?? a.tracking}</span>
              <span>
                <input
                  type="text"
                  inputMode="decimal"
                  defaultValue={String(a.ownership_share)}
                  aria-label="Omistusosuus prosentteina"
                  onBlur={(e) => {
                    const share = parseShare(e.target.value);
                    if (share === null) {
                      e.target.value = String(a.ownership_share);
                      showToast(setToast, 'Omistusosuus on 0–100 %.');
                    } else if (share !== a.ownership_share) save(a.id, { ownership_share: share });
                  }}
                />
              </span>
              <span>
                <input
                  type="text"
                  defaultValue={a.owner_label ?? ''}
                  aria-label="Omistaja"
                  onBlur={(e) => {
                    const val = e.target.value;
                    if (val !== (a.owner_label ?? '')) save(a.id, { owner_label: val || null });
                  }}
                />
              </span>
              <span className="account-balance">
                <span className="amount">{a.balance != null ? formatAmount(a.balance, a.currency ?? 'EUR') : '—'}</span>
                <StaleBadge stale={a.stale} ageDays={a.balance_age_days} />
                <button type="button" className="ghost mini" onClick={() => setOpenBalances(openBalances === a.id ? null : a.id)}>
                  {openBalances === a.id ? 'Sulje' : 'Saldot'}
                </button>
              </span>
            </div>
            {openBalances === a.id && <BalanceObservations account={a} onChanged={reload} setToast={setToast} />}
            {a.tracking === 'manual' && (
              <div className="row mini manual-account-details">
                <span>
                  <input
                    type="text"
                    defaultValue={a.iban ?? ''}
                    placeholder="IBAN (valinnainen)"
                    aria-label="IBAN"
                    onBlur={(e) => {
                      const iban = e.target.value.trim();
                      if (iban.replace(/\s+/g, '').toUpperCase() === (a.iban ?? '')) return;
                      if (iban && !isValidIban(iban)) {
                        showToast(setToast, 'IBAN ei ole kelvollinen.');
                        return;
                      }
                      save(a.id, { iban: iban || null }, iban ? 'IBAN tallennettu: siihen menevät maksut ovat siirtoja tälle tilille.' : 'IBAN poistettu.');
                    }}
                  />
                </span>
                <span>
                  <input
                    type="text"
                    defaultValue={a.currency}
                    maxLength={3}
                    aria-label="Valuutta"
                    onBlur={(e) => {
                      const currency = e.target.value.trim().toUpperCase();
                      if (currency && currency !== a.currency) save(a.id, { currency });
                    }}
                  />
                </span>
                <span>
                  <input
                    type="text"
                    inputMode="numeric"
                    defaultValue={a.update_interval_days ?? ''}
                    placeholder="Päivitysväli, pv"
                    aria-label="Päivitysväli päivinä"
                    onBlur={(e) => {
                      const text = e.target.value.trim();
                      const days = text ? parseDays(text) : null;
                      if (text && days === null) return showToast(setToast, 'Päivitysväli on 1–3650 päivää.');
                      if (days !== a.update_interval_days) save(a.id, { update_interval_days: days });
                    }}
                  />
                </span>
                <span className="muted">{a.recognizes_transfers ? 'Tunnistaa siirrot' : 'Ei IBANia'}</span>
                <span />
                <span>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!window.confirm(`Arkistoidaanko ${a.name}? Siihen menevät maksut lasketaan taas tavallisina maksuina.`)) return;
                      try {
                        await archiveAccount(a.id);
                        showToast(setToast, 'Tili arkistoitu.');
                      } catch (err) {
                        showToast(setToast, message(err));
                      }
                      await reload();
                    }}
                  >
                    Arkistoi
                  </button>
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
      {archived.length > 0 && (
        <div className="table mini">
          <div className="row mini header">
            <span>Arkistoidut tilit</span>
          </div>
          {archived.map((a) => (
            <div className="row mini" key={a.id}>
              <span>{a.name}</span>
              <span>{ACCOUNT_TYPE_LABELS[a.account_subtype] ?? a.account_subtype}</span>
              <span>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await unarchiveAccount(a.id);
                      showToast(setToast, 'Tili palautettu.');
                    } catch (err) {
                      showToast(setToast, message(err));
                    }
                    await reload();
                  }}
                >
                  Palauta
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="card-head inner">
        <div>
          <p className="eyebrow">Uusi tili</p>
          <h3>Lisää manuaalinen tili</h3>
        </div>
      </div>
      <div className="settings-grid manual-account-form">
        <label>
          Nimi
          <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label>
          Tyyppi
          <TypeSelect value={draft.type} onChange={(type) => setDraft({ ...draft, type })} />
        </label>
        <label>
          Omistusosuus %
          <input type="text" inputMode="decimal" value={draft.share} onChange={(e) => setDraft({ ...draft, share: e.target.value })} />
        </label>
        <label>
          Valuutta
          <input type="text" maxLength={3} value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} />
        </label>
        <label>
          IBAN (valinnainen)
          <input type="text" value={draft.iban} onChange={(e) => setDraft({ ...draft, iban: e.target.value })} />
        </label>
        <label>
          Päivitysväli, pv (valinnainen)
          <input type="text" inputMode="numeric" value={draft.days} onChange={(e) => setDraft({ ...draft, days: e.target.value })} />
        </label>
        <button type="button" onClick={create} disabled={saving}>
          Lisää tili
        </button>
      </div>
    </div>
  );
}
