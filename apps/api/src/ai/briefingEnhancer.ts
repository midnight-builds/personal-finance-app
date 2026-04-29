import { OpenAI } from 'openai';

type FindingForEnhancement = {
  title: string;
  description: string;
};

export async function enhanceBriefingDescriptions(
  findings: FindingForEnhancement[],
  apiKey: string
): Promise<string[]> {
  if (findings.length === 0) return [];

  const openai = new OpenAI({ apiKey });

  const prompt = `Olet henkilökohtainen talousneuvoja. Alla on talousanalyysihavaintoja JSON-taulukkona.
Muokkaa jokaisen havainnon kuvaus luonnollisemmaksi, selkeämmäksi suomeksi — kuin neuvoisit ystävää.
Pidä kaikki faktat täsmälleen samoina (summat, päivämäärät, prosentit, palvelunimet).
Älä lisää tietoja tai suosituksia, joita ei ole alkuperäisessä kuvauksessa.
Palauta tasan ${findings.length} parannettua kuvausta JSON-taulukkona merkkijonoja.

${JSON.stringify(findings.map((f, i) => ({ i, title: f.title, description: f.description })))}

Palauta: ["parannettukuvaus0", "parannettukuvaus1", ...]`;

  const resp = await openai.responses.create({
    model: 'gpt-4o',
    temperature: 0.3,
    input: [{ role: 'user', content: prompt }],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(resp.output_text);
  } catch {
    throw new Error('AI briefing enhancer: invalid JSON response');
  }
  if (!Array.isArray(parsed) || parsed.length !== findings.length) {
    throw new Error(
      `AI briefing enhancer: expected ${findings.length} items, got ${Array.isArray(parsed) ? parsed.length : typeof parsed}`
    );
  }
  return parsed as string[];
}
