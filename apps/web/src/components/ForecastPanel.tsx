import { useEffect, useState } from 'react';
import { getForecast } from '../api/client';
import type { MonthlyForecast } from '../api/client';

const MONTH_NAMES = ['tammi', 'helmi', 'maalis', 'huhti', 'touko', 'kesä',
                     'heinä', 'elo', 'syys', 'loka', 'marras', 'joulu'];

function fmt(n: number) {
  return n.toLocaleString('fi-FI', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
}

export default function ForecastPanel() {
  const [forecasts, setForecasts] = useState<MonthlyForecast[]>([]);

  useEffect(() => {
    getForecast().then(setForecasts).catch(() => {});
  }, []);

  if (forecasts.length === 0 || forecasts.every((f) => f.projectedTotal === 0)) return null;

  return (
    <section className="card glass">
      <div className="card-head">
        <div>
          <p className="eyebrow">Tulevat kulut</p>
          <h2>3 kuukauden ennuste</h2>
        </div>
      </div>
      <div className="forecast-grid">
        {forecasts.map((f) => {
          const [year, month] = f.targetMonth.split('-');
          const monthLabel = MONTH_NAMES[parseInt(month, 10) - 1] + 'kuu ' + year;
          return (
            <div key={f.targetMonth} className="forecast-month">
              <div className="forecast-label">{monthLabel}</div>
              <div className="forecast-total">{fmt(f.projectedTotal)}</div>
              {f.annualItems.length > 0 && (
                <div className="forecast-annual">
                  {f.annualItems.map((i) => (
                    <span key={i.counterparty} className="chip chip-annual">
                      {i.counterparty} {fmt(i.amount)}
                    </span>
                  ))}
                </div>
              )}
              <div className="forecast-meta">
                {f.knownFixed.length} kuukausimaksua
                {f.historicalAvg > 0 && ` · historia: ${fmt(f.historicalAvg)}`}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
