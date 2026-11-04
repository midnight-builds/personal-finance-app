import crypto from 'crypto';
import {
  featureProposalInputSchema,
  type CreateFeatureProposalResponse,
  type FeatureProposal,
  type FeatureProposalDecision,
  type FeatureProposalStatus,
} from '@finance-app/shared';
import { db } from './db.js';
import { DomainError } from './http/errors.js';

// Feature proposals come from external agents (e.g. Hermes via the MCP server).
// They are stored locally only; the user reviews them in the UI and decides
// what, if anything, becomes a public issue.

type Row = {
  id: string;
  created_at: string;
  source: string;
  title: string;
  problem: string;
  evidence: string;
  proposal: string;
  acceptance_criteria: string;
  status: FeatureProposalStatus;
  resolved_at: string | null;
  decision_note: string | null;
};

function toProposal(row: Row): FeatureProposal {
  return {
    id: row.id,
    createdAt: row.created_at,
    source: row.source,
    title: row.title,
    problem: row.problem,
    evidence: row.evidence,
    proposal: row.proposal,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria) as string[],
    status: row.status,
    resolvedAt: row.resolved_at,
    decisionNote: row.decision_note,
  };
}

function titleKey(title: string) {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function getRow(id: string) {
  return db.prepare('SELECT * FROM feature_proposals WHERE id = ?').get(id) as Row | undefined;
}

/**
 * Validates and stores a proposal. An agent may re-propose the same idea, so a
 * title matching an open proposal returns that one instead of adding a copy.
 * Throws `ZodError` on invalid input.
 */
export function createFeatureProposal(input: unknown): CreateFeatureProposalResponse {
  const data = featureProposalInputSchema.parse(input);

  const openRows = db.prepare(`SELECT * FROM feature_proposals WHERE status = 'new'`).all() as Row[];
  const existing = openRows.find((r) => titleKey(r.title) === titleKey(data.title));
  if (existing) return { duplicate: true, proposal: toProposal(existing) };

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO feature_proposals
       (id, created_at, source, title, problem, evidence, proposal, acceptance_criteria, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')`
  ).run(
    id,
    new Date().toISOString(),
    data.source,
    data.title,
    data.problem,
    data.evidence,
    data.proposal,
    JSON.stringify(data.acceptanceCriteria)
  );
  return { duplicate: false, proposal: toProposal(getRow(id)!) };
}

export function listFeatureProposals(status?: FeatureProposalStatus): FeatureProposal[] {
  const rows = status
    ? db.prepare('SELECT * FROM feature_proposals WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM feature_proposals ORDER BY created_at DESC').all();
  return (rows as Row[]).map(toProposal);
}

/** Records the user's decision. Decisions are final: a resolved proposal cannot be flipped. */
export function resolveFeatureProposal(id: string, decision: FeatureProposalDecision, note?: string | null): FeatureProposal {
  const result = db
    .prepare(
      `UPDATE feature_proposals SET status = ?, resolved_at = ?, decision_note = ?
       WHERE id = ? AND status = 'new'`
    )
    .run(decision, new Date().toISOString(), note || null, id) as { changes: number | bigint };

  if (Number(result.changes) === 0) {
    throw getRow(id) ? DomainError.conflict('already_resolved') : DomainError.notFound();
  }
  return toProposal(getRow(id)!);
}
