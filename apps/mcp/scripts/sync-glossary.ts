// Regenerates src/glossary/terms.generated.ts from the repo's GLOSSARY.md.
// Run after editing GLOSSARY.md: npm run glossary --workspace apps/mcp
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGlossary } from '../src/glossary/parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GLOSSARY_MD = path.resolve(here, '../../../GLOSSARY.md');
export const GENERATED = path.resolve(here, '../src/glossary/terms.generated.ts');

export function renderGenerated(markdown: string): string {
  return (
    '// Generated from GLOSSARY.md by scripts/sync-glossary.ts. Do not edit by hand:\n' +
    '// run `npm run glossary --workspace apps/mcp`. tests/glossary.test.ts fails on drift.\n' +
    "import type { GlossaryTerm } from './parse.js';\n\n" +
    `export const GLOSSARY_TERMS: readonly GlossaryTerm[] = ${JSON.stringify(parseGlossary(markdown), null, 2)};\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(GENERATED, renderGenerated(fs.readFileSync(GLOSSARY_MD, 'utf8')));
  process.stdout.write(`Wrote ${path.relative(process.cwd(), GENERATED)}\n`);
}
