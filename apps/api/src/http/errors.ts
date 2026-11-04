import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/**
 * An expected failure with a stable, machine-readable code, e.g. `not_found`.
 * Thrown from services; turned into an HTTP response by `httpErrorHandler`.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly details?: unknown
  ) {
    super(code);
    this.name = 'DomainError';
  }

  static notFound() {
    return new DomainError('not_found', 404);
  }

  static conflict(code: string) {
    return new DomainError(code, 409);
  }
}

export function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

/** Error body shape: `{ error: <code>, details?: unknown }`. */
export function httpErrorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof DomainError) {
    return reply.code(error.statusCode).send({ error: error.code, details: error.details });
  }
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: 'invalid_request', details: formatZodIssues(error) });
  }
  const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
  if (statusCode >= 500) {
    request.log.error(error);
    return reply.code(500).send({ error: 'internal_error' });
  }
  // Fastify's own client errors (malformed JSON, body too large, …): keep the status,
  // expose a stable code instead of framework-internal FST_ERR_* names.
  return reply.code(statusCode).send({ error: statusCode === 413 ? 'body_too_large' : 'bad_request' });
}
