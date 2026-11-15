import type { FastifyRequest } from 'fastify';
import { ACTOR_HEADER, ACTOR_PATTERN } from '@finance-app/shared';

/**
 * Who makes the request, as the client names it in `X-Finance-Actor` (`user`
 * when missing or malformed). Trusted, not authenticated: see
 * docs/adr/0001-actor-without-authentication.md.
 */
export function actorOf(request: Pick<FastifyRequest, 'headers'>): string {
  const value = request.headers[ACTOR_HEADER];
  return typeof value === 'string' && ACTOR_PATTERN.test(value) ? value : 'user';
}
