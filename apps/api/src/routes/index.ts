import type { FastifyPluginAsync } from 'fastify';
import { httpErrorHandler } from '../http/errors.js';
import { featureProposalRoutes } from './featureProposals.js';
import { transactionSearchRoutes } from './transactionSearch.js';

/**
 * Modular routes. New endpoints go into their own plugin file and are added here;
 * services throw `DomainError` / `ZodError` and the shared error handler maps them
 * to `{ error, details? }` responses. Legacy routes in index.ts are unaffected
 * because the handler is scoped to this plugin.
 */
export const routes: FastifyPluginAsync = async (app) => {
  app.setErrorHandler(httpErrorHandler);
  await app.register(transactionSearchRoutes);
  await app.register(featureProposalRoutes);
};
