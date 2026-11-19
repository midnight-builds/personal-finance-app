import { useEffect, useState } from 'react';
import type { NetWorth, NetWorthTotals } from '@finance-app/shared';
import { getNetWorth } from '../api/client';
import { ACCOUNT_TYPE_LABELS } from '../accountTypes';
import { formatAmount, formatDate } from '../utils';
import { StaleBadge } from './BalanceObservations';

// Net worth now (GLOSSARY.md, "Net worth"): every account that is not archived,
// imported and manual, at its latest balance, counted at the household's
// ownership share. Unknown balances are left out and named, never zero; stale
// ones are counted and flagged. Other currencies are shown apart, unconverted.

function Totals({ t }: { t: NetWorthTotals }) {
  return (
    <div className="chips">
      <span className="chip">Varat {formatAmount(t.assets, t.currency)}</span>
      <span className="chip soft">Velat {formatAmount(t.liabilities, t.currency)}</span>
      <span className="chip">
        <strong>Nettovarallisuus {formatAmount(t.netWorth, t.currency)}</strong>
      </span>
    </div>
  );
}

export default function NetWorthPanel({ refreshKey }: { refreshKey: unknown }) {
  const [data, setData] = useState<NetWorth | null>(null);
  useEffect(() => {
    getNetWorth().then(setData).catch(() => setData(null));
  }, [refreshKey]);
  if (!data || data.accounts.length === 0) return null;
  const missing = data.accounts.filter((a) => a.balance === null && a.currency === data.currency);

  return (
    <section className="card glass">
      <div className="card-head">
        <div>
          <p className="eyebrow">Varallisuus</p>
          <h2>Nettovarallisuus</h2>
        </div>
        <Totals t={data} />
      </div>
      <p className="muted">
        Jokainen tili viimeisimmällä saldollaan, omistusosuudella painotettuna (osuus koskee vain nettovarallisuutta,
        ei kassavirtaa).
        {!data.isComplete && missing.length > 0 && ` Osittainen: ${missing.map((a) => a.name).join(', ')} – saldoa ei tiedetä.`}
        {data.staleAccountIds.length > 0 && ` ${data.staleAccountIds.length} tilin saldo on vanhentunut.`}
      </p>
      <div className="table mini">
        <div className="row mini header">
          <span>Tili</span>
          <span>Tyyppi</span>
          <span>Saldo</span>
          <span>Osuus</span>
          <span>Nettovarallisuuteen</span>
          <span>Päivitetty</span>
        </div>
        {data.accounts.map((a) => (
          <div className="row mini" key={a.accountId}>
            <span>{a.name}</span>
            <span>
              {ACCOUNT_TYPE_LABELS[a.type] ?? a.type}
              {a.tracking === 'manual' && <span className="muted"> · manuaalinen</span>}
            </span>
            <span>{a.balance === null ? 'Ei tiedossa' : formatAmount(a.balance, a.currency)}</span>
            <span>{a.ownershipShare} %</span>
            <span>{a.ownedBalance === null ? '—' : formatAmount(a.ownedBalance, a.currency)}</span>
            <span>
              {a.unknownReason === 'bookings_after_balance'
                ? 'Saldon jälkeen tuotu tapahtumia'
                : a.balanceDate
                  ? formatDate(a.balanceDate)
                  : '—'}{' '}
              <StaleBadge stale={a.stale} ageDays={a.ageDays} />
            </span>
          </div>
        ))}
      </div>
      {data.otherCurrencies.map((t) => (
        <div key={t.currency}>
          <p className="muted">{t.currency}-tilit erikseen (ei muunneta euroiksi):</p>
          <Totals t={t} />
        </div>
      ))}
    </section>
  );
}
