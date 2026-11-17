// Turns GLOSSARY.md into the term list `get_glossary` serves. The list is
// generated into terms.generated.ts (`npm run glossary --workspace apps/mcp`),
// because the MCP server runs from its build and does not read repo files; a test
// fails when the generated list and GLOSSARY.md drift apart.

export type GlossaryTerm = {
  term: string;
  /** The entry's first sentence. */
  summary: string;
  /** The whole entry, Markdown flattened to one paragraph. */
  definition: string;
  /** Words not to use for it (`_Avoid_:` line), if any. */
  avoid: string | null;
};

// An entry starts with a bold term and a dash: "**Term** — definition".
const ENTRY_START = /^\*\*(.+?)\*\*\s+—\s+(.*)$/;
const AVOID = /^_Avoid_:\s*(.*)$/;
// A sentence ends at ". " not preceded by an abbreviation such as "e.g." or "i.e.".
const SENTENCE_END = /(?<!\be\.g|\bi\.e)\.(?=\s|$)/;

const flatten = (lines: string[]) => lines.join(' ').replace(/\s+/g, ' ').trim();

export function parseGlossary(markdown: string): GlossaryTerm[] {
  const terms: GlossaryTerm[] = [];
  let current: { term: string; lines: string[]; avoid: string | null } | null = null;
  const finish = () => {
    if (!current) return;
    const definition = flatten(current.lines);
    const end = definition.search(SENTENCE_END);
    terms.push({
      term: current.term,
      summary: end === -1 ? definition : definition.slice(0, end + 1),
      definition,
      avoid: current.avoid,
    });
  };

  for (const line of markdown.split('\n')) {
    const start = ENTRY_START.exec(line);
    if (start) {
      finish();
      current = { term: start[1].trim(), lines: [start[2]], avoid: null };
      continue;
    }
    if (!current) continue; // title and introduction
    const avoid = AVOID.exec(line.trim());
    if (avoid) current.avoid = avoid[1].trim();
    else current.lines.push(line.trim());
  }
  finish();
  return terms;
}
