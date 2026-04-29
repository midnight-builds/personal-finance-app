import { confirmPatternConfirmation, rejectPatternConfirmation } from '../api/client';
import type { InsightFinding } from '../api/client';

const MONTHS = ['tammikuu', 'helmikuu', 'maaliskuu', 'huhtikuu', 'toukokuu', 'kesäkuu',
                'heinäkuu', 'elokuu', 'syyskuu', 'lokakuu', 'marraskuu', 'joulukuu'];

type Props = {
  finding: InsightFinding;
  onResolved: (findingId: string) => void;
  setToast: (v: string) => void;
};

export default function PatternConfirmationCard({ finding, onResolved, setToast }: Props) {
  const meta = finding.metadata as { confirmationId?: string; counterparty?: string; month?: number };
  const confirmationId = meta.confirmationId;
  const monthName = meta.month ? MONTHS[meta.month - 1] : '?';
  const amount = finding.impactEur !== null ? `${finding.impactEur.toFixed(2)} €` : '';

  const handleConfirm = async () => {
    if (!confirmationId) return;
    try {
      await confirmPatternConfirmation(confirmationId);
      setToast(`Merkitty vuosittaiseksi: ${meta.counterparty}`);
      onResolved(finding.id);
    } catch {
      setToast('Virhe vahvistuksessa');
    }
  };

  const handleReject = async () => {
    if (!confirmationId) return;
    try {
      await rejectPatternConfirmation(confirmationId);
      setToast('Ohitettu');
      onResolved(finding.id);
    } catch {
      setToast('Virhe hylkäyksessä');
    }
  };

  return (
    <div className="finding-card finding-card-info">
      <div className="finding-header">
        <span className="chip">Kysymys</span>
        <strong>{meta.counterparty ?? finding.title}</strong>
      </div>
      <p className="finding-desc">
        {amount} {monthName}ssa — tuleeko tämä maksu ensi vuonna todennäköisesti uudelleen?
      </p>
      <div className="finding-actions">
        <button className="mini" type="button" onClick={handleConfirm}>
          Kyllä, vuosittainen
        </button>
        <button className="mini ghost" type="button" onClick={handleReject}>
          Ei, kertaluonteinen
        </button>
      </div>
    </div>
  );
}
