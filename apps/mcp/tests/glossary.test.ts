import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GENERATED, GLOSSARY_MD, renderGenerated } from '../scripts/sync-glossary.js';
import { parseGlossary } from '../src/glossary/parse.js';
import { GLOSSARY_TERMS } from '../src/glossary/terms.generated.js';

test('the glossary the MCP server serves matches GLOSSARY.md', () => {
  const markdown = fs.readFileSync(GLOSSARY_MD, 'utf8');
  assert.equal(
    fs.readFileSync(GENERATED, 'utf8'),
    renderGenerated(markdown),
    'GLOSSARY.md changed: run `npm run glossary --workspace apps/mcp` and commit the result'
  );
  assert.deepEqual(GLOSSARY_TERMS, parseGlossary(markdown));
  // Every bold-led entry is a term; nothing is silently skipped.
  const entries = markdown.split('\n').filter((l) => /^\*\*.+?\*\*\s+—/.test(l)).length;
  assert.equal(GLOSSARY_TERMS.length, entries);
});

test('parseGlossary: term, first sentence, whole entry and avoided words', () => {
  const terms = parseGlossary(
    [
      '# Glossary',
      '',
      'Intro text.',
      '',
      '**Widget** — a thing, e.g. a gadget. It has parts:',
      '',
      '- *one* — the first;',
      '- *two* — the second.',
      '',
      '**Gizmo** — another thing',
      '_Avoid_: doohickey',
    ].join('\n')
  );
  assert.deepEqual(terms, [
    {
      term: 'Widget',
      summary: 'a thing, e.g. a gadget.',
      definition: 'a thing, e.g. a gadget. It has parts: - *one* — the first; - *two* — the second.',
      avoid: null,
    },
    { term: 'Gizmo', summary: 'another thing', definition: 'another thing', avoid: 'doohickey' },
  ]);
});
