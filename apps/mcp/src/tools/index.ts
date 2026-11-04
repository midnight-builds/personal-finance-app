import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { redactDeep } from '@finance-app/shared';
import { ApiError } from '../apiClient.js';
import { financeTools } from './finance.js';
import { proposalTools } from './proposals.js';
import type { ToolContext, ToolDefinition } from './types.js';

// Tool registry. To add a tool: define it in a module next to this one and
// list that module here. Every response passes through `redactDeep`.

export const ALL_TOOLS: readonly ToolDefinition[] = [...financeTools, ...proposalTools];
export const TOOL_NAMES: readonly string[] = ALL_TOOLS.map((t) => t.name);

/** Returns the enabled tools; throws on unknown names so config typos fail loudly at startup. */
export function selectTools(disabled: ReadonlySet<string>): ToolDefinition[] {
  const unknown = [...disabled].filter((name) => !TOOL_NAMES.includes(name));
  if (unknown.length > 0) {
    throw new Error(`Unknown tool(s) in MCP_DISABLED_TOOLS: ${unknown.join(', ')}. Known: ${TOOL_NAMES.join(', ')}`);
  }
  return ALL_TOOLS.filter((t) => !disabled.has(t.name));
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return `Finance API error ${err.status}: ${JSON.stringify(redactDeep(err.body))}`;
  return `Finance API unreachable: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Freshness of the data behind a response. A failing status lookup must not
 * fail the tool itself, so the timestamps are then null.
 */
async function freshnessMeta(api: ToolContext['api']) {
  const status = (await api.get('/data-status').catch(() => null)) as
    | { lastImportAt?: string | null; dataAsOf?: string | null }
    | null;
  return {
    generatedAt: new Date().toISOString(),
    lastImportAt: status?.lastImportAt ?? null,
    dataAsOf: status?.dataAsOf ?? null,
  };
}

const toText = (value: unknown) => ({ type: 'text' as const, text: JSON.stringify(redactDeep(value), null, 2) });

export async function runTool(tool: ToolDefinition, args: unknown, ctx: ToolContext): Promise<CallToolResult> {
  try {
    const [data, meta] = await Promise.all([
      tool.run(args as never, ctx),
      tool.freshness ? freshnessMeta(ctx.api) : undefined,
    ]);
    if (!meta) return { content: [toText(data)] };
    const extra = typeof tool.freshness === 'function' ? tool.freshness(data) : {};
    return { content: [toText(data), toText({ meta: { ...meta, ...extra } })] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: describeError(err) }] };
  }
}

export function registerTools(server: McpServer, tools: readonly ToolDefinition[], ctx: ToolContext) {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // An explicit (possibly empty) shape makes the SDK validate input and pass args first.
        inputSchema: tool.inputSchema ?? {},
        annotations: tool.annotations,
      },
      (args) => runTool(tool, args, ctx)
    );
  }
}
