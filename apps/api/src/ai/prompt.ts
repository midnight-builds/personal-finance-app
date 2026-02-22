import type { AiCategorySuggestionRequest } from './contract.js';

export function buildCategorizeSystemPrompt(locale: string): string {
  return `You are a personal finance assistant. Your task is to suggest a category for a single bank transaction.

Rules:
- Output MUST be valid JSON only (no markdown, no code fences).
- Choose from the provided category list.
- Never invent a categoryId not present in the list.
- If uncertain, return mode \"options\" with 2-3 best categories.
- Keep the reason short.

Output JSON must match this TypeScript type:
type Response =
 | { mode: \"existing\"; categoryId: string; categoryName?: string; reason?: string }
 | { mode: \"new\"; categoryName: string; reason?: string }
 | { mode: \"options\"; options: { categoryId: string; categoryName?: string; reason?: string }[] };

Locale: ${locale}`;
}

export function buildCategorizeUserPrompt(req: AiCategorySuggestionRequest): string {
  const { transaction, categories } = req;
  const categoriesText = categories.map((c) => `- ${c.id}: ${c.name}`).join('\n');

  return `Transaction:\nCounterparty: ${transaction.counterparty || '-'}\nDescription: ${transaction.description || '-'}\nAmount: ${transaction.amount} ${transaction.currency}\n\nCategories:\n${categoriesText}`;
}
