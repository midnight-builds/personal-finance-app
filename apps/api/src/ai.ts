import { OpenAI } from 'openai';
import { listCategories } from './rules.js';
import { logEvent } from './logger.js';
import { getOpenAIApiKey } from './settings.js';

type AiResult =
  | { mode: 'existing'; categoryId: string; categoryName: string }
  | { mode: 'new'; categoryName: string }
  | {
      mode: 'options';
      options: Array<{ categoryId: string; categoryName: string; reason: string }>;
    }
  | { mode: 'none' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function validateAiResult(
  raw: unknown,
  cats: Array<{ id: string; name: string }>
): AiResult {
  const catById = new Map(cats.map((c) => [c.id, c]));

  if (!isRecord(raw)) return { mode: 'none' };
  const mode = raw.mode;

  if (mode === 'existing') {
    const categoryId = raw.categoryId;
    const categoryName = raw.categoryName;
    if (typeof categoryId !== 'string' || !catById.has(categoryId)) return { mode: 'none' };
    if (typeof categoryName !== 'string' || !categoryName.trim()) {
      const cat = catById.get(categoryId)!;
      return { mode: 'existing', categoryId, categoryName: cat.name };
    }
    return { mode: 'existing', categoryId, categoryName };
  }

  if (mode === 'new') {
    const categoryName = raw.categoryName;
    if (typeof categoryName !== 'string' || !categoryName.trim()) return { mode: 'none' };
    return { mode: 'new', categoryName: categoryName.trim() };
  }

  if (mode === 'options') {
    const options = raw.options;
    if (!Array.isArray(options)) return { mode: 'none' };
    const cleaned: Array<{ categoryId: string; categoryName: string; reason: string }> = [];
    for (const opt of options) {
      if (!isRecord(opt)) continue;
      const categoryId = opt.categoryId;
      if (typeof categoryId !== 'string' || !catById.has(categoryId)) continue;
      const cat = catById.get(categoryId)!;
      const categoryName =
        typeof opt.categoryName === 'string' && opt.categoryName.trim() ? opt.categoryName : cat.name;
      const reason = typeof opt.reason === 'string' ? opt.reason : '';
      cleaned.push({ categoryId, categoryName, reason });
    }
    if (cleaned.length === 0) return { mode: 'none' };
    return { mode: 'options', options: cleaned.slice(0, 3) };
  }

  return { mode: 'none' };
}


function extractJsonBlock(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) return fence[1].trim();
  return trimmed;
}

export async function aiCategorize(input: {
  counterparty?: string | null;
  description?: string | null;
  amount: number;
  currency: string;
}): Promise<AiResult> {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    logEvent({ type: 'ai.error', scope: 'categorize', message: 'OPENAI_API_KEY puuttuu', payload: { input } });
    return { mode: 'none' };
  }
  const openai = new OpenAI({ apiKey });

  const cats = listCategories();
  const system = `You are a Finnish personal finance assistant. Choose a category for a bank transaction.
Respond ONLY as JSON matching this TypeScript type:
type Response =
 | { mode: "existing"; categoryId: string; categoryName: string; reason: string }
 | { mode: "new"; categoryName: string; reason: string }
 | { mode: "options"; options: { categoryId: string; categoryName: string; reason: string }[] }
If uncertain, return mode "options" with 2-3 best categories. Use the provided category list.
Never invent categoryId outside the list.`;

  const categoriesText = cats.map((c) => `- ${c.id}: ${c.name}`).join('\n');
  const user = `Transaction:
Counterparty: ${input.counterparty || '-'}
Description: ${input.description || '-'}
Amount: ${input.amount} ${input.currency}
Categories:
${categoriesText}`;

  try {
    logEvent({ type: 'ai.start', scope: 'categorize', message: 'AI kategorisointi alkaa', payload: { input } });
    const resp = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const cleaned = extractJsonBlock(resp.output_text);
    try {
      const raw = JSON.parse(cleaned) as unknown;
      const json = validateAiResult(raw, cats);
      if (json.mode === 'none') {
        logEvent({
          type: 'ai.error',
          scope: 'categorize',
          message: 'AI invalid output',
          payload: { input, raw },
        });
      }
      logEvent({ type: 'ai.categorize', scope: json.mode, message: 'AI categorize ok', payload: { input, output: json } });
      return json as AiResult;
    } catch (err) {
      logEvent({
        type: 'ai.error',
        scope: 'categorize',
        message: 'AI parse failed',
        payload: { input, error: String(err), raw: resp.output_text, cleaned },
      });
      return { mode: 'none' };
    }
  } catch (err) {
    logEvent({
      type: 'ai.error',
      scope: 'categorize',
      message: 'AI call failed',
      payload: { input, error: String(err) },
    });
    return { mode: 'none' };
  }
}
