import { useEffect, useState } from 'react';
import { getRawTransactions, type RawRow } from '../api/client';
import { formatDate, formatAmount } from '../utils';

interface ExplorerViewProps {
  setToast: (v: string) => void;
}

export default function ExplorerView({ setToast: _setToast }: ExplorerViewProps) {
  const [rawRows, setRawRows] = useState<RawRow[]>([]);

  useEffect(() => {
    getRawTransactions()
      .then(setRawRows)
      .catch(() => {/* silently ignore on error */});
  }, []);

  return (
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
}
