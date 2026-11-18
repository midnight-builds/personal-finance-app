import { balanceHistoryFields, transactionSearchFields } from '@finance-app/shared';
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
      'Transfers between own accounts are excluded by default. Each transaction is stored once, ' +
      'also when overlapping exports are imported. ' +
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
  readEndpoint(
    'get_monthly_overview',
    'Monthly overview',
    'Income, expense and net per pay period, oldest first. A period is labelled by its month but is not the ' +
      'calendar month: it follows the payday setting, and from/to give its inclusive bookingDate range ' +
      '(bank booking days, no time zone). Same scope as search_transactions by default (booked only, ' +
      'transfers excluded), so searching with the same from/to gives the same totals.',
    '/monthly'
  ),
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
      'Forecast of upcoming months based on recurring and annual patterns. Per month: knownFixed (established ' +
        'monthly/weekly patterns: confirmed, or confidence >= 0.75) with knownFixedTotal; uncertainRecurring ' +
        '(unconfirmed patterns below 0.75, maybe fixed costs) with uncertainRecurringTotal; lapsedRecurring ' +
        '(patterns with no charge for two periods, counted on the account\'s latest booking: lapsed true, ' +
        'lapsedSince; in no total until a charge comes again); annualItems; ' +
        'each pattern item\'s amount is its charges in that calendar month (chargesInMonth: 1 monthly, 4 or 5 ' +
        'weekly) times its typical amount; ' +
        'historicalAvg (same month in earlier years); projectedTotal = max(historicalAvg, knownFixedTotal) + annual ' +
        'items, and projectedTotalWithUncertain as if every uncertain pattern were a fixed cost. Patterns the user ' +
        'rejected are left out. meta.forecastStartMonth is the first forecast month (YYYY-MM).',
      '/forecast'
    ),
    forecastStart
  ),
  defineTool({
    name: 'get_balance_history',
    title: 'Balance and net worth history',
    description:
      'Account balances, assets, liabilities (credit card debt) and net worth at the end of each day, week ' +
      '(Sunday) or month between from and to, read from the balances the bank exports report. A balance is null ' +
      '(unknown, never zero) before an account’s first balance, after the last day its imported data covers, and when ' +
      'bookings came after its last balance; such a point has isComplete false and coverage.missingAccountIds lists ' +
      'the accounts left out of net worth (totals are null when no account is known). ' +
      'untrackedAssetClasses (e.g. investments) are never included. Transfers between own accounts do not change net worth.',
    inputSchema: balanceHistoryFields,
    annotations: READ_ONLY,
    run: (args, { api }) => api.get('/balances/history', args),
  }),
  readEndpoint('list_accounts', 'Accounts', 'Accounts with type, owner label and latest balance.', '/accounts'),
  readEndpoint(
    'list_recurring',
    'Recurring payments',
    'Active recurring patterns (subscriptions, monthly and annual payments), the user\'s decisions applied: ' +
      'pattern_type is the decided type when there is one (detected_type is what detection found), state is ' +
      'unconfirmed, confirmed_recurring or confirmed_subscription, user_confirmed 1 when confirmed, confidence ' +
      '(0-1) with confidence_factors, established (counts as a fixed cost and, as a subscription, in the ' +
      'subscription total, unless lapsed), decided_by and decided_at, origin (detected, or created by an actor ' +
      'with create_recurring_pattern: created_by, evidence_transaction_ids), lapsed with lapsed_since (no charge ' +
      'for two periods, counted on the account\'s latest booking: kept and listed, but counted nowhere until a ' +
      'charge comes again), monthly_amount (a month at the typical amount: weekly ones 52/12 charges). Patterns ' +
      'the user rejected are not listed ' +
      '(list_pattern_decisions has them). The id is the patternId of answer_recurring_question.',
    '/recurring'
  ),
];

export const financeTools: ToolDefinition[] = [
  ...dataTools.map((tool) => (tool.freshness ? tool : withFreshness(tool))),
  readEndpoint(
    'list_categories',
    'Categories',
    'Spending categories in use: id, name, built_in and role. A role marks a special category whatever it is ' +
      'named: fallback (where uncategorized transactions and those of archived categories go), income, refund; ' +
      'null for others. A role category can be renamed but not archived. Archived categories are not listed: they ' +
      'are out of use but keep their past decisions (categories are never deleted). Use these ids in ' +
      'plan_categorization.',
    '/categories'
  ),
];
