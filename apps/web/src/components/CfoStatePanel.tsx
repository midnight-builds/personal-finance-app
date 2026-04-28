import type { HouseholdSummary } from '../api/client';
import { formatAmount } from '../utils';
import AccountCard from './AccountCard';

type CfoStatePanelProps = {
  summary: HouseholdSummary;
};

export default function CfoStatePanel({ summary }: CfoStatePanelProps) {
  return (
    <div className="cfo-state-panel">
      <header className="cfo-header">
        <span>Kotitalous — data: {summary.dataAgeDays} pv sitten</span>
      </header>

      <div className="cfo-metrics">
        <div className="cfo-metric">
          <span className="cfo-metric-label">Likvidit varat</span>
          <strong className="cfo-metric-value">{formatAmount(summary.liquidAssets)}</strong>
        </div>
        <div className="cfo-metric">
          <span className="cfo-metric-label">Runway</span>
          <strong className="cfo-metric-value">
            {summary.runwayMonths === null ? '—' : `${summary.runwayMonths.toFixed(1)} kk`}
          </strong>
        </div>
        <div className="cfo-metric">
          <span className="cfo-metric-label">Luottovelka</span>
          <strong className="cfo-metric-value">{formatAmount(summary.creditDebt)}</strong>
        </div>
        <div className="cfo-metric">
          <span className="cfo-metric-label">Tilaukset</span>
          <strong className="cfo-metric-value">{formatAmount(summary.monthlySubscriptions)}/kk</strong>
        </div>
      </div>

      <div className="cfo-accounts">
        {summary.accounts.map((a) => (
          <AccountCard key={a.id} account={a} />
        ))}
      </div>
    </div>
  );
}
