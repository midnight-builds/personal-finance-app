export type AiCategory = { id: string; name: string };

export type AiCategorySuggestionRequest = {
  // Transaction fields: keep minimal; avoid extra PII like IBAN/account numbers.
  transaction: {
    counterparty?: string | null;
    description?: string | null;
    amount: number;
    currency: string;
  };
  categories: AiCategory[];
  locale?: 'fi-FI' | string;
};

export type AiCategorySuggestion =
  | { kind: 'existing'; categoryId: string; categoryName: string; reason?: string }
  | { kind: 'new'; categoryName: string; reason?: string }
  | { kind: 'options'; options: Array<{ categoryId: string; categoryName: string; reason?: string }> }
  | { kind: 'none' };

export type AiCategorySuggestionResponse = {
  suggestion: AiCategorySuggestion;
  meta: {
    provider: 'openai' | 'rules' | 'disabled';
    model?: string;
    cached?: boolean;
    latencyMs?: number;
    // Non-fatal error info. Never include secrets.
    warning?: string;
  };
};
