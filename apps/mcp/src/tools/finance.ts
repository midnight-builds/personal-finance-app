import { transactionSearchFields } from '@finance-app/shared';
import { READ_ONLY, defineTool, type ToolDefinition } from './types.js';

// Read-only access to finance data via the REST API.

/** A parameterless tool that returns one GET endpoint as-is. */
function readEndpoint(name: string, title: string, description: string, path: string): ToolDefinition {
  return defineTool({ name, title, description, annotations: READ_ONLY, run: (_args, { api }) => api.get(path) });
}

export const financeTools: ToolDefinition[] = [
  defineTool({
    name: 'search_transactions',
    title: 'Search transactions',
    description:
      'Search normalized bank transactions. Amounts are signed (negative = expense). ' +
      'Transfers between own accounts and duplicates from overlapping imports are excluded by default. ' +
      'Returns { total, limit, offset, items }; page with limit/offset.',
    inputSchema: transactionSearchFields,
    annotations: READ_ONLY,
    run: (args, { api }) => api.get('/transactions/search', args),
  }),
  readEndpoint(
    'get_summary',
    'Financial summary',
    'Total balance, monthly net (with and without transfers), runway in months and per-account balances.',
    '/summary'
  ),
  readEndpoint('get_monthly_overview', 'Monthly overview', 'Income, expense and net per month, transfers excluded.', '/monthly'),
  readEndpoint(
    'get_insights',
    'Insights',
    'Current deterministic insights (spikes, drift, recurring drains) with linked transaction ids.',
    '/insights'
  ),
  readEndpoint('get_latest_briefing', 'Latest briefing', 'Most recent briefing with findings, severity and impact in EUR.', '/briefing/latest'),
  readEndpoint('get_forecast', 'Forecast', 'Forecast of upcoming months based on recurring and annual patterns.', '/forecast'),
  readEndpoint('list_categories', 'Categories', 'All spending categories (id + name).', '/categories'),
  readEndpoint('list_accounts', 'Accounts', 'Accounts with type, owner label and latest balance.', '/accounts'),
  readEndpoint(
    'list_recurring',
    'Recurring payments',
    'Active recurring patterns (subscriptions, monthly and annual payments).',
    '/recurring'
  ),
];
