import type { AiCategorySuggestionRequest } from './contract.js';

export type AiProviderResult = {
  // Optional raw material for debugging/logging (consider PII when storing).
  rawText?: string;
  rawJson?: unknown;
};

export interface AiCategoryProvider {
  readonly name: 'openai' | string;
  suggest(req: AiCategorySuggestionRequest): Promise<AiProviderResult & { outputText: string }>;
}
