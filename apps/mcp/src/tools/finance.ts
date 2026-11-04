import { transactionSearchFields } from '@finance-app/shared';
import { ApiError } from '../apiClient.js';
import { READ_ONLY, defineTool, type ToolDefinition } from './types.js';

// Read-only access to finance data via the REST API.

/** A parameterless tool that returns one GET endpoint as-is. */
function readEndpoint(name: string, title: string, description: string, path: string): ToolDefinition {
  return defineTool({ name, title, description, annotations: READ_ONLY, run: (_args, { api }) => api.get(path) });
}

const FRESHNESS_NOTE =
  ' A second content block { meta } tells how fresh the data is: generatedAt (response time), ' +
  'lastImportAt (latest bank import) and dataAsOf (latest booking date, YYYY-MM-DD); timestamps are ISO 8601 UTC.';

/** Marks a tool as backed by imported bank data, so its response carries a `meta` freshness block. */
function withFreshness(tool: ToolDefinition, extra?: (data: unknown) => Record<string, unknown>): ToolDefinition {
  return { ...tool, description: tool.description + FRESHNESS_NOTE, freshness: extra ?? true };
}

/** First forecast month, so the agent need not infer it from its own clock. */
function forecastStart(data: unknown): Record<string, unknown> {
  const first = Array.isArray(data) ? (data[0] as { targetMonth?: unknown } | undefined) : undefined;
  return { forecastStartMonth: typeof first?.targetMonth === 'string' ? first.targetMonth : null };
}

const dataTools: ToolDefinition[] = [
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
    'Total balance, monthly net (with and without transfers), runway in months and per-account balances. ' +
      'Every account is listed; an account without balance data has balance null (unknown, not zero). ' +
      'totalBalance and runwayMonths cover known balances only: when isComplete is false they are partial ' +
      'and missingBalanceAccountCount says how many accounts are missing.',
    '/summary'
  ),
  readEndpoint('get_monthly_overview', 'Monthly overview', 'Income, expense and net per month, transfers excluded.', '/monthly'),
  readEndpoint(
    'get_insights',
    'Insights',
    'Current deterministic insights (spikes, drift, recurring drains) with linked transaction ids.',
    '/insights'
  ),
  defineTool({
    name: 'get_latest_briefing',
    title: 'Latest briefing',
    description:
      'Most recent briefing with findings, severity and impact in EUR. Always returns { status, briefing }: ' +
      'status "ok" with the briefing, or "not_generated" with briefing null when none exists yet ' +
      '(normal before the first import). Other failures are errors.',
    annotations: READ_ONLY,
    run: async (_args, { api }) => {
      try {
        return { status: 'ok', briefing: await api.get('/briefing/latest') };
      } catch (err) {
        // The API answers 404 { error: 'not_found' } when no briefing exists; any
        // other 404 (e.g. route missing) is a real failure.
        if (err instanceof ApiError && err.status === 404 && (err.body as { error?: unknown })?.error === 'not_found') {
          return { status: 'not_generated', briefing: null };
        }
        throw err;
      }
    },
  }),
  withFreshness(
    readEndpoint(
      'get_forecast',
      'Forecast',
      'Forecast of upcoming months based on recurring and annual patterns. meta.forecastStartMonth is the first ' +
        'forecast month (YYYY-MM).',
      '/forecast'
    ),
    forecastStart
  ),
  readEndpoint('list_accounts', 'Accounts', 'Accounts with type, owner label and latest balance.', '/accounts'),
  readEndpoint(
    'list_recurring',
    'Recurring payments',
    'Active recurring patterns (subscriptions, monthly and annual payments).',
    '/recurring'
  ),
];

export const financeTools: ToolDefinition[] = [
  ...dataTools.map((tool) => (tool.freshness ? tool : withFreshness(tool))),
  readEndpoint('list_categories', 'Categories', 'All spending categories (id + name).', '/categories'),
];
