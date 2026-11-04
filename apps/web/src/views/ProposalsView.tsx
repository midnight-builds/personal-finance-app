import { useCallback, useEffect, useState } from 'react';
import { getFeatureProposals, resolveFeatureProposal } from '../api/client';
import type { FeatureProposal } from '../api/client';
import { DECISION_NOTE_MAX_LENGTH, type FeatureProposalAction } from '@finance-app/shared';
import { formatDate, showToast } from '../utils';

type Props = {
  setToast: (v: string) => void;
};

const STATUS_LABEL: Record<FeatureProposal['status'], string> = {
  new: 'Uusi',
  accepted: 'Hyväksytty',
  rejected: 'Hylätty',
};

// Markdown body for a GitHub issue. The repo is public: the user reviews and
// edits this before publishing, nothing is posted automatically.
function toIssueMarkdown(p: FeatureProposal) {
  return [
    `# ${p.title}`,
    '',
    '## Problem',
    p.problem,
    '',
    '## Evidence',
    p.evidence,
    '',
    '## Proposal',
    p.proposal,
    '',
    '## Acceptance criteria',
    ...p.acceptanceCriteria.map((c) => `- [ ] ${c}`),
    '',
    `_Proposed by ${p.source}_`,
  ].join('\n');
}

export default function ProposalsView({ setToast }: Props) {
  const [proposals, setProposals] = useState<FeatureProposal[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    getFeatureProposals()
      .then(setProposals)
      .catch(() => showToast(setToast, 'Ehdotusten lataus epäonnistui'));
  }, [setToast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleResolve = async (p: FeatureProposal, action: FeatureProposalAction) => {
    if (busyId) return;
    setBusyId(p.id);
    try {
      await resolveFeatureProposal(p.id, action, notes[p.id]);
      showToast(setToast, action === 'accept' ? 'Ehdotus hyväksytty' : 'Ehdotus hylätty');
    } catch {
      showToast(setToast, 'Tallennus epäonnistui — ehdotus on ehkä jo käsitelty');
    } finally {
      setBusyId(null);
      load();
    }
  };

  const handleCopy = async (p: FeatureProposal) => {
    try {
      await navigator.clipboard.writeText(toIssueMarkdown(p));
      showToast(setToast, 'Kopioitu — tarkista ettei tekstissä ole henkilötietoja ennen julkaisua');
    } catch {
      showToast(setToast, 'Kopiointi epäonnistui');
    }
  };

  const open = proposals.filter((p) => p.status === 'new');
  const resolved = proposals.filter((p) => p.status !== 'new');
  const visible = showResolved ? [...open, ...resolved] : open;

  return (
    <section className="card glass">
      <div className="card-head">
        <div>
          <p className="eyebrow">Agenttien ehdotukset</p>
          <h2>Ominaisuusehdotukset</h2>
        </div>
        <button className="mini ghost" type="button" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? 'Näytä vain uudet' : `Näytä myös käsitellyt (${resolved.length})`}
        </button>
      </div>
      <p className="muted">
        Ulkoiset agentit (esim. Hermes) voivat ehdottaa ominaisuuksia MCP:n kautta. Ne eivät toteuta mitään —
        sinä päätät. Hyväksytyn ehdotuksen voi kopioida GitHub-issueksi.
      </p>

      {visible.length === 0 && <p className="muted">Ei uusia ehdotuksia.</p>}

      <div className="proposals">
        {visible.map((p) => (
          <article key={p.id} className="proposal">
            <div className="proposal-head">
              <strong>{p.title}</strong>
              <span className="chip soft">{STATUS_LABEL[p.status]}</span>
              <span className="muted">
                {p.source} · {formatDate(p.createdAt)}
              </span>
            </div>
            <dl>
              <dt>Ongelma</dt>
              <dd>{p.problem}</dd>
              <dt>Peruste</dt>
              <dd>{p.evidence}</dd>
              <dt>Ehdotus</dt>
              <dd>{p.proposal}</dd>
              <dt>Hyväksymiskriteerit</dt>
              <dd>
                <ul>
                  {p.acceptanceCriteria.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </dd>
              {p.decisionNote && (
                <>
                  <dt>Päätöksen perustelu</dt>
                  <dd>{p.decisionNote}</dd>
                </>
              )}
            </dl>
            {p.status === 'new' ? (
              <div className="proposal-actions">
                <input
                  type="text"
                  maxLength={DECISION_NOTE_MAX_LENGTH}
                  placeholder="Perustelu (valinnainen, agentti näkee sen)"
                  value={notes[p.id] ?? ''}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [p.id]: e.target.value }))}
                />
                <button className="mini" type="button" disabled={busyId !== null} onClick={() => handleResolve(p, 'accept')}>
                  Hyväksy
                </button>
                <button
                  className="mini ghost"
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => handleResolve(p, 'reject')}
                >
                  Hylkää
                </button>
              </div>
            ) : (
              p.status === 'accepted' && (
                <div className="proposal-actions">
                  <button className="mini ghost" type="button" onClick={() => handleCopy(p)}>
                    Kopioi issueksi (Markdown)
                  </button>
                </div>
              )
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
