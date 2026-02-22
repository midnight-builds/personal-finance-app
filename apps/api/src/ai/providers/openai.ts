import { OpenAI } from 'openai';
import type { AiCategoryProvider } from '../provider.js';
import type { AiCategorySuggestionRequest } from '../contract.js';
import { buildCategorizeSystemPrompt, buildCategorizeUserPrompt } from '../prompt.js';

export function createOpenAiCategoryProvider(options: { apiKey: string; model?: string }): AiCategoryProvider {
  const openai = new OpenAI({ apiKey: options.apiKey });
  const model = options.model ?? 'gpt-4o-mini';

  return {
    name: 'openai',
    async suggest(req: AiCategorySuggestionRequest) {
      const system = buildCategorizeSystemPrompt(req.locale ?? 'fi-FI');
      const user = buildCategorizeUserPrompt(req);

      const resp = await openai.responses.create({
        model,
        temperature: 0,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      });

      return { outputText: resp.output_text, rawText: resp.output_text };
    },
  };
}
