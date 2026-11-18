import { z } from 'zod';
import { patternCreateFields, patternDecisionFields, patternDecisionListFields } from '@finance-app/shared';
import { GLOSSARY_TERMS } from '../glossary/terms.generated.js';
import { APPEND_ONLY, READ_ONLY, defineTool, type ToolDefinition } from './types.js';

// Recurring patterns the app is unsure about, and the user's (or this agent's)
// answers (GLOSSARY.md, "Recurring question", "Pattern decision"). An answer is
// appended to the decision history under this server's actor; it changes how a
// pattern counts in the forecast and totals, never a transaction. The agent may
// also create a pattern detection never proposed ("Created pattern"). Plus the
// glossary, so the agent uses the app's own words.

const ERROR_CODES =
  'Errors come back as "Finance API error <status>: {"error": <code>, "details": ...}": 400 invalid_request; ' +
  '404 not_found (no such pattern); 409 not_monthly_pattern (annual patterns are not decided here).';

export const patternTools: ToolDefinition[] = [
  defineTool({
    name: 'list_recurring_questions',
    title: 'Open "is this recurring?" questions',
    description:
      'Uncertain monthly or weekly patterns ("Onko tämä toistuva?"): nobody has decided on them and their ' +
      'confidence is below 0.75, so they are not counted as fixed costs. Largest typical amount first. Established ' +
      'patterns (confidence >= 0.75) need no confirmation and are not listed; decided and rejected ones never are. ' +
      'reasons: always low_confidence, plus a hint when the amount is the same every time: ' +
      'fixed_amount_account_payment (to an IBAN every time: savings, rent or a person?) or fixed_amount_card ' +
      '(a subscription or e.g. savings?). Each item: patternId, accountId, counterparty, suggestedAnswer (what ' +
      'detection found), reasons, confidence (0-1) with confidenceFactors {charges, interval, amount}, ' +
      'typicalAmount (positive EUR), intervalDays, and evidence { chargeCount, firstDate, lastDate, ' +
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
      'list_recurring_questions or list_recurring: any active monthly/weekly pattern, also an established one ' +
      'never asked about (e.g. reject a confident pattern that is really savings or a one-off series). The ' +
      'decision is appended to the history under this server\'s actor (list_pattern_decisions) and survives ' +
      're-detection; a later answer replaces it, and repeating the current answer records nothing (recorded: ' +
      'false). Any decision may be replaced, also one the user made: the latest counts, and the history keeps every ' +
      'one with its actor. reset takes the decision back: the pattern is unconfirmed again and counted by its ' +
      'confidence; a created pattern (origin created) is then left out until its own charges reach 0.75. ' +
      'Only the pattern\'s decision changes: transactions, amounts, categories, accounts and balances are ' +
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
    name: 'create_recurring_pattern',
    title: 'Create a recurring pattern',
    description:
      'Adds a monthly or weekly pattern that detection never proposed, e.g. a contract that started last month: ' +
      'one charge is enough as evidence. Cite the charges by id (search_transactions); each must be a booked ' +
      'expense of that account and counterparty, not a transfer, within 20 % of expectedAmount, and charges at ' +
      'least 5 (weekly) or 20 (monthly) days apart. The pattern is confirmed at once as kind (a pattern decision ' +
      'under this server\'s actor, in list_pattern_decisions) and counts like any confirmed pattern: a fixed cost ' +
      'in the forecast and, as a subscription, in the subscription total. Its origin is created and created_by ' +
      'is this server\'s actor. Later charges of the counterparty near expectedAmount attach to it; detection ' +
      'never deactivates, retypes or re-prices it, and when detection finds the same pattern it stays one ' +
      'pattern. Change or reject it with answer_recurring_question; reset withdraws it (left out until its own ' +
      'charges reach confidence 0.75). Writes only the pattern and its decision: transactions, amounts, ' +
      'categories, accounts and balances are never touched, and nothing is deleted. Create one only from what ' +
      'the user said or clear evidence. Returns { pattern, created }; the same request again returns the ' +
      'pattern with created: false. Errors come back as "Finance API error <status>: {"error": <code>, ' +
      '"details": ...}": 400 invalid_request, evidence_not_found, evidence_duplicate, evidence_other_account, ' +
      'evidence_not_booked, evidence_transfer, evidence_not_charge (income), evidence_other_counterparty, ' +
      'evidence_currency_mismatch, evidence_amount_mismatch, evidence_interval_mismatch (details name the ' +
      'transactionIds); 404 account_not_found; 409 pattern_exists (details.patternId: the account already has ' +
      'an active pattern for the counterparty: decide it with answer_recurring_question instead).',
    inputSchema: patternCreateFields,
    annotations: APPEND_ONLY,
    run: (args, { api }) => api.post('/patterns', args),
  }),
  defineTool({
    name: 'list_pattern_decisions',
    title: 'Pattern decision history',
    description:
      'Every decision on a recurring pattern, newest first, from every actor (user = the web UI; any other name = an ' +
      'agent, named by its server\'s MCP_ACTOR). Each item: id, createdAt, patternId, accountId, counterparty, decision ' +
      '(recurring, subscription, not_recurring), actor, superseded (a newer decision on the same pattern replaced ' +
      'it). Returns { total, limit, offset, items }; page with limit/offset. A rejected pattern is left out of ' +
      'list_recurring; find it here to change or reset its decision.',
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
