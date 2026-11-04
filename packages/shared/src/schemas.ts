import { z } from 'zod';
import { containsSensitiveId } from './redaction.js';

// Reusable schema building blocks.

/** Calendar date as YYYY-MM-DD; rejects impossible dates such as 2026-02-30. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(
    (v) => {
      const d = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
    },
    { message: 'invalid_date' }
  );

export const SENSITIVE_ID_ERROR = 'contains_account_or_personal_id';

/**
 * Trimmed, length-limited text that must not contain account numbers or personal
 * ids. Use for any free text that may be published outside the app.
 */
export const publishableText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !containsSensitiveId(v), { message: SENSITIVE_ID_ERROR });
