import crypto from 'crypto';
import { parse } from 'csv-parse/sync';
import xlsx from 'xlsx';
import { db } from './db.js';
import { logEvent } from './logger.js';
import { chooseCategoryFor, upsertDecision } from './rules.js';
import { detectPatterns } from './patterns.js';
import { runBriefing } from './briefing.js';
import { generateRuleSuggestions } from './ruleSuggestions.js';
import { canonicalGroupOrder } from './sql/transactions.js';

export type ImportResult = {
  importSessionId: string;
  accountId: string;
  normalizedCount: number;
  rawCount: number;
  skippedCount: number;
  overlapDetected: boolean;
  alreadyImportedCount: number;
  briefingSessionId?: string;
};

type RecordValue = string | number | null | undefined;

export function parseAmount(value?: RecordValue): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const normalized = value
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const amount = Number(normalized);
  return Number.isNaN(amount) ? null : amount;
}

export function parseDate(value?: RecordValue): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (value && typeof value === 'object' && 'toISOString' in value) {
    try {
      return (value as Date).toISOString();
    } catch {
      // ignore
    }
  }
  if (typeof value === 'number') {
    const epoch = Date.UTC(1899, 11, 30);
    const date = new Date(epoch + value * 86400000);
    return date.toISOString();
  }
  if (value === 'Varaus') return null;

  const normalized = String(value).replace(/\./g, '/').replace(/-/g, '/');
  const parts = normalized.split('/');
  if (parts.length !== 3) return null;

  let year = Number(parts[0]);
  let month = Number(parts[1]);
  let day = Number(parts[2]);

  if (year < 100) {
    year += 2000;
  }

  if (year > 31 && month > 0 && day > 0) {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.toISOString();
  }

  const altDay = Number(parts[0]);
  const altMonth = Number(parts[1]);
  const altYear = Number(parts[2]);
  if (altYear > 31 && altMonth > 0 && altDay > 0) {
    const date = new Date(Date.UTC(altYear, altMonth - 1, altDay));
    return date.toISOString();
  }

  return null;
}

function createId(): string {
  return crypto.randomUUID();
}

function getField(record: Record<string, unknown>, key: string): RecordValue {
  if (record[key] !== undefined && record[key] !== null) return record[key] as RecordValue;
  const bomKey = `\ufeff${key}`;
  if (record[bomKey] !== undefined && record[bomKey] !== null) return record[bomKey] as RecordValue;
  return null;
}

function ensureAccount(accountName: string, accountIban: string, now: string): string {
  const accountRow = accountIban
    ? (db.prepare('SELECT * FROM accounts WHERE iban = ?').get(accountIban) as any)
    : (db.prepare('SELECT * FROM accounts WHERE name = ?').get(accountName) as any);

  const accountId = accountRow?.id ?? createId();
  if (!accountRow) {
    db.prepare(
      'INSERT INTO accounts (id, created_at, name, iban, type) VALUES (?, ?, ?, ?, ?)'
    ).run(accountId, now, accountName, accountIban || null, 'bank');
  }

  return accountId;
}

function extractIbanCandidates(records: Record<string, unknown>[]): string[] {
  const candidates: string[] = [];
  const fields = ['Maksaja', 'Maksunsaaja', 'Maksaja ', 'Maksunsaaja '];
  for (const record of records) {
    for (const field of fields) {
      const raw = getField(record, field);
      if (!raw || typeof raw !== 'string') continue;
      const compact = raw.replace(/\\s+/g, '');
      if (compact.startsWith('FI') && compact.length >= 10) {
        candidates.push(compact);
      }
    }
  }
  return candidates;
}

function mostFrequent(arr: string[]): string | null {
  if (arr.length === 0) return null;
  const counts = new Map<string, number>();
  for (const item of arr) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [item, count] of counts.entries()) {
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  }
  return best;
}

function accountNameFromFilename(filename: string, accountIban: string | null): string {
  const match = filename.match(/^(.*?)\\s*(FI[0-9 ]{6,})/i);
  if (match && match[1].trim()) {
    return match[1].trim();
  }
  if (accountIban) {
    return `Tili ${accountIban.slice(-4)}`;
  }
  return 'Nordea tili';
}

function inferAccount(records: Record<string, unknown>[], filename: string) {
  const ibanCandidates = extractIbanCandidates(records);
  const accountIban = mostFrequent(ibanCandidates);
  const accountName = accountNameFromFilename(filename, accountIban);
  return { accountIban: accountIban ?? '', accountName };
}

function normalizeString(input: string | null | undefined): string {
  return (input ?? '').trim().toLowerCase();
}

function eqIgnoreCase(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeIban(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^FI[0-9 ]{6,}$/i.test(value.trim());
}

function chooseCounterparty(record: Record<string, unknown>, amount: number): { name: string | null; iban: string | null } {
  const nameFields = [
    getField(record, 'Nimi'),
    getField(record, 'Otsikko'),
    getField(record, 'Viesti'),
  ]
    .filter((v) => typeof v === 'string' && v.trim().length > 0 && !looksLikeIban(v as string))
    .map((v) => (v as string).trim());

  const otherParty = amount < 0 ? getField(record, 'Maksunsaaja') : getField(record, 'Maksaja');
  const otherPartyStr = typeof otherParty === 'string' ? otherParty.trim() : '';

  const name = nameFields[0] || (looksLikeIban(otherPartyStr) ? null : otherPartyStr) || null;
  const iban = looksLikeIban(otherPartyStr) ? otherPartyStr.replace(/\s+/g, '') : null;

  return { name, iban };
}

function assignDuplicateGroup(txId: string, candidateId: string) {
  const candidate = db
    .prepare('SELECT transaction_group_id FROM normalized_transactions WHERE id = ?')
    .get(candidateId) as { transaction_group_id: string | null } | undefined;

  const current = db
    .prepare('SELECT transaction_group_id FROM normalized_transactions WHERE id = ?')
    .get(txId) as { transaction_group_id: string | null } | undefined;

  const groupId = candidate?.transaction_group_id ?? current?.transaction_group_id ?? createId();

  db.prepare('UPDATE normalized_transactions SET transaction_group_id = ? WHERE id IN (?, ?)')
    .run(groupId, txId, candidateId);

  // Ensure a corresponding transaction_groups row exists and choose canonical deterministically.
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO transaction_groups (id, created_at, canonical_transaction_id) VALUES (?, ?, NULL)'
  ).run(groupId, now);

  const canonical = db
    .prepare(
      `SELECT id FROM normalized_transactions WHERE transaction_group_id = ? ORDER BY ${canonicalGroupOrder()} LIMIT 1`
    )
    .get(groupId) as { id: string } | undefined;

  if (canonical?.id) {
    db.prepare('UPDATE transaction_groups SET canonical_transaction_id = ? WHERE id = ?').run(
      canonical.id,
      groupId
    );
  }
}

function dedupeInserted(ids: string[]) {
  for (const id of ids) {
    const row = db
      .prepare(
        'SELECT account_id, import_session_id, booking_date, amount, counterparty_name, description FROM normalized_transactions WHERE id = ?'
      )
      .get(id) as any;
    if (!row || !row.booking_date) continue;
    const candidates = db
      .prepare(
        `SELECT c.id
         FROM normalized_transactions c
         WHERE c.id != ?
           AND c.import_session_id != ?
           -- pair one-to-one: skip rows already matched by an earlier row of this import
           AND NOT EXISTS (
             SELECT 1 FROM normalized_transactions o
             WHERE c.transaction_group_id IS NOT NULL
               AND o.transaction_group_id = c.transaction_group_id
               AND o.import_session_id = ?
           )
           AND c.account_id = ?
           AND c.booking_date = ?
           AND c.amount = ?
           AND (c.counterparty_name = ? OR (c.counterparty_name IS NULL AND ? IS NULL))
         ORDER BY ${canonicalGroupOrder('c')}
         LIMIT 1`
      )
      .get(
        id,
        row.import_session_id,
        row.import_session_id,
        row.account_id,
        row.booking_date,
        row.amount,
        row.counterparty_name,
        row.counterparty_name
      ) as any;
    if (candidates) {
      assignDuplicateGroup(id, candidates.id);
    }
  }
}

function linkTransfers(ids: string[]) {
  for (const id of ids) {
    const row = db
      .prepare(
        'SELECT id, account_id, booking_date, amount FROM normalized_transactions WHERE id = ?'
      )
      .get(id) as any;
    if (!row) continue;
    const opposite = db
      .prepare(
        `SELECT id, booking_date\n         FROM normalized_transactions\n         WHERE account_id != ?\n           AND amount = ?\n           AND ABS(julianday(booking_date) - julianday(?)) <= 2\n         LIMIT 1`
      )
      .get(row.account_id, -row.amount, row.booking_date) as any;
    if (!opposite) continue;

    const existing = db
      .prepare(
        'SELECT id FROM transfer_links WHERE (from_transaction_id = ? AND to_transaction_id = ?) OR (from_transaction_id = ? AND to_transaction_id = ?)'
      )
      .get(row.id, opposite.id, opposite.id, row.id) as any;
    if (existing) continue;

    const fromId = row.amount < 0 ? row.id : opposite.id;
    const toId = row.amount < 0 ? opposite.id : row.id;
    db.prepare(
      'INSERT INTO transfer_links (id, created_at, from_transaction_id, to_transaction_id, confidence) VALUES (?, ?, ?, ?, ?)'
    ).run(createId(), new Date().toISOString(), fromId, toId, 90);
  }
}

export async function processImport(options: {
  records: Record<string, unknown>[];
  checksum: string;
  filename: string;
  accountName?: string;
  accountIban?: string;
  sourceBank: string;
  format: string;
}): Promise<ImportResult> {
  const { records, checksum, filename, sourceBank, format } = options;
  const inferred = inferAccount(records, filename);
  const accountName = options.accountName ?? inferred.accountName;
  const accountIban = options.accountIban ?? inferred.accountIban;
  const rowCount = records.length;
  const overlapKey = `${checksum}:${rowCount}:${accountIban}`;

  const overlapRow = db
    .prepare('SELECT id, row_count FROM import_sessions WHERE overlap_key = ?')
    .get(overlapKey) as { id: string; row_count: number } | undefined;

  const now = new Date().toISOString();
  const accountId = ensureAccount(accountName, accountIban, now);

  const importSessionId = createId();
  db.prepare(
    'INSERT INTO import_sessions (id, created_at, source_bank, format, file_checksum, row_count, overlap_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(importSessionId, now, sourceBank, format, checksum, rowCount, overlapKey);

  logEvent({
    type: 'import.start',
    scope: importSessionId,
    message: `Import ${format} ${sourceBank} rows=${rowCount}`,
    payload: { checksum, rowCount, overlapDetected: Boolean(overlapRow) },
  });

  let normalizedCount = 0;
  let skippedCount = 0;
  const insertedIds: string[] = [];

  const insertRaw = db.prepare(
    'INSERT INTO raw_transactions (id, created_at, import_session_id, data, booking_date, amount, currency) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const insertNormalized = db.prepare(
    'INSERT INTO normalized_transactions (id, created_at, raw_transaction_id, import_session_id, account_id, booking_date, transaction_date, amount, currency, counterparty_name, description, counterparty_iban, transaction_group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertBalance = db.prepare(
    'INSERT OR REPLACE INTO balance_snapshots (id, created_at, account_id, date, balance, currency) VALUES (?, ?, ?, ?, ?, ?)'
  );

  // A day's snapshot is its closing balance: the Saldo of the day's last row
  // in time. Nordea lists newest first, so then that is the day's first row in
  // the file. An export whose dates ascend is read the other way round.
  const bookedDates = records
    .map((r) => parseDate(getField(r, 'Kirjauspäivä')))
    .filter((d): d is string => d !== null);
  const newestFirst = bookedDates.length === 0 || bookedDates[0] >= bookedDates[bookedDates.length - 1];
  const closingBalances = new Map<string, { saldo: number; currency: string }>();

  db.exec('BEGIN');
  try {
    for (const record of records) {
      const bookingDate = parseDate(getField(record, 'Kirjauspäivä'));
      const amount = parseAmount(getField(record, 'Määrä'));
      const currency = (getField(record, 'Valuutta') as string) || 'EUR';
      const saldoRaw = getField(record, 'Saldo');
      const saldo = parseAmount(saldoRaw);

      const rawId = createId();
      insertRaw.run(
        rawId,
        now,
        importSessionId,
        JSON.stringify(record),
        bookingDate,
        amount,
        currency
      );

      if (amount === null) {
        skippedCount += 1;
        continue;
      }

      const { name: counterparty, iban: counterpartyIban } = chooseCounterparty(record, amount);

      const descriptionParts = [getField(record, 'Otsikko'), getField(record, 'Viesti')]
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
        .map((value) => String(value).trim());

      let filteredParts = descriptionParts;
      if (counterparty) {
        filteredParts = filteredParts.filter((p) => !eqIgnoreCase(p, counterparty));
      }

      let description = filteredParts.join(' | ');

      if (counterparty && description.toLowerCase().startsWith(counterparty.toLowerCase())) {
        const pattern = new RegExp(`^\\s*${escapeRegex(counterparty)}\\s*[|,:-]?\\s*`, 'i');
        description = description.replace(pattern, '').trim();
      }

      if (description && counterparty && normalizeString(description) === normalizeString(counterparty)) {
        description = '';
      }

      const normalizedId = createId();
      insertNormalized.run(
        normalizedId,
        now,
        rawId,
        importSessionId,
        accountId,
        bookingDate,
        bookingDate,
        amount,
        currency,
        counterparty || null,
        description || null,
        counterpartyIban || null,
        null
      );

      if (saldo !== null && bookingDate && !(newestFirst && closingBalances.has(bookingDate))) {
        closingBalances.set(bookingDate, { saldo, currency });
      }

      const categoryId = chooseCategoryFor({
        counterparty: counterparty || '',
        description: description || '',
        amount,
      });
      if (categoryId) {
        upsertDecision({ transactionId: normalizedId, categoryId, source: 'rule' });
      }

      insertedIds.push(normalizedId);
      normalizedCount += 1;
    }

    for (const [day, { saldo, currency }] of closingBalances) {
      insertBalance.run(createId(), now, accountId, day, saldo, currency);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    logEvent({ type: 'import.error', scope: importSessionId, message: 'Import failed', payload: { error: String(error) } });
    throw error;
  }

  // Post-processing: dedupe and transfer linking
  dedupeInserted(insertedIds);
  linkTransfers(insertedIds);

  // Hook patterns and briefing into import pipeline
  let briefingSessionId: string | undefined;
  try {
    detectPatterns(accountId);
    briefingSessionId = await runBriefing(importSessionId);
  } catch (err) {
    logEvent({ type: 'import.warning', scope: importSessionId, message: 'Briefing failed', payload: { error: String(err) } });
  }

  // Fire-and-forget: non-blocking AI rule suggestions
  generateRuleSuggestions().catch((err) => {
    console.error('[importer] generateRuleSuggestions failed:', err);
  });

  logEvent({
    type: 'import.done',
    scope: importSessionId,
    message: `Imported ${normalizedCount} rows (skipped ${skippedCount})`,
    payload: { normalizedCount, skippedCount, overlapDetected: Boolean(overlapRow), alreadyImportedCount: overlapRow?.row_count ?? 0 },
  });

  return {
    importSessionId,
    accountId,
    normalizedCount,
    rawCount: rowCount,
    skippedCount,
    overlapDetected: Boolean(overlapRow),
    alreadyImportedCount: overlapRow?.row_count ?? 0,
    briefingSessionId,
  };
}

export function parseCsv(fileBuffer: Buffer): Record<string, unknown>[] {
  return parse(fileBuffer, {
    delimiter: ';',
    columns: true,
    skip_empty_lines: true,
    bom: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, unknown>[];
}

export function parseXlsx(fileBuffer: Buffer): Record<string, unknown>[] {
  const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: false,
  });
}

export function checksum(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
