import { useCallback, useEffect, useState } from 'react';
import { getFeatureProposals, resolveFeatureProposal } from '../api/client';
import type { FeatureProposal } from '../api/client';
import {
  DECISION_NOTE_MAX_LENGTH,
  FEATURE_PROPOSAL_TRANSITIONS,
  RESOLUTION_MAX_LENGTH,
  type FeatureProposalAction,
} from '@finance-app/shared';
import { formatDate, showToast } from '../utils';

type Props = {
  setToast: (v: string) => void;
};

const STATUS_LABEL: Record<FeatureProposal['status'], string> = {
  new: 'Uusi',
  accepted: 'Hyväksytty',
  rejected: 'Hylätty',
  done: 'Toteutettu',
};

const KIND_LABEL: Record<FeatureProposal['kind'], string> = {
  feature: 'Ominaisuus',
  bug: 'Virhe',
};

const ACTION_TOAST: Record<FeatureProposalAction, string> = {
  accept: 'Ehdotus hyväksytty',
  reject: 'Ehdotus hylätty',
  done: 'Merkitty toteutetuksi',
};

const canBecome = (p: FeatureProposal, status: keyof typeof FEATURE_PROPOSAL_TRANSITIONS) =>
  FEATURE_PROPOSAL_TRANSITIONS[status].includes(p.status);

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
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
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
      await resolveFeatureProposal(p.id, action, notes[p.id], resolutions[p.id]);
      showToast(setToast, ACTION_TOAST[action]);
      setNotes((prev) => ({ ...prev, [p.id]: '' }));
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

  const isOpen = (p: FeatureProposal) => p.status === 'new' || p.status === 'accepted';
  const open = proposals.filter(isOpen);
  const resolved = proposals.filter((p) => !isOpen(p));
  const visible = showResolved ? [...open, ...resolved] : open;

  return (
    <section className="card glass">
      <div className="card-head">
        <div>
          <p className="eyebrow">Agenttien ehdotukset</p>
          <h2>Ominaisuusehdotukset</h2>
        </div>
        <button className="mini ghost" type="button" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? 'Näytä vain avoimet' : `Näytä myös valmiit ja hylätyt (${resolved.length})`}
        </button>
      </div>
      <p className="muted">
        Ulkoiset agentit (esim. Hermes) voivat ehdottaa ominaisuuksia ja ilmoittaa virheistä MCP:n kautta. Ne
        eivät toteuta mitään — sinä päätät. Agentti näkee tilan, perustelut ja toteutuksen viitteen. Hyväksytyn
        ehdotuksen voi kopioida GitHub-issueksi.
      </p>

      {visible.length === 0 && <p className="muted">Ei avoimia ehdotuksia.</p>}

      <div className="proposals">
        {visible.map((p) => (
          <article key={p.id} className="proposal">
            <div className="proposal-head">
              <strong>{p.title}</strong>
              <span className="chip soft">{KIND_LABEL[p.kind]}</span>
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
              {p.resolution && (
                <>
                  <dt>Toteutus</dt>
                  <dd>{p.resolution}</dd>
                </>
              )}
              {p.history.length > 0 && (
                <>
                  <dt>Historia</dt>
                  <dd>
                    <ul>
                      {p.history.map((e, i) => (
                        <li key={i}>
                          {formatDate(e.at)} · {STATUS_LABEL[e.status]}
                          {e.note && ` — ${e.note}`}
                          {e.resolution && ` (${e.resolution})`}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </>
              )}
            </dl>
            {isOpen(p) && (
              <div className="proposal-actions">
                <input
                  type="text"
                  maxLength={DECISION_NOTE_MAX_LENGTH}
                  placeholder="Perustelu (valinnainen, agentti näkee sen)"
                  value={notes[p.id] ?? ''}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [p.id]: e.target.value }))}
                />
                {canBecome(p, 'accepted') && (
                  <button className="mini" type="button" disabled={busyId !== null} onClick={() => handleResolve(p, 'accept')}>
                    Hyväksy
                  </button>
                )}
                <button
                  className="mini ghost"
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => handleResolve(p, 'reject')}
                >
                  Hylkää
                </button>
              </div>
            )}
            {isOpen(p) && (
              <div className="proposal-actions">
                <input
                  type="text"
                  maxLength={RESOLUTION_MAX_LENGTH}
                  placeholder="Commit tai PR-linkki"
                  value={resolutions[p.id] ?? ''}
                  onChange={(e) => setResolutions((prev) => ({ ...prev, [p.id]: e.target.value }))}
                />
                <button
                  className="mini ghost"
                  type="button"
                  disabled={busyId !== null || !resolutions[p.id]?.trim()}
                  onClick={() => handleResolve(p, 'done')}
                >
                  Merkitse toteutetuksi
                </button>
                {p.status === 'accepted' && (
                  <button className="mini ghost" type="button" onClick={() => handleCopy(p)}>
                    Kopioi issueksi (Markdown)
                  </button>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
