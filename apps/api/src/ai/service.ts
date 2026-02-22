import { chooseCategoryFor } from '../rules.js';
import { logEvent } from '../logger.js';
import type { AiCache } from './cache.js';
import { cacheKeyForRequest } from './cache.js';
import type { AiCategoryProvider } from './provider.js';
import type {
  AiCategorySuggestionRequest,
  AiCategorySuggestionResponse,
  AiCategorySuggestion,
} from './contract.js';

// Provider output contract (validated)
type LegacyAiResult =
  | { mode: 'existing'; categoryId: string; categoryName: string; reason?: string }
  | { mode: 'new'; categoryName: string; reason?: string }
  | {
      mode: 'options';
      options: Array<{ categoryId: string; categoryName: string; reason?: string }>;
    }
  | { mode: 'none' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function validateAiResult(raw: unknown, cats: Array<{ id: string; name: string }>): LegacyAiResult {
  const catById = new Map(cats.map((c) => [c.id, c]));

  if (!isRecord(raw)) return { mode: 'none' };
  const mode = raw.mode;

  if (mode === 'existing') {
    const categoryId = raw.categoryId;
    const categoryName = raw.categoryName;
    const reason = raw.reason;
    if (typeof categoryId !== 'string' || !catById.has(categoryId)) return { mode: 'none' };
    const cat = catById.get(categoryId)!;
    const name = typeof categoryName === 'string' && categoryName.trim() ? categoryName.trim() : cat.name;
    return {
      mode: 'existing',
      categoryId,
      categoryName: name,
      ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
    };
  }

  if (mode === 'new') {
    const categoryName = raw.categoryName;
    const reason = raw.reason;
    if (typeof categoryName !== 'string' || !categoryName.trim()) return { mode: 'none' };
    return {
      mode: 'new',
      categoryName: categoryName.trim(),
      ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}),
    };
  }

  if (mode === 'options') {
    const options = raw.options;
    if (!Array.isArray(options)) return { mode: 'none' };
    const cleaned: Array<{ categoryId: string; categoryName: string; reason?: string }> = [];
    for (const opt of options) {
      if (!isRecord(opt)) continue;
      const categoryId = opt.categoryId;
      if (typeof categoryId !== 'string' || !catById.has(categoryId)) continue;
      const cat = catById.get(categoryId)!;
      const categoryName =
        typeof opt.categoryName === 'string' && opt.categoryName.trim() ? opt.categoryName.trim() : cat.name;
      const reason = typeof opt.reason === 'string' && opt.reason.trim() ? opt.reason.trim() : undefined;
      cleaned.push({ categoryId, categoryName, ...(reason ? { reason } : {}) });
    }
    if (cleaned.length === 0) return { mode: 'none' };
    return { mode: 'options', options: cleaned.slice(0, 3) };
  }

  return { mode: 'none' };
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) return fence[1].trim();
  return trimmed;
}

function fallbackRules(req: AiCategorySuggestionRequest): AiCategorySuggestion {
  const categoryId = chooseCategoryFor({
    counterparty: req.transaction.counterparty || '',
    description: req.transaction.description || '',
    amount: req.transaction.amount,
  });

  if (!categoryId) return { kind: 'none' };
  const cat = req.categories.find((c) => c.id === categoryId);
  return { kind: 'existing', categoryId, categoryName: cat?.name || categoryId };
}

function legacyToSuggestion(r: LegacyAiResult): AiCategorySuggestion {
  if (r.mode === 'existing')
    return { kind: 'existing', categoryId: r.categoryId, categoryName: r.categoryName, reason: r.reason };
  if (r.mode === 'new') return { kind: 'new', categoryName: r.categoryName, reason: r.reason };
  if (r.mode === 'options') return { kind: 'options', options: r.options };
  return { kind: 'none' };
}

export async function suggestCategory(options: {
  req: AiCategorySuggestionRequest;
  provider?: AiCategoryProvider | null;
  cache?: AiCache | null;
  enabled: boolean;
}): Promise<AiCategorySuggestionResponse> {
  const { req, provider, cache, enabled } = options;

  if (!enabled) {
    return { suggestion: fallbackRules(req), meta: { provider: 'disabled', warning: 'ai_disabled' } };
  }

  const key = cache ? cacheKeyForRequest(req) : null;
  if (cache && key) {
    const hit = cache.get(key);
    if (hit) return { ...hit, meta: { ...hit.meta, cached: true } };
  }

  if (!provider) {
    const out: AiCategorySuggestionResponse = {
      suggestion: fallbackRules(req),
      meta: { provider: 'rules', warning: 'no_provider' },
    };
    if (cache && key) cache.set(key, out);
    return out;
  }

  const started = Date.now();
  try {
    logEvent({ type: 'ai.start', scope: 'categorize', message: 'AI categorize start', payload: { provider: provider.name } });
    const result = await provider.suggest(req);
    const cleaned = extractJson(result.outputText);
    const raw = JSON.parse(cleaned) as unknown;
    const validated = validateAiResult(raw, req.categories);

    if (validated.mode === 'none') {
      const out = {
        suggestion: fallbackRules(req),
        meta: { provider: 'rules', warning: 'invalid_ai_output' },
      } satisfies AiCategorySuggestionResponse;
      if (cache && key) cache.set(key, out);
      logEvent({ type: 'ai.error', scope: 'categorize', message: 'AI invalid output', payload: { provider: provider.name } });
      return out;
    }

    const out = {
      suggestion: legacyToSuggestion(validated),
      meta: { provider: provider.name === 'openai' ? 'openai' : 'openai', latencyMs: Date.now() - started },
    } satisfies AiCategorySuggestionResponse;
    if (cache && key) cache.set(key, out);
    logEvent({ type: 'ai.categorize', scope: validated.mode, message: 'AI categorize ok', payload: { provider: provider.name } });
    return out;
  } catch (err) {
    const out = {
      suggestion: fallbackRules(req),
      meta: { provider: 'rules', warning: 'ai_error' },
    } satisfies AiCategorySuggestionResponse;
    if (cache && key) cache.set(key, out);
    logEvent({ type: 'ai.error', scope: 'categorize', message: 'AI call failed', payload: { error: String(err) } });
    return out;
  }
}
