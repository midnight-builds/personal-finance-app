import type { FastifyPluginAsync } from 'fastify';
import { balanceHistoryFields } from '@finance-app/shared';
import { balanceHistory } from '../balanceHistory.js';
import { queryParser } from '../http/query.js';

const parseQuery = queryParser(balanceHistoryFields);

export const balanceHistoryRoutes: FastifyPluginAsync = async (app) => {
  app.get('/balances/history', async (request) => balanceHistory(parseQuery(request.query)));
};
