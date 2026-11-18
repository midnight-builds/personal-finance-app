import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { initDb, seedDefaultCategories, db } from './db.js';
import { listTransactions } from './query.js';
import { getSummary, getHouseholdSummary } from './summary.js';
import { getDataStatus } from './dataStatus.js';
import { getInsights } from './insights.js';
import { aiCategorize } from './ai.js';
import { getMonthlyOverview } from './monthly.js';
import { listRaw } from './raw.js';
import { getSettings, updateSettings } from './settings.js';
import { listLog } from './logger.js';
import { listAccounts, updateAccount } from './accounts.js';
import { listPendingConfirmations, confirmPatternConfirmation, rejectPatternConfirmation } from './patternConfirmations.js';
import { redetectPatternsIfRulesChanged } from './patterns.js';
import { relinkTransfersIfRulesChanged } from './importer.js';
import { withoutAnsweredQuestions } from './briefing.js';
import { routes } from './routes/index.js';

initDb();
seedDefaultCategories();

const server = Fastify({ logger: true });

try {
  if (relinkTransfersIfRulesChanged()) server.log.info('Stored transactions re-linked for new transfer rules');
} catch (err) {
  server.log.error({ err }, 'Re-linking transfers failed; stored links kept');
}
try {
  if (redetectPatternsIfRulesChanged()) server.log.info('Recurring patterns re-detected for new detection rules');
} catch (err) {
  server.log.error({ err }, 'Re-detecting recurring patterns failed; stored patterns kept');
}

await server.register(cors, {
  origin: true,
});

server.get('/health', async () => {
  return { status: 'ok' };
});

server.get('/backup', async (_request, reply) => {
  const ts = new Date().toISOString().slice(0, 10);
  const tmpPath = path.join(
    os.tmpdir(),
    'finance-backup-' + ts + '-' + Math.random().toString(16).slice(2) + '.sqlite'
  );
  try {
    db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}';`);
    const buf = fs.readFileSync(tmpPath);
    reply
      .header('content-type', 'application/x-sqlite3')
      .header('content-disposition', 'attachment; filename=finance-backup-' + ts + '.sqlite')
      .send(buf);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
  }
});

server.get('/transactions', async () => listTransactions());
server.get('/summary', async () => getSummary());
server.get('/data-status', async () => getDataStatus());
server.get('/insights', async () => getInsights());
server.get('/monthly', async () => getMonthlyOverview());
server.get('/raw', async () => listRaw());
server.get('/settings', async () => getSettings());
server.get('/accounts', async () => listAccounts());
server.post('/settings', async (request, reply) => {
  const body = request.body as any;
  const { payday, paydayFlexDays } = body ?? {};
  const paydayNum = Number(payday);
  const flexNum = Number(paydayFlexDays);
  if (!Number.isInteger(paydayNum) || paydayNum < 1 || paydayNum > 28) {
    return reply.code(400).send({ error: 'payday_invalid' });
  }
  if (!Number.isInteger(flexNum) || flexNum < 0 || flexNum > 7) {
    return reply.code(400).send({ error: 'flex_invalid' });
  }  updateSettings({ payday: paydayNum, paydayFlexDays: flexNum });
  return reply.send({ ok: true });
});

server.get('/log', async () => listLog(200));

server.post('/debug/clear', async () => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM change_sets;
    DELETE FROM rule_suggestions;
    DELETE FROM categorization_decisions;
    DELETE FROM category_rules;
    DELETE FROM categories;
    DELETE FROM transfer_links;
    DELETE FROM pending_transactions;
    DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions;
    DELETE FROM insight_findings;
    DELETE FROM briefing_sessions;
    DELETE FROM pattern_decisions;
    DELETE FROM recurring_patterns;
    DELETE FROM pattern_confirmations;
    DELETE FROM import_sessions;
    DELETE FROM accounts;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
  return { ok: true };
});

server.post('/debug/clear-imports', async () => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM rule_suggestions;
    DELETE FROM transfer_links;
    DELETE FROM balance_snapshots;
    DELETE FROM balance_adjustments;
    DELETE FROM categorization_decisions;
    DELETE FROM pending_transactions;
    DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions;
    DELETE FROM insight_findings;
    DELETE FROM briefing_sessions;
    DELETE FROM pattern_decisions;
    DELETE FROM recurring_patterns;
    DELETE FROM pattern_confirmations;
    DELETE FROM import_sessions;
  `);
  db.exec('PRAGMA foreign_keys=ON;');
  seedDefaultCategories();
  return { ok: true };
});

server.post<{
  Body: { counterparty?: string; description?: string; amount: number; currency: string };
}>('/ai/categorize', async (request, reply) => {
  const { counterparty, description, amount, currency } = request.body || {};
  if (amount === undefined || currency === undefined) {
    return reply.code(400).send({ error: 'missing_fields' });
  }
  const result = await aiCategorize({ counterparty, description, amount, currency });
  return reply.send(result);
});

server.patch('/accounts/:id', async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as Record<string, unknown>;

  const subtype = (body as any).account_subtype;
  if (subtype !== undefined && !['checking', 'savings', 'credit_card'].includes(subtype as string)) {
    return reply.code(400).send({ error: 'invalid_account_subtype' });
  }

  const allowed = ['account_subtype', 'owner_label', 'credit_limit', 'savings_goal', 'name'];
  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body) patch[key] = body[key];
  }
  const result = updateAccount(id, patch as any);
  if (result !== undefined && result.changes === 0) {
    return reply.code(404).send({ error: 'not_found' });
  }
  return { ok: true };
});

// Household summary
server.get('/household/summary', async () => getHouseholdSummary());

// Briefing endpoints
server.get('/briefing/latest', async (_request, reply) => {
  const session = db
    .prepare(`SELECT * FROM briefing_sessions ORDER BY created_at DESC LIMIT 1`)
    .get() as any;
  if (!session) return reply.code(404).send({ error: 'not_found' });

  const stored = db
    .prepare(
      `SELECT id, finding_type, title, description, severity, impact_eur, transaction_ids, metadata, created_at
       FROM insight_findings
       WHERE briefing_session_id = ? AND dismissed_at IS NULL
       ORDER BY
         CASE severity WHEN 'alert' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END ASC,
         impact_eur DESC`
    )
    .all(session.id) as any[];
  const findings = withoutAnsweredQuestions(stored);

  return {
    id: session.id,
    createdAt: session.created_at,
    importSessionId: session.import_session_id,
    findingCount: session.finding_count,
    findings: findings.map((f: any) => ({
      id: f.id,
      findingType: f.finding_type,
      title: f.title,
      description: f.description,
      severity: f.severity,
      impactEur: f.impact_eur ?? null,
      transactionIds: f.transaction_ids ? JSON.parse(f.transaction_ids) : [],
      metadata: f.metadata ? JSON.parse(f.metadata) : {},
      createdAt: f.created_at,
    })),
  };
});

server.get<{ Params: { id: string } }>('/briefing/:id', async (request, reply) => {
  const { id } = request.params;
  const session = db
    .prepare(`SELECT * FROM briefing_sessions WHERE id = ?`)
    .get(id) as any;
  if (!session) return reply.code(404).send({ error: 'not_found' });

  const findings = db
    .prepare(
      `SELECT id, finding_type, title, description, severity, impact_eur, transaction_ids, metadata, created_at
       FROM insight_findings
       WHERE briefing_session_id = ? AND dismissed_at IS NULL
       ORDER BY
         CASE severity WHEN 'alert' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END ASC,
         impact_eur DESC`
    )
    .all(id) as any[];

  return {
    id: session.id,
    createdAt: session.created_at,
    importSessionId: session.import_session_id,
    findingCount: session.finding_count,
    findings: findings.map((f: any) => ({
      id: f.id,
      findingType: f.finding_type,
      title: f.title,
      description: f.description,
      severity: f.severity,
      impactEur: f.impact_eur ?? null,
      transactionIds: f.transaction_ids ? JSON.parse(f.transaction_ids) : [],
      metadata: f.metadata ? JSON.parse(f.metadata) : {},
      createdAt: f.created_at,
    })),
  };
});

server.post<{ Params: { findingId: string } }>('/briefing/:findingId/dismiss', async (request, reply) => {
  const { findingId } = request.params;
  const now = new Date().toISOString();
  const result = db
    .prepare(`UPDATE insight_findings SET dismissed_at = ? WHERE id = ?`)
    .run(now, findingId) as { changes: number };
  if (result.changes === 0) return reply.code(404).send({ error: 'not_found' });
  return { ok: true };
});

server.get('/pattern-confirmations', async () => listPendingConfirmations());

server.post<{ Params: { id: string } }>('/pattern-confirmations/:id/confirm', async (request, reply) => {
  const { id } = request.params;
  try {
    confirmPatternConfirmation(id);
    return reply.send({ ok: true });
  } catch (err: any) {
    const status = err.message === 'not_found' ? 404 : err.message === 'pattern_exists' ? 409 : 500;
    return reply.code(status).send({ error: err.message });
  }
});

server.post<{ Params: { id: string } }>('/pattern-confirmations/:id/reject', async (request, reply) => {
  const { id } = request.params;
  try {
    rejectPatternConfirmation(id);
    return reply.send({ ok: true });
  } catch (err: any) {
    return reply.code(err.message === 'not_found' ? 404 : 500).send({ error: err.message });
  }
});

await server.register(routes);

const port = Number(process.env.PORT ?? 3001);
// Loopback by default: the API has no auth. Set HOST=0.0.0.0 only on a trusted network.
const host = process.env.HOST ?? '127.0.0.1';

await server.listen({ port, host });
