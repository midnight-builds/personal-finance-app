import { z } from 'zod';

// Query strings carry only strings. Rather than keeping coercing copies of every
// schema, values are converted by the target field's base type and then validated
// with the very same shape the MCP tools use.

type Coerce = (value: string) => unknown;

const DECIMAL = /^-?\d+(\.\d+)?$/;

const COERCERS: Record<string, Coerce> = {
  string: (v) => v,
  enum: (v) => v,
  // Strict: "0x10", "1e2" or " 1 " are not numbers here (NaN → rejected by the schema).
  number: (v) => (DECIMAL.test(v) ? Number(v) : Number.NaN),
  boolean: (v) => (v === 'true' ? true : v === 'false' ? false : v),
};

const WRAPPERS = new Set(['optional', 'default', 'nullable', 'readonly']);

type SchemaDef = { def: { type: string; innerType?: unknown } };

function baseType(schema: z.core.$ZodType): string {
  let current = schema as unknown as SchemaDef;
  while (WRAPPERS.has(current.def.type) && current.def.innerType) {
    current = current.def.innerType as SchemaDef;
  }
  return current.def.type;
}

export type QueryParser<S extends z.ZodRawShape> = (query: unknown) => z.output<z.ZodObject<S>>;

/**
 * Builds a parser for a Fastify query object from a zod field shape. Supported
 * field types: string, enum, number, boolean (optionally wrapped in
 * optional/default/nullable/readonly); anything else throws here, at module load,
 * not on a request. The parser treats empty values (`?minAmount=`) as "not given",
 * ignores unknown keys and throws `ZodError` on invalid input.
 */
export function queryParser<S extends z.ZodRawShape>(shape: S): QueryParser<S> {
  const coercers = new Map<string, Coerce>();
  for (const [key, field] of Object.entries(shape)) {
    const type = baseType(field);
    const coerce = COERCERS[type];
    if (!coerce) throw new Error(`queryParser: field "${key}" has unsupported type "${type}"`);
    coercers.set(key, coerce);
  }
  const schema = z.object(shape);

  return (query) => {
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries((query ?? {}) as Record<string, unknown>)) {
      const coerce = coercers.get(key); // Map lookup: "__proto__"/"constructor" are just unknown keys
      if (!coerce) continue;
      if (typeof value === 'string') {
        if (value.trim() !== '') input[key] = coerce(value);
      } else {
        input[key] = value; // e.g. an array from a repeated key → rejected by the schema
      }
    }
    return schema.parse(input);
  };
}
