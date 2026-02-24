import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { initDb, seedDefaultCategories, db } from './db.js';
import { checksum, parseCsv, parseXlsx, processImport } from './importer.js';
import { listTransactions } from './query.js';
import { listCategories, upsertDecision, createCategory, renameCategory, deleteCategory } from './rules.js';
import { getSummary } from './summary.js';
import { getInsights } from './insights.js';
import { aiCategorize } from './ai.js';
import { getMonthlyOverview } from './monthly.js';
import { listRaw } from './raw.js';
import { getSettings, updateSettings } from './settings.js';
import { listLog } from './logger.js';
import { listAccounts } from './accounts.js';
import { listBalanceAdjustments, createBalanceAdjustment, deleteBalanceAdjustment } from './balanceAdjustments.js';

initDb();
seedDefaultCategories();

const server = Fastify({ logger: true });

await server.register(cors, {
  origin: true,
});

await server.register(multipart, {
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
});

server.get('/health', async () => {
  return { status: 'ok' };
});

server.get('/backup', async (_request, reply) => {
  const ts = new Date().toISOString().slice(0, 10);
  const tmpPath = path.join(
    os.tmpdir(),
    'finance-backup-' + ts + '-' + Math.random().toString(16).slice(2) + '.db'
  );
  try {
    db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}';`);
    const buf = fs.readFileSync(tmpPath);
    reply
      .header('content-type', 'application/x-sqlite3')
      .header('content-disposition', 'attachment; filename=finance-backup-' + ts + '.db')
      .send(buf);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
  }
});

async function readUpload(request: any) {
  const parts = request.parts();
  let fileBuffer: Buffer | null = null;
  let fileName = '';

  for await (const part of parts) {
    if (part.type === 'file') {
      fileBuffer = await part.toBuffer();
      fileName = part.filename;
    }
  }

  if (!fileBuffer) {
    return { error: 'file_missing' } as const;
  }

  return { fileBuffer, fileName } as const;
}

server.post('/imports/nordea/csv', async (request, reply) => {
  const upload = await readUpload(request);
  if ('error' in upload) return reply.code(400).send({ error: upload.error });

  const records = parseCsv(upload.fileBuffer);
  const result = processImport({
    records,
    checksum: checksum(upload.fileBuffer),
    filename: upload.fileName,
    sourceBank: 'Nordea',
    format: 'CSV',
  });

  return reply.send(result);
});

server.post('/imports/nordea/xlsx', async (request, reply) => {
  const upload = await readUpload(request);
  if ('error' in upload) return reply.code(400).send({ error: upload.error });

  const records = parseXlsx(upload.fileBuffer);
  const result = processImport({
    records,
    checksum: checksum(upload.fileBuffer),
    filename: upload.fileName,
    sourceBank: 'Nordea',
    format: 'XLSX',
  });

  return reply.send(result);
});

server.get('/transactions', async () => listTransactions());
server.get('/categories', async () => listCategories());
server.get('/summary', async () => getSummary());
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

// Balance adjustments (saldo-oikaisut)
server.get("/balance-adjustments", async () => listBalanceAdjustments());
server.post("/balance-adjustments", async (request, reply) => {
  const body = request.body as any;
  const { accountId, date, amount, reason } = body ?? {};
  if (!accountId || typeof accountId !== "string") return reply.code(400).send({ error: "account_missing" });
  if (!date || typeof date !== "string") return reply.code(400).send({ error: "date_missing" });
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum)) return reply.code(400).send({ error: "amount_invalid" });
  const created = createBalanceAdjustment({ accountId, date, amount: amountNum, reason: reason ?? null });
  return reply.send(created);
});
server.delete("/balance-adjustments/:id", async (request, reply) => {
  const id = (request.params as any)?.id as string;
  if (!id) return reply.code(400).send({ error: "id_missing" });
  const ok = deleteBalanceAdjustment(id);
  if (!ok) return reply.code(404).send({ error: "not_found" });
  return reply.send({ ok: true });
});
server.post<{ Params: { id: string }; Body: { categoryId: string } }>(
  '/transactions/:id/category',
  async (request, reply) => {
    const { id } = request.params;
    const { categoryId } = request.body || {};
    if (!categoryId) return reply.code(400).send({ error: 'category_missing' });
    const tx = db
      .prepare('SELECT counterparty_name, description FROM normalized_transactions WHERE id = ?')
      .get(id) as { counterparty_name: string | null; description: string | null } | undefined;
    upsertDecision({
      transactionId: id,
      categoryId,
      source: 'user',
      counterparty: tx?.counterparty_name ?? null,
      description: tx?.description ?? null,
    });
    return reply.send({ ok: true });
  }
);

server.post('/debug/clear', async () => {
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(`
    DELETE FROM categorization_decisions;
    DELETE FROM category_rules;
    DELETE FROM categories;
    DELETE FROM transfer_links;
    DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions;
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
    DELETE FROM transfer_links;
    DELETE FROM balance_snapshots;
    DELETE FROM balance_adjustments;
    DELETE FROM categorization_decisions;
    DELETE FROM normalized_transactions;
    DELETE FROM raw_transactions;
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

server.patch<{ Params: { id: string }; Body: { name: string } }>(
  '/accounts/:id',
  async (request, reply) => {
    const { id } = request.params;
    const { name } = request.body || {};
    if (!name || !name.trim()) return reply.code(400).send({ error: 'name_required' });
    const updated = db
      .prepare('UPDATE accounts SET name = ? WHERE id = ?')
      .run(name.trim(), id);
    if (updated.changes === 0) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ ok: true });
  }
);

server.post('/categories', async (request, reply) => {
  const body = request.body as any;
  const { name } = body ?? {};
  try {
    const created = createCategory(String(name ?? ''));
    return reply.send(created);
  } catch (err: any) {
    const msg = err?.message ?? 'unknown';
    const status = msg === 'name_exists' || msg === 'name_required' ? 400 : 400;
    return reply.code(status).send({ error: msg });
  }
});

server.patch<{ Params: { id: string }; Body: { name: string } }>('/categories/:id', async (request, reply) => {
  const { id } = request.params;
  const { name } = request.body || {};
  try {
    renameCategory(id, name);
    return reply.send({ ok: true });
  } catch (err: any) {
    const msg = err?.message ?? 'unknown';
    const status = msg === 'name_exists' || msg === 'name_required' || msg === 'reserved_name' ? 400 : 404;
    return reply.code(status).send({ error: msg });
  }
});

server.delete<{ Params: { id: string } }>('/categories/:id', async (request, reply) => {
  const { id } = request.params;
  try {
    const res = deleteCategory(id);
    return reply.send({ ok: true, reassignedTo: res.reassignedTo });
  } catch (err: any) {
    const msg = err?.message ?? 'unknown';
    const status = msg === 'cannot_delete_misc' ? 400 : 404;
    return reply.code(status).send({ error: msg });
  }
});

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';

await server.listen({ port, host });
