import type { InsightFinding } from '../api/client';

type FindingCardProps = {
  finding: InsightFinding;
  onDismiss: (id: string) => void;
};

export default function FindingCard({ finding, onDismiss }: FindingCardProps) {
  const severityBadgeClass = `chip chip-${finding.severity}`;
  const severityText =
    finding.severity === 'alert' ? 'Hälytys' : finding.severity === 'warn' ? 'Varoitus' : 'Info';

  return (
    <div className={`finding-card finding-card-${finding.severity}`}>
      <div className="finding-card-head">
        <span className={severityBadgeClass}>{severityText}</span>
        <h3>{finding.title}</h3>
        <button className="mini ghost" onClick={() => onDismiss(finding.id)}>
          Ohita
        </button>
      </div>
      <p className="finding-card-desc">{finding.description}</p>
      {finding.impactEur !== null && (
        <p className="finding-card-impact">{Math.abs(finding.impactEur).toFixed(2)} € vaikutus</p>
      )}
    </div>
  );
}
