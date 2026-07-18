/// Rust agent engine adapter.
///
/// When `agent.engine = "rust"` is configured, this module provides
/// a drop-in replacement for the JS turn loop by starting the
/// `kimi-agent` Rust binary as a child process and communicating
/// with it via stdio JSON-RPC.
///
/// If the Rust binary is not found or fails to start, it falls back
/// to the JS implementation automatically.

import { ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';

// Project root: packages/kimi-agent/rust-loop.ts → ../../ (project root)
const projectRoot = resolve(import.meta.dirname!, '..', '..');

// ── Types matching the Rust agent protocol ─────────────────────────────────

interface RpcMessage {
  jsonrpc: '2.0';
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RunTurnParams {
  turn_id: string;
  system_prompt: string;
  model_name: string;
  messages: { role: string; content: string }[];
  tools: { name: string; description: string; input_schema: unknown }[];
  max_steps?: number;
}

interface RunTurnResult {
  stop_reason: string;
  steps: number;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

interface LlmChatRequest {
  system_prompt: string;
  model_name: string;
  messages: { role: string; content: string }[];
  tools: { name: string; description: string; input_schema: unknown }[];
}

interface LlmChatResponse {
  tool_calls: { id: string; name: string; arguments: unknown }[];
  finish_reason?: string;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

interface ToolExecuteRequest {
  turn_id: string;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
}

interface ToolExecuteResponse {
  content: string;
  is_error: boolean;
}

// ── Agent process manager ──────────────────────────────────────────────────

class AgentProcess {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private ready = false;

  /** Callback for handling host/llm_chat requests from the Rust side. */
  private llmChatHandler: ((req: LlmChatRequest) => Promise<LlmChatResponse>) | null = null;

  /** Callback for handling host/execute_tool requests from the Rust side. */
  private toolExecuteHandler: ((req: ToolExecuteRequest) => Promise<ToolExecuteResponse>) | null = null;

  setLlmChatHandler(handler: (req: LlmChatRequest) => Promise<LlmChatResponse>) {
    this.llmChatHandler = handler;
  }

  setToolExecuteHandler(handler: (req: ToolExecuteRequest) => Promise<ToolExecuteResponse>) {
    this.toolExecuteHandler = handler;
  }

  private static findBinary(): string | null {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const arch = `${process.platform}-${process.arch}`;
    const candidates = [
      // Development: directly from Rust build output
      resolve(projectRoot, 'packages/kimi-agent/target/release/kimi-agent' + ext),
      resolve(projectRoot, 'packages/kimi-agent/target/debug/kimi-agent' + ext),
      // Production: bundled alongside the SEA binary
      resolve(projectRoot, 'dist-native', 'bin', arch, 'kimi-agent' + ext),
    ];
    try {
      const fs = require('node:fs');
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  start(): boolean {
    const binaryPath = AgentProcess.findBinary();
    if (!binaryPath) {
      console.warn('[kimi-agent] Binary not found, falling back to JS engine');
      return false;
    }

    try {
      this.process = spawn(binaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.stdout!.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.process.stderr!.on('data', (data: Buffer) => {
        console.error(`[kimi-agent] ${data.toString().trim()}`);
      });

      this.process.on('exit', (code) => {
        console.warn(`[kimi-agent] Process exited with code ${code}`);
        this.process = null;
        for (const [id, { reject }] of this.pending) {
          reject(new Error(`Agent process exited with code ${code}`));
          this.pending.delete(id);
        }
      });

      this.ready = true;
      return true;
    } catch (err) {
      console.warn('[kimi-agent] Failed to start:', err);
      return false;
    }
  }

  private processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as RpcMessage;

        // Case 1: Response to a pending request
        if (msg.id !== undefined && this.pending.has(msg.id as number)) {
          const pending = this.pending.get(msg.id as number)!;
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
          this.pending.delete(msg.id as number);
          continue;
        }

        // Case 2: Request from Rust side (has method + params)
        if (msg.id !== undefined && msg.method && msg.params !== undefined) {
          this.handleHostRequest(msg).catch((err) => {
            console.error('[kimi-agent] Failed to handle host request:', err);
          });
        }
      } catch {
        // ignore malformed JSON
      }
    }
  }

  private async handleHostRequest(msg: RpcMessage) {
    if (msg.method === 'host/llm_chat') {
      await this.handleHostLlmChat(msg);
    } else if (msg.method === 'host/execute_tool') {
      await this.handleHostExecuteTool(msg);
    } else {
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unknown method: ${msg.method}` },
      });
      this.process!.stdin!.write(response + '\n');
    }
  }

  private async handleHostLlmChat(msg: RpcMessage) {
    if (!this.llmChatHandler) {
      this.writeHostError(msg.id, 'No LLM chat handler registered');
      return;
    }
    try {
      const result = await this.llmChatHandler(msg.params as LlmChatRequest);
      this.writeHostResult(msg.id, result);
    } catch (err) {
      this.writeHostError(msg.id, err instanceof Error ? err.message : String(err));
    }
  }

  private async handleHostExecuteTool(msg: RpcMessage) {
    if (!this.toolExecuteHandler) {
      this.writeHostError(msg.id, 'No tool execute handler registered');
      return;
    }
    try {
      const result = await this.toolExecuteHandler(msg.params as ToolExecuteRequest);
      this.writeHostResult(msg.id, result);
    } catch (err) {
      this.writeHostError(msg.id, err instanceof Error ? err.message : String(err));
    }
  }

  private writeHostResult(id: unknown, result: unknown) {
    this.process!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private writeHostError(id: unknown, message: string) {
    this.process!.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } }) + '\n',
    );
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.process || !this.ready) {
      throw new Error('Agent process is not running');
    }
    const id = this.nextId++;
    const request = { jsonrpc: '2.0' as const, id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.ready = false;
  }
}

// ── Singleton process instance ─────────────────────────────────────────────

let agentProcess: AgentProcess | null = null;
let fallbackToJs = false;

function getAgent(): AgentProcess | null {
  if (fallbackToJs) return null;
  if (!agentProcess) {
    agentProcess = new AgentProcess();
    if (!agentProcess.start()) {
      agentProcess = null;
      fallbackToJs = true;
      return null;
    }
  }
  return agentProcess;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function runTurnRust(
  params: RunTurnParams,
  handlers?: {
    llmChat?: (req: LlmChatRequest) => Promise<LlmChatResponse>;
    toolExecute?: (req: ToolExecuteRequest) => Promise<ToolExecuteResponse>;
  },
): Promise<RunTurnResult | null> {
  const agent = getAgent();
  if (!agent) return null;

  if (handlers?.llmChat) {
    agent.setLlmChatHandler(handlers.llmChat);
  }
  if (handlers?.toolExecute) {
    agent.setToolExecuteHandler(handlers.toolExecute);
  }

  try {
    const result = await agent.request('agent/run_turn', params);
    return result as RunTurnResult;
  } catch (err) {
    console.error('[kimi-agent] RPC call failed:', err);
    return null;
  }
}

/**
 * Create a `RunTurnOverride` function compatible with the agent-core turn loop.
 *
 * This adapter bridges between the JS `RunTurnInput` (from agent-core) and the
 * Rust kimi-agent binary. It:
 * 1. Extracts messages, tools, and system prompt from the JS input
 * 2. Sends the turn to the Rust binary via `agent/run_turn`
 * 3. Handles `host/llm_chat` callbacks by forwarding to `input.llm.chat()`
 * 4. Handles `host/execute_tool` callbacks by resolving and executing tools
 * 5. Maps the Rust response back to the JS `TurnResult` type
 *
 * Returns `undefined` when the Rust binary is not available (falls back to JS).
 */
export function createRunTurnOverride(): import('@moonshot-ai/agent-core').RunTurnOverride | undefined {
  if (!isRustEngineAvailable()) return undefined;

  return async (input) => {
    const agent = getAgent();
    if (!agent) {
      throw new Error('Rust engine unavailable');
    }

    // Build messages and tools from the input
    const messages = input.buildMessages();
    const tools = input.buildTools();

    // Set up the LLM chat handler — forwards to the JS LLM provider
    agent.setLlmChatHandler(async (req) => {
      // Build the LLM params from the Rust request
      const llmMessages = req.messages.map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system' | 'tool',
        content: m.content,
      }));

      const llmTools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      const response = await input.llm.chat({
        messages: llmMessages,
        tools: llmTools as never[],
        signal: input.signal,
      });

      return {
        tool_calls: response.toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          // LLM returns arguments as a JSON string; Rust expects a parsed value
          arguments: tc.arguments ? tryParseJson(tc.arguments) : null,
        })) ?? [],
        finish_reason: response.providerFinishReason ?? 'stop',
        usage: {
          input_tokens: response.usage?.inputOther ?? 0,
          output_tokens: response.usage?.output ?? 0,
          total_tokens: (response.usage?.inputOther ?? 0) + (response.usage?.output ?? 0),
        },
      };
    });

    // Set up the tool execution handler — resolves and executes tools via JS
    agent.setToolExecuteHandler(async (req) => {
      const tool = tools.find((t) => t.name === req.tool_name);
      if (!tool) {
        return {
          content: JSON.stringify({ error: `Tool not found: ${req.tool_name}` }),
          is_error: true,
        };
      }

      try {
        const execution = await tool.resolveExecution(req.arguments);

        if ('isError' in execution && execution.isError) {
          const output = typeof execution.output === 'string'
            ? execution.output
            : JSON.stringify(execution.output);
          return { content: output, is_error: true };
        }

        if ('execute' in execution) {
          const result = await execution.execute({
            turnId: req.turn_id,
            toolCallId: req.tool_call_id,
            signal: input.signal,
          });

          const output = typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output);
          return { content: output, is_error: 'isError' in result && result.isError === true };
        }

        return { content: 'Tool execution resolved without executable', is_error: true };
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          is_error: true,
        };
      }
    });

    // Send the turn to the Rust binary
    const result = await agent.request('agent/run_turn', {
      turn_id: input.turnId,
      system_prompt: input.llm.systemPrompt,
      model_name: input.llm.modelName,
      messages: messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => ('text' in p ? p.text : '')).join('\n'),
      })),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema ?? {},
      })),
      max_steps: input.maxSteps ?? 10,
    });

    if (!result) {
      throw new Error('Rust engine returned null result');
    }

    const rustResult = result as RunTurnResult;

    // Map Rust stop reason to JS LoopTurnStopReason
    const stopReason = mapStopReason(rustResult.stop_reason);

    return {
      stopReason,
      steps: rustResult.steps,
      usage: {
        inputOther: rustResult.usage.input_tokens,
        output: rustResult.usage.output_tokens,
        inputCacheRead: 0,
        inputCacheCreation: 0,
      },
    };
  };
}

/**
 * Map Rust-style stop reason to JS LoopTurnStopReason.
 */
function mapStopReason(reason: string): import('@moonshot-ai/agent-core').LoopTurnStopReason {
  switch (reason) {
    case 'EndTurn': return 'end_turn' as never;
    case 'MaxTokens': return 'max_tokens' as never;
    case 'Filtered': return 'filtered' as never;
    case 'Paused': return 'paused' as never;
    case 'Aborted': return 'aborted' as never;
    default: return 'unknown' as never;
  }
}

/**
 * Try to parse a JSON string into a value. Returns the original string if parsing fails.
 */
function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function isRustEngineAvailable(): boolean {
  return AgentProcess.findBinary() !== null;
}

export function shutdownRustEngine() {
  if (agentProcess) {
    agentProcess.stop();
    agentProcess = null;
  }
}