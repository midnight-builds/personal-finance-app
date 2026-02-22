import crypto from 'crypto';
import type { AiCategorySuggestionRequest, AiCategorySuggestionResponse } from './contract.js';

export type AiCache = {
  get(key: string): AiCategorySuggestionResponse | undefined;
  set(key: string, value: AiCategorySuggestionResponse): void;
};

export function createInMemoryAiCache(options?: { max?: number }): AiCache {
  const max = options?.max ?? 500;
  const map = new Map<string, AiCategorySuggestionResponse>();

  return {
    get(key) {
      const v = map.get(key);
      if (v) {
        map.delete(key);
        map.set(key, v);
      }
      return v;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > max) {
        const first = map.keys().next().value as string | undefined;
        if (!first) break;
        map.delete(first);
      }
    },
  };
}

export function cacheKeyForRequest(req: AiCategorySuggestionRequest): string {
  const norm = {
    tx: {
      counterparty: (req.transaction.counterparty ?? '').trim().toLowerCase(),
      description: (req.transaction.description ?? '').trim().toLowerCase(),
      amount: Number(req.transaction.amount),
      currency: String(req.transaction.currency ?? '').toUpperCase(),
    },
    categories: req.categories
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    locale: req.locale ?? 'fi-FI',
    v: 1,
  };
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}
