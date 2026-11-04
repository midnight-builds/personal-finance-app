import { useCallback, useEffect, useState } from 'react';
import {
  FeatureProposalRequestError,
  createFeatureProposal,
  getFeatureProposals,
  resolveFeatureProposal,
  updateFeatureProposal,
} from '../api/client';
import type { FeatureProposal } from '../api/client';
import {
  DECISION_NOTE_MAX_LENGTH,
  FEATURE_PROPOSAL_KINDS,
  FEATURE_PROPOSAL_TRANSITIONS,
  RESOLUTION_MAX_LENGTH,
  SENSITIVE_ID_ERROR,
  type FeatureProposalAction,
  type FeatureProposalUpdate,
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

type TextField = 'title' | 'problem' | 'evidence' | 'proposal';

const FIELD_LABEL: Record<TextField | 'kind' | 'acceptanceCriteria', string> = {
  kind: 'Tyyppi',
  title: 'Otsikko',
  problem: 'Ongelma',
  evidence: 'Peruste',
  proposal: 'Ehdotus',
  acceptanceCriteria: 'Hyväksymiskriteerit',
};

type Draft = Pick<FeatureProposal, TextField | 'kind'> & { criteria: string };

const EMPTY_DRAFT: Draft = { kind: 'feature', title: '', problem: '', evidence: '', proposal: '', criteria: '' };

/** Source recorded for proposals the user writes in the UI. */
const USER_SOURCE = 'user';

const toDraft = (p: FeatureProposal): Draft => ({
  kind: p.kind,
  title: p.title,
  problem: p.problem,
  evidence: p.evidence,
  proposal: p.proposal,
  criteria: p.acceptanceCriteria.join('\n'),
});

const parseCriteria = (criteria: string) =>
  criteria
    .split('\n')
    .map((c) => c.trim())
    .filter(Boolean);

// Only changed fields are sent, so an untouched field is never overwritten.
function diffDraft(p: FeatureProposal, d: Draft): FeatureProposalUpdate {
  const patch: FeatureProposalUpdate = {};
  if (d.kind !== p.kind) patch.kind = d.kind;
  for (const f of ['title', 'problem', 'evidence', 'proposal'] as const) {
    if (d[f].trim() !== p[f]) patch[f] = d[f];
  }
  const criteria = parseCriteria(d.criteria);
  if (JSON.stringify(criteria) !== JSON.stringify(p.acceptanceCriteria)) patch.acceptanceCriteria = criteria;
  return patch;
}

// "evidence: contains_account_or_personal_id" → "Peruste: sisältää tilinumeron tai henkilötunnuksen".
// Duplicate issues collapse: an empty criteria list and an empty item both read "pakollinen".
function describeIssue(issue: string) {
  const [path, ...rest] = issue.split(': ');
  const field = path.split('.')[0] as keyof typeof FIELD_LABEL;
  const message = rest.join(': ');
  const text = message.includes(SENSITIVE_ID_ERROR)
    ? 'sisältää tilinumeron tai henkilötunnuksen'
    : message.startsWith('Too small')
      ? 'pakollinen'
      : message.startsWith('Too big')
        ? 'liian pitkä'
        : message;
  return `${FIELD_LABEL[field] ?? path}: ${text}`;
}

function describeRequestError(err: unknown) {
  if (!(err instanceof FeatureProposalRequestError)) return 'Tallennus epäonnistui';
  if (err.code === 'duplicate_title') return 'Samalla otsikolla on jo toinen avoin ehdotus';
  if (err.code === 'not_editable') return 'Ehdotus on jo käsitelty, sitä ei voi enää muokata';
  if (err.code === 'not_found') return 'Ehdotusta ei löydy';
  if (err.details.length > 0) return [...new Set(err.details.map(describeIssue))].join('; ');
  return 'Tallennus epäonnistui';
}

type EditorProps = {
  /** Proposal to edit; omitted for a new one. */
  proposal?: FeatureProposal;
  onSaved: () => void;
  onCancel: () => void;
  setToast: (v: string) => void;
};

function ProposalEditor({ proposal, onSaved, onCancel, setToast }: EditorProps) {
  const [draft, setDraft] = useState(() => (proposal ? toDraft(proposal) : EMPTY_DRAFT));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const patch = proposal && diffDraft(proposal, draft);
  const changed = patch ? Object.keys(patch).length > 0 : true;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    if (!changed || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (proposal && patch) {
        await updateFeatureProposal(proposal.id, patch);
        showToast(setToast, 'Ehdotus päivitetty');
      } else {
        const { duplicate } = await createFeatureProposal({
          kind: draft.kind,
          title: draft.title,
          problem: draft.problem,
          evidence: draft.evidence,
          proposal: draft.proposal,
          acceptanceCriteria: parseCriteria(draft.criteria),
          source: USER_SOURCE,
        });
        // Keep the form open so the text is not lost; the existing proposal is in the list.
        if (duplicate) {
          setError('Samalla otsikolla on jo avoin ehdotus');
          setSaving(false);
          return;
        }
        showToast(setToast, 'Ehdotus lisätty');
      }
      onSaved();
    } catch (err) {
      setError(describeRequestError(err));
      setSaving(false);
    }
  };

  return (
    <form
      className="proposal-edit"
      onSubmit={(e) => {
        e.preventDefault();
        handleSave();
      }}
    >
      <label>
        {FIELD_LABEL.kind}
        <select value={draft.kind} onChange={(e) => set('kind', e.target.value as Draft['kind'])}>
          {FEATURE_PROPOSAL_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {FIELD_LABEL.title}
        <input type="text" maxLength={120} value={draft.title} onChange={(e) => set('title', e.target.value)} />
      </label>
      {(['problem', 'evidence', 'proposal'] as const).map((f) => (
        <label key={f}>
          {FIELD_LABEL[f]}
          <textarea rows={3} value={draft[f]} onChange={(e) => set(f, e.target.value)} />
        </label>
      ))}
      <label>
        {FIELD_LABEL.acceptanceCriteria} (yksi per rivi)
        <textarea rows={4} value={draft.criteria} onChange={(e) => set('criteria', e.target.value)} />
      </label>
      <p className="muted">
        Agentti näkee {proposal ? 'muokatun' : 'tämän'} tekstin. Älä lisää nimiä, tilinumeroita tai tarkkoja summia.
      </p>
      {error && <p className="proposal-error">{error}</p>}
      <div className="proposal-actions">
        <button className="mini" type="submit" disabled={!changed || saving}>
          {proposal ? 'Tallenna' : 'Lisää ehdotus'}
        </button>
        <button className="mini ghost" type="button" disabled={saving} onClick={onCancel}>
          Peruuta
        </button>
      </div>
    </form>
  );
}

export default function ProposalsView({ setToast }: Props) {
  const [proposals, setProposals] = useState<FeatureProposal[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
          <p className="eyebrow">Agenttien ja omat ehdotukset</p>
          <h2>Ominaisuusehdotukset</h2>
        </div>
        <div className="proposal-actions">
          {!creating && (
            <button className="mini" type="button" onClick={() => setCreating(true)}>
              Uusi ehdotus
            </button>
          )}
          <button className="mini ghost" type="button" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? 'Näytä vain avoimet' : `Näytä myös valmiit ja hylätyt (${resolved.length})`}
          </button>
        </div>
      </div>
      <p className="muted">
        Ulkoiset agentit (esim. Hermes) voivat ehdottaa ominaisuuksia ja ilmoittaa virheistä MCP:n kautta. Ne
        eivät toteuta mitään — sinä päätät. Agentti näkee tilan, perustelut ja toteutuksen viitteen. Voit myös
        lisätä oman ehdotuksen ja muokata avoimia. Hyväksytyn ehdotuksen voi kopioida GitHub-issueksi.
      </p>

      {creating && (
        <article className="proposal">
          <div className="proposal-head">
            <strong>Uusi ehdotus</strong>
          </div>
          <ProposalEditor
            setToast={setToast}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              load();
            }}
          />
        </article>
      )}

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
              {p.updatedAt && <span className="muted">muokattu {formatDate(p.updatedAt)}</span>}
              {isOpen(p) && editingId !== p.id && (
                <button className="mini ghost" type="button" onClick={() => setEditingId(p.id)}>
                  Muokkaa
                </button>
              )}
            </div>
            {editingId === p.id ? (
              <ProposalEditor
                proposal={p}
                setToast={setToast}
                onCancel={() => setEditingId(null)}
                onSaved={() => {
                  setEditingId(null);
                  load();
                }}
              />
            ) : (
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
            )}
            {isOpen(p) && editingId !== p.id && (
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
            {isOpen(p) && editingId !== p.id && (
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
