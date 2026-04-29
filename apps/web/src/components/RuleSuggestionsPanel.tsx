import { useEffect, useState } from 'react';
import { getRuleSuggestions, acceptRuleSuggestion, rejectRuleSuggestion } from '../api/client';
import type { RuleSuggestion } from '../api/client';

type Props = {
  setToast: (v: string) => void;
  refreshKey?: string | number;
};

export default function RuleSuggestionsPanel({ setToast, refreshKey }: Props) {
  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([]);

  useEffect(() => {
    getRuleSuggestions().then(setSuggestions).catch(() => {});
  }, [refreshKey]);

  if (suggestions.length === 0) return null;

  const remove = (id: string) => setSuggestions((prev) => prev.filter((s) => s.id !== id));

  const handleAccept = async (s: RuleSuggestion) => {
    try {
      await acceptRuleSuggestion(s.id);
      setToast(`Sääntö lisätty: ${s.sample_counterparty ?? s.pattern} → ${s.category_name}`);
      remove(s.id);
    } catch {
      setToast('Hyväksyminen epäonnistui');
    }
  };

  const handleReject = async (s: RuleSuggestion) => {
    try {
      await rejectRuleSuggestion(s.id);
      setToast('Ehdotus hylätty');
      remove(s.id);
    } catch {
      setToast('Hylkääminen epäonnistui');
    }
  };

  return (
    <section className="card glass">
      <div className="card-head">
        <div>
          <p className="eyebrow">AI-ehdotukset</p>
          <h2>Kategoriasäännöt</h2>
        </div>
      </div>
      <p className="muted">
        AI tunnisti nämä kauppakumppanit — hyväksy säännöt automaattista kategorisointia varten.
      </p>
      <div className="rule-suggestions">
        {suggestions.map((s) => (
          <div key={s.id} className="rule-suggestion-row">
            <div className="rule-suggestion-info">
              <strong>{s.sample_counterparty ?? s.pattern}</strong>
              <span className="arrow"> → </span>
              <span className="chip">{s.category_name}</span>
              {s.ai_reason && <span className="muted rule-reason">{s.ai_reason}</span>}
            </div>
            <div className="rule-suggestion-actions">
              <button className="mini" type="button" onClick={() => handleAccept(s)}>
                Hyväksy sääntö
              </button>
              <button className="mini ghost" type="button" onClick={() => handleReject(s)}>
                Hylkää
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
