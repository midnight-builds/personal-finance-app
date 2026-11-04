import type { FastifyPluginAsync } from 'fastify';
import { transactionSearchFields } from '@finance-app/shared';
import { queryParser } from '../http/query.js';
import { searchTransactions } from '../transactionSearch.js';

const parseSearchQuery = queryParser(transactionSearchFields);

export const transactionSearchRoutes: FastifyPluginAsync = async (app) => {
  app.get('/transactions/search', async (request) => searchTransactions(parseSearchQuery(request.query)));
};
