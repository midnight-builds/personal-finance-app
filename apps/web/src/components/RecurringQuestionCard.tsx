import { decidePattern, dismissFinding } from '../api/client';
import type { InsightFinding, PatternDecision } from '../api/client';

type Props = {
  finding: InsightFinding;
  onResolved: (findingId: string) => void;
  setToast: (v: string) => void;
  onShowTransactions?: (ids: string[]) => void;
};

const ANSWERED: Record<PatternDecision, string> = {
  subscription: 'Merkitty tilaukseksi',
  recurring: 'Merkitty toistuvaksi maksuksi',
  not_recurring: 'Merkitty ei-toistuvaksi',
};

/** "Onko tämä toistuva?": the user's answer becomes the pattern's decision. */
export default function RecurringQuestionCard({ finding, onResolved, setToast, onShowTransactions }: Props) {
  const meta = finding.metadata as { patternId?: string; counterparty?: string; suggestedAnswer?: string };

  const answer = async (decision: PatternDecision) => {
    if (!meta.patternId) return;
    try {
      await decidePattern(meta.patternId, decision);
      // The question is answered for good; hide it from later loads of this briefing too.
      await dismissFinding(finding.id).catch(() => {});
      setToast(`${ANSWERED[decision]}: ${meta.counterparty ?? ''}`);
      onResolved(finding.id);
    } catch {
      setToast('Vastauksen tallennus epäonnistui');
    }
  };

  const subscriptionFirst = meta.suggestedAnswer === 'subscription';
  const subscription = (
    <button key="s" className={subscriptionFirst ? 'mini' : 'mini ghost'} type="button" onClick={() => answer('subscription')}>
      Kyllä, tilaus
    </button>
  );
  const recurring = (
    <button key="r" className={subscriptionFirst ? 'mini ghost' : 'mini'} type="button" onClick={() => answer('recurring')}>
      Kyllä, toistuva maksu
    </button>
  );

  return (
    <div className="finding-card finding-card-info">
      <div className="finding-header">
        <span className="chip">Kysymys</span>
        <strong>{finding.title}</strong>
      </div>
      <p className="finding-desc">{finding.description}</p>
      <div className="finding-actions">
        {subscriptionFirst ? [subscription, recurring] : [recurring, subscription]}
        <button className="mini ghost" type="button" onClick={() => answer('not_recurring')}>
          Ei toistuva
        </button>
        {onShowTransactions && finding.transactionIds.length > 0 && (
          <button className="mini ghost" type="button" onClick={() => onShowTransactions(finding.transactionIds)}>
            Näytä tapahtumat
          </button>
        )}
      </div>
    </div>
  );
}
