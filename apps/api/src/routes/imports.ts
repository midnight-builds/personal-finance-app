import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { importPreviewFieldsSchema, importTargetFieldsSchema } from '@finance-app/shared';
import { DomainError } from '../http/errors.js';
import { checksum, parseCsv, parseXlsx, processImport, type ImportTarget } from '../importer.js';
import { previewImport } from '../importPreview.js';

type Upload = { fileBuffer: Buffer; fileName: string; fields: Record<string, string> };

/** The file part and the text fields of a multipart upload, in whichever order they come. */
async function readUpload(request: FastifyRequest): Promise<Upload> {
  let fileBuffer: Buffer | null = null;
  let fileName = '';
  const fields: Record<string, string> = {};
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      // Consumed here: the stream must be drained before the next part arrives.
      fileBuffer = await part.toBuffer();
      fileName = part.filename;
    } else if (typeof part.value === 'string' && part.value.trim() !== '') {
      fields[part.fieldname] = part.value;
    }
  }
  if (!fileBuffer) throw new DomainError('file_missing', 400);
  return { fileBuffer, fileName, fields };
}

const isXlsx = (fileName: string) => fileName.toLowerCase().endsWith('.xlsx');

function targetOf(fields: Record<string, string>): ImportTarget | undefined {
  const parsed = importTargetFieldsSchema.parse(fields);
  if (parsed.accountId) return { accountId: parsed.accountId };
  if (parsed.newAccountName) return { newAccount: { name: parsed.newAccountName, subtype: parsed.newAccountSubtype! } };
  return undefined;
}

/**
 * Nordea uploads. `preview` writes nothing and tells where the file would go
 * and what it would do; the import routes take the user's choice of account.
 */
export const importRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });

  app.post('/imports/nordea/preview', async (request) => {
    const upload = await readUpload(request);
    const { accountId } = importPreviewFieldsSchema.parse(upload.fields);
    const xlsx = isXlsx(upload.fileName);
    return previewImport({
      records: xlsx ? parseXlsx(upload.fileBuffer) : parseCsv(upload.fileBuffer),
      checksum: checksum(upload.fileBuffer),
      filename: upload.fileName,
      format: xlsx ? 'XLSX' : 'CSV',
      accountId,
    });
  });

  for (const format of ['csv', 'xlsx'] as const) {
    app.post(`/imports/nordea/${format}`, async (request) => {
      const upload = await readUpload(request);
      const target = targetOf(upload.fields);
      return processImport({
        records: format === 'xlsx' ? parseXlsx(upload.fileBuffer) : parseCsv(upload.fileBuffer),
        checksum: checksum(upload.fileBuffer),
        filename: upload.fileName,
        sourceBank: 'Nordea',
        format: format.toUpperCase(),
        target,
      });
    });
  }
};
