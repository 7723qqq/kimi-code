// Generic stdio MCP server front-end for a Normify tool registry.
//
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout per the MCP "stdio"
// transport, implementing the surface the Kimi Code host calls:
//   - initialize
//   - notifications/initialized
//   - tools/list
//   - tools/call
//   - ping
//
// It is deliberately free of third-party dependencies so the plugin can run
// from a marketplace install without a workspace to resolve packages from.

import { createInterface } from 'node:readline';

import type { ToolSpec } from './tools.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpServerOptions {
  /** Server identity reported in `initialize`. */
  name: string;
  version: string;
  /** The tools to expose, in registration order. */
  tools: readonly ToolSpec[];
}

/** A `tools/call` result as returned to the host. */
export interface McpCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: number | string | undefined, result: unknown): void {
  send({ jsonrpc: '2.0', id: id ?? null, result });
}

function sendError(
  id: number | string | undefined,
  code: number,
  message: string,
  data?: unknown,
): void {
  send({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

/** Renders a tool payload as MCP text content: strings stay verbatim, objects become JSON. */
function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** True when the payload carries `ok: false` — surfaced to the model as a tool error. */
function isFailure(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  );
}

/** JSON-RPC 级错误：内部抛出、dispatch 处转成 `error` 响应。 */
class JsonRpcError extends Error {
  readonly jsonRpc: { code: number; message: string };

  constructor(code: number, message: string) {
    super(message);
    this.name = 'JsonRpcError';
    this.jsonRpc = { code, message };
  }
}

export function createMcpServer(options: McpServerOptions): {
  tools: readonly ToolSpec[];
  handleRequest: (message: RequestMessage) => Promise<unknown>;
  listen: () => void;
} {
  const { name, version, tools } = options;
  const handlers = new Map<string, ToolSpec>(tools.map((tool) => [tool.name, tool]));

  /** MCP `tools/list` entries: name, description and the compiled JSON Schema. */
  const list = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
  }));

  async function runTool(params: unknown): Promise<McpCallResult> {
    const toolName = (params as { name?: unknown } | undefined)?.name;
    const args = (params as { arguments?: unknown } | undefined)?.arguments ?? {};
    if (typeof toolName !== 'string') {
      return { content: [{ type: 'text', text: 'Missing tool name.' }], isError: true };
    }
    const tool = handlers.get(toolName);
    if (tool === undefined) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}. Available tools: ${[...handlers.keys()].join(', ')}.` }],
        isError: true,
      };
    }
    try {
      const value = await tool.execute(args);
      return {
        content: [{ type: 'text', text: toText(value) }],
        ...(isFailure(value) ? { isError: true } : {}),
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Tool "${toolName}" failed: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  async function handleRequest(message: RequestMessage): Promise<unknown> {
    switch (message.method) {
      case 'initialize':
        return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name, version } };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: [...list] };
      case 'tools/call':
        return runTool(message.params);
      default:
        throw new JsonRpcError(-32601, `Method not found: ${message.method}`);
    }
  }

  function listen(): void {
    const rl = createInterface({ input: process.stdin, terminal: false });
    // 请求串行：两个 tools/call 交错会在任意 await 点互相穿插，
    // 读-改-写类工具（patch 的 expect_updated_at、batch、move、refresh）会丢更新。
    // stdio 只有一个事件循环，排队执行比加锁更简单也不会漏掉通知的响应顺序。
    let queue: Promise<void> = Promise.resolve();
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;
      let message: RequestMessage;
      try {
        message = JSON.parse(trimmed) as RequestMessage;
      } catch (error) {
        sendError(undefined, -32700, `Parse error: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (message.method?.startsWith('notifications/')) return;
      queue = queue.then(() => dispatch(message));
    });
    rl.on('close', () => {
      process.exit(0);
    });
  }

  async function dispatch(message: RequestMessage): Promise<void> {
    const { id } = message;
    try {
      sendResult(id, await handleRequest(message));
    } catch (error) {
      if (error instanceof JsonRpcError) {
        sendError(id, error.jsonRpc.code, error.jsonRpc.message);
        return;
      }
      sendError(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }

  return { tools, handleRequest, listen };
}

interface RequestMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
}
