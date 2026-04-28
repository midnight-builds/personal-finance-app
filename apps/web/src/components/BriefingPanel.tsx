import { useEffect, useState } from 'react';
import { getLatestBriefing, dismissFinding } from '../api/client';
import type { BriefingSession } from '../api/client';
import FindingCard from './FindingCard';

type BriefingPanelProps = {
  setToast: (v: string) => void;
  onFilterTransactions?: (ids: string[]) => void;
};

export default function BriefingPanel({ setToast, onFilterTransactions }: BriefingPanelProps) {
  const [briefing, setBriefing] = useState<BriefingSession | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const loadBriefing = async () => {
      try {
        const data = await getLatestBriefing();
        setBriefing(data);
      } catch {
        // If getLatestBriefing throws (404 or other error), just set briefing to null
        setBriefing(null);
      }
    };
    loadBriefing();
  }, []);

  const handleDismiss = async (findingId: string) => {
    try {
      await dismissFinding(findingId);
      // Optimistically add to dismissed set
      setDismissed((prev) => new Set(prev).add(findingId));
      setToast('Havainto ohitettu');
    } catch {
      setToast('Ohittaminen epäonnistui');
    }
  };

  // Visible findings = briefing.findings.filter(f => !dismissed.has(f.id))
  const visibleFindings =
    briefing && briefing.findings ? briefing.findings.filter((f) => !dismissed.has(f.id)) : [];

  // If briefing === null OR all findings are dismissed, show empty state
  if (!briefing || visibleFindings.length === 0) {
    return <p>Ei uusia havaintoja.</p>;
  }

  return (
    <div className="briefing-panel">
      <h2>Talousanalyysi</h2>
      {visibleFindings.map((finding) => (
        <div key={finding.id}>
          <FindingCard
            finding={finding}
            onDismiss={handleDismiss}
          />
          {onFilterTransactions && finding.transactionIds.length > 0 && (
            <button
              className="mini"
              onClick={() => onFilterTransactions(finding.transactionIds)}
            >
              Näytä tapahtumat
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
