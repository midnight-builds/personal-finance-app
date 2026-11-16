import type { FastifyRequest } from 'fastify';

const ACTOR = /^[a-z0-9_-]{1,40}$/;

/**
 * Who makes the request, as the client names it in `X-Finance-Actor` (`user`
 * when missing or malformed). Trusted, not authenticated: see
 * docs/adr/0001-actor-without-authentication.md.
 */
export function actorOf(request: Pick<FastifyRequest, 'headers'>): string {
  const value = request.headers['x-finance-actor'];
  return typeof value === 'string' && ACTOR.test(value) ? value : 'user';
}
