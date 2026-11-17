import { z } from 'zod';
import { patternDecisionFields, patternDecisionListFields } from '@finance-app/shared';
import { GLOSSARY_TERMS } from '../glossary/terms.generated.js';
import { APPEND_ONLY, READ_ONLY, defineTool, type ToolDefinition } from './types.js';

// Recurring patterns the app is unsure about, and the user's (or this agent's)
// answers (GLOSSARY.md, "Recurring question", "Pattern decision"). An answer is
// appended to the decision history under this server's actor; it changes how a
// pattern counts in the forecast and totals, never a transaction. Plus the
// glossary, so the agent uses the app's own words.

const ERROR_CODES =
  'Errors come back as "Finance API error <status>: {"error": <code>, "details": ...}": 400 invalid_request; ' +
  '404 not_found (no such pattern); 409 not_monthly_pattern (annual patterns are not decided here).';

export const patternTools: ToolDefinition[] = [
  defineTool({
    name: 'list_recurring_questions',
    title: 'Open "is this recurring?" questions',
    description:
      'Monthly or weekly patterns nobody has decided on yet that the app is unsure about ("Onko tämä toistuva?"), ' +
      'largest typical amount first. reasons: low_confidence (confidence below 0.75: the rhythm is not proven), ' +
      'fixed_amount_account_payment (the same amount to an IBAN every time: savings, rent or a person?), ' +
      'fixed_amount_card (the same amount by card every time: a subscription or e.g. savings?). Each item: ' +
      'patternId, accountId, counterparty, suggestedAnswer (what detection found), reasons, confidence (0-1) with ' +
      'confidenceFactors {charges, interval, amount}, established (already counted as a fixed cost while ' +
      'unanswered), typicalAmount (positive EUR), intervalDays, and evidence { chargeCount, firstDate, lastDate, ' +
      'smallestAmount, largestAmount (signed, expenses negative), amountFixed, paymentMethod (account_payment, card ' +
      'or mixed), transactions [{id, date, amount}] } - the charges the pattern rests on, which search_transactions ' +
      'can show in full. Answer with answer_recurring_question. A second content block { meta } tells how fresh ' +
      'the data is (generatedAt, lastImportAt, dataAsOf).',
    annotations: READ_ONLY,
    freshness: true,
    run: (_args, { api }) => api.get('/patterns/questions'),
  }),
  defineTool({
    name: 'answer_recurring_question',
    title: 'Answer an "is this recurring?" question',
    description:
      'Records what a monthly or weekly pattern is: recurring (a recurring cost that is not a subscription: a ' +
      'bill, savings, a payment to a person), subscription, or not_recurring (not a recurring cost: it leaves the ' +
      'forecast, the subscription total and the briefing, and is never asked about again). patternId comes from ' +
      'list_recurring_questions or list_recurring (any monthly/weekly pattern, also one not asked about). The ' +
      'decision is appended to the history under this server\'s actor (list_pattern_decisions) and survives ' +
      're-detection; a later answer replaces it, and repeating the current answer records nothing (recorded: ' +
      'false). Only the pattern\'s decision changes: transactions, amounts, categories, accounts and balances are ' +
      'never touched, and nothing is deleted. Answer only from what the user said or clear evidence. Returns ' +
      '{ pattern (with state, pattern_type, established, decided_by, decided_at), recorded }. ' +
      ERROR_CODES,
    inputSchema: {
      patternId: z.string().trim().min(1).max(100).describe('Pattern id (patternId or id)'),
      ...patternDecisionFields,
    },
    annotations: APPEND_ONLY,
    run: ({ patternId, decision }, { api }) =>
      api.post(`/patterns/${encodeURIComponent(patternId)}/decision`, { decision }),
  }),
  defineTool({
    name: 'list_pattern_decisions',
    title: 'Pattern decision history',
    description:
      'Every decision on a recurring pattern, newest first, from every actor (user = the web UI, hermes or ' +
      'another name = an agent). Each item: id, createdAt, patternId, accountId, counterparty, decision ' +
      '(recurring, subscription, not_recurring), actor, superseded (a newer decision on the same pattern replaced ' +
      'it). Returns { total, limit, offset, items }; page with limit/offset. A rejected pattern is left out of ' +
      'list_recurring; find it here to change the answer.',
    inputSchema: patternDecisionListFields,
    annotations: READ_ONLY,
    run: (args, { api }) => api.get('/patterns/decisions', args),
  }),
  defineTool({
    name: 'get_glossary',
    title: 'App glossary',
    description:
      'The terms the finance app uses and what each means, from its GLOSSARY.md: { terms: [{ term, summary (first ' +
      'sentence), definition (whole entry), avoid (words not to use for it, or null) }] }. One meaning per word: ' +
      'use these words with the user, e.g. "transfer" only for money between own accounts, "subscription" and ' +
      '"established pattern" as defined here.',
    annotations: READ_ONLY,
    run: async () => ({ source: 'GLOSSARY.md', terms: GLOSSARY_TERMS }),
  }),
];
