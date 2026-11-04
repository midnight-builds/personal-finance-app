import crypto from 'crypto';
import {
  FEATURE_PROPOSAL_TRANSITIONS,
  OPEN_FEATURE_PROPOSAL_STATUSES,
  featureProposalInputSchema,
  featureProposalUpdateSchema,
  type CreateFeatureProposalResponse,
  type FeatureProposal,
  type FeatureProposalDecision,
  type FeatureProposalEvent,
  type FeatureProposalKind,
  type FeatureProposalStatus,
} from '@finance-app/shared';
import { db } from './db.js';
import { DomainError } from './http/errors.js';

// Feature proposals come from external agents (e.g. Hermes via the MCP server).
// They are stored locally only; the user reviews them in the UI and decides
// what, if anything, becomes a public issue. Every status change is appended
// to `feature_proposal_events`, which the agent reads back as `history` to
// learn what was decided, why, and where it was fixed.

type Row = {
  id: string;
  created_at: string;
  source: string;
  kind: FeatureProposalKind;
  title: string;
  problem: string;
  evidence: string;
  proposal: string;
  acceptance_criteria: string;
  status: FeatureProposalStatus;
  updated_at: string | null;
  resolved_at: string | null;
  decision_note: string | null;
  resolution: string | null;
};

function toProposal(row: Row, history: FeatureProposalEvent[]): FeatureProposal {
  return {
    id: row.id,
    createdAt: row.created_at,
    source: row.source,
    kind: row.kind,
    title: row.title,
    problem: row.problem,
    evidence: row.evidence,
    proposal: row.proposal,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria) as string[],
    status: row.status,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    decisionNote: row.decision_note,
    resolution: row.resolution,
    history,
  };
}

function historyOf(ids: string[]): Map<string, FeatureProposalEvent[]> {
  const byId = new Map<string, FeatureProposalEvent[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return byId;
  const rows = db
    .prepare(
      `SELECT proposal_id, at, status, note, resolution FROM feature_proposal_events
       WHERE proposal_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`
    )
    .all(...ids) as Array<FeatureProposalEvent & { proposal_id: string }>;
  for (const { proposal_id, ...event } of rows) byId.get(proposal_id)?.push(event);
  return byId;
}

function withHistory(rows: Row[]): FeatureProposal[] {
  const history = historyOf(rows.map((r) => r.id));
  return rows.map((r) => toProposal(r, history.get(r.id) ?? []));
}

function getProposal(id: string): FeatureProposal | undefined {
  const row = getRow(id);
  return row && withHistory([row])[0];
}

function titleKey(title: string) {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function getRow(id: string) {
  return db.prepare('SELECT * FROM feature_proposals WHERE id = ?').get(id) as Row | undefined;
}

function openRows() {
  return db
    .prepare(
      `SELECT * FROM feature_proposals
       WHERE status IN (${OPEN_FEATURE_PROPOSAL_STATUSES.map(() => '?').join(',')})`
    )
    .all(...OPEN_FEATURE_PROPOSAL_STATUSES) as Row[];
}

/**
 * Validates and stores a proposal. An agent may re-propose the same idea, so a
 * title matching an open (new or accepted) proposal returns that one instead of
 * adding a copy. Throws `ZodError` on invalid input.
 */
export function createFeatureProposal(input: unknown): CreateFeatureProposalResponse {
  const data = featureProposalInputSchema.parse(input);

  const existing = openRows().find((r) => titleKey(r.title) === titleKey(data.title));
  if (existing) return { duplicate: true, proposal: withHistory([existing])[0] };

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO feature_proposals
       (id, created_at, source, kind, title, problem, evidence, proposal, acceptance_criteria, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`
  ).run(
    id,
    new Date().toISOString(),
    data.source,
    data.kind,
    data.title,
    data.problem,
    data.evidence,
    data.proposal,
    JSON.stringify(data.acceptanceCriteria)
  );
  return { duplicate: false, proposal: getProposal(id)! };
}

export function listFeatureProposals(status?: FeatureProposalStatus): FeatureProposal[] {
  const rows = status
    ? db.prepare('SELECT * FROM feature_proposals WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM feature_proposals ORDER BY created_at DESC').all();
  return withHistory(rows as Row[]);
}

/**
 * Records a status change (see `FEATURE_PROPOSAL_TRANSITIONS`). `done` requires
 * a `resolution` pointing at the change (commit, PR). Final statuses cannot change.
 */
export function resolveFeatureProposal(
  id: string,
  decision: FeatureProposalDecision,
  note?: string | null,
  resolution?: string | null
): FeatureProposal {
  if (decision === 'done' && !resolution) throw new DomainError('resolution_required', 400);
  const from = FEATURE_PROPOSAL_TRANSITIONS[decision];
  const at = new Date().toISOString();

  db.exec('BEGIN');
  try {
    const result = db
      .prepare(
        `UPDATE feature_proposals SET status = ?, resolved_at = ?, decision_note = ?, resolution = ?
         WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`
      )
      .run(decision, at, note || null, resolution || null, id, ...from) as { changes: number | bigint };

    if (Number(result.changes) === 0) {
      throw getRow(id) ? DomainError.conflict('invalid_transition') : DomainError.notFound();
    }
    db.prepare(
      'INSERT INTO feature_proposal_events (proposal_id, at, status, note, resolution) VALUES (?, ?, ?, ?, ?)'
    ).run(id, at, decision, note || null, resolution || null);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getProposal(id)!;
}

const UPDATE_COLUMNS = {
  kind: 'kind',
  title: 'title',
  problem: 'problem',
  evidence: 'evidence',
  proposal: 'proposal',
  acceptanceCriteria: 'acceptance_criteria',
} as const;

/**
 * Applies the user's edit to an open (new or accepted) proposal; status and
 * history are untouched. A title may not match another open proposal, which
 * would break duplicate detection. Throws `ZodError` on invalid input.
 */
export function updateFeatureProposal(id: string, input: unknown): FeatureProposal {
  const data = featureProposalUpdateSchema.parse(input);

  if (data.title !== undefined) {
    const clash = openRows().find((r) => r.id !== id && titleKey(r.title) === titleKey(data.title!));
    if (clash) throw DomainError.conflict('duplicate_title');
  }

  const entries = Object.entries(data).map(([key, value]) => [
    UPDATE_COLUMNS[key as keyof typeof UPDATE_COLUMNS],
    key === 'acceptanceCriteria' ? JSON.stringify(value) : (value as string),
  ]);
  const result = db
    .prepare(
      `UPDATE feature_proposals SET ${entries.map(([col]) => `${col} = ?`).join(', ')}, updated_at = ?
       WHERE id = ? AND status IN (${OPEN_FEATURE_PROPOSAL_STATUSES.map(() => '?').join(',')})`
    )
    .run(...entries.map(([, v]) => v), new Date().toISOString(), id, ...OPEN_FEATURE_PROPOSAL_STATUSES) as {
    changes: number | bigint;
  };

  if (Number(result.changes) === 0) {
    throw getRow(id) ? DomainError.conflict('not_editable') : DomainError.notFound();
  }
  return getProposal(id)!;
}
