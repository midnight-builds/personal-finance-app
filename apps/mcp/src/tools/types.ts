import type { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiClient } from '../apiClient.js';

export type ToolContext = {
  api: ApiClient;
  /** Stored as `source` on feature proposals, e.g. "hermes". */
  proposalSource: string;
};

/**
 * One MCP tool. `run` returns plain data; the registry serializes it, redacts
 * account identifiers and converts thrown errors into tool errors.
 */
export type ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  inputSchema?: Shape;
  annotations: ToolAnnotations;
  run: (args: z.output<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<unknown>;
  /**
   * Adds a separate `meta` content block with data freshness (see `freshnessMeta`).
   * A function contributes tool-specific fields derived from the result.
   */
  freshness?: true | ((data: unknown) => Record<string, unknown>);
};

/** Keeps the args type of `run` tied to `inputSchema` while allowing a heterogeneous registry. */
export function defineTool<Shape extends z.ZodRawShape>(tool: ToolDefinition<Shape>): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/** Adds a record to a review queue; never changes or deletes existing data. */
export const APPEND_ONLY: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
