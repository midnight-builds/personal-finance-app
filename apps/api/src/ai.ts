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
      const json = JSON.parse(cleaned) as any;
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
