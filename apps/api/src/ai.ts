import { listCategories } from './rules.js';
import { logEvent } from './logger.js';
import { getOpenAIApiKey } from './settings.js';

import { createInMemoryAiCache } from './ai/cache.js';
import type { AiCategorySuggestionRequest } from './ai/contract.js';
import { suggestCategory } from './ai/service.js';
import { createOpenAiCategoryProvider } from './ai/providers/openai.js';

// Backwards-compatible export used by existing tests / callers.
export { validateAiResult } from './ai/service.js';

type AiResult =
  | { mode: 'existing'; categoryId: string; categoryName: string }
  | { mode: 'new'; categoryName: string }
  | {
      mode: 'options';
      options: Array<{ categoryId: string; categoryName: string; reason: string }>;
    }
  | { mode: 'none' };

const defaultCache = createInMemoryAiCache({ max: 500 });

function envFlagEnabled(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  return defaultValue;
}

function toLegacy(r: Awaited<ReturnType<typeof suggestCategory>>['suggestion']): AiResult {
  if (r.kind === 'existing') return { mode: 'existing', categoryId: r.categoryId, categoryName: r.categoryName };
  if (r.kind === 'new') return { mode: 'new', categoryName: r.categoryName };
  if (r.kind === 'options') {
    return {
      mode: 'options',
      options: r.options.slice(0, 3).map((o) => ({
        categoryId: o.categoryId,
        categoryName: o.categoryName,
        reason: o.reason ?? '',
      })),
    };
  }
  return { mode: 'none' };
}

export async function aiCategorize(input: {
  counterparty?: string | null;
  description?: string | null;
  amount: number;
  currency: string;
}): Promise<AiResult> {
  const enabled = envFlagEnabled('AI_CATEGORIZE_ENABLED', true);

  const cats = listCategories();
  const req: AiCategorySuggestionRequest = {
    transaction: {
      counterparty: input.counterparty,
      description: input.description,
      amount: input.amount,
      currency: input.currency,
    },
    categories: cats,
    locale: 'fi-FI',
  };

  const apiKey = getOpenAIApiKey();
  const provider = apiKey ? createOpenAiCategoryProvider({ apiKey, model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini' }) : null;

  if (!apiKey) {
    logEvent({ type: 'ai.error', scope: 'categorize', message: 'OPENAI_API_KEY puuttuu', payload: { input } });
  }

  const result = await suggestCategory({
    req,
    provider,
    cache: defaultCache,
    enabled,
  });

  if (result.meta.warning) {
    logEvent({
      type: 'ai.fallback',
      scope: 'categorize',
      message: `AI categorize warning: ${result.meta.warning}`,
      payload: { input, meta: result.meta },
    });
  }

  return toLegacy(result.suggestion);
}
