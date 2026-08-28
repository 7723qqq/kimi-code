/// Rust agent engine adapter (experimental).
///
/// Wired into the agent-core-v2 turn loop through the
/// `IEngineOverrideService` extension point: when `agent.engine = "rust"`
/// is set in config.toml, `createRunTurnOverride` produces a `TurnEngine`
/// that drives the whole turn in place of the JS loop. Two transport modes
/// are supported, selected automatically at startup:
///
/// 1. **napi-rs** (preferred): The native `kimi_agent.node` addon is
///    loaded directly into the Node.js process. Host callbacks are
///    invoked as JS functions via ThreadsafeFunction — no serialization
///    overhead and no subprocess management.
/// 2. **stdio JSON-RPC** (fallback): The `kimi-agent-cli` Rust binary
///    is spawned as a child process and communicates via JSON-RPC over
///    stdin/stdout.
///
/// If neither is available, it falls back to the JS implementation.

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// Project root: packages/kimi-agent/rust-loop.ts → ../../ (project root)
const projectRoot = resolve(import.meta.dirname, '..', '..');

/**
 * Native workspace index predict-read is not wired in this build; the JS
 * fallback (`predictReadViaFs`) is always used. Kept for API parity with the
 * planned Rust workspace index integration.
 */
type NativeReadPrediction = { preview: string; lineCount: number; size: number };
function tryNativeWorkspaceIndexPredictRead(_path: string): NativeReadPrediction | null {
  return null;
}

/**
 * The v2 engine override contract this adapter implements. Imported
 * type-only from agent-core-v2 so the shape stays in sync without a
 * runtime dependency. `createRunTurnOverride` returns this type.
 */
export type TurnEngineAdapter = import('@moonshot-ai/agent-core-v2').TurnEngine;
export type TurnEngineInputAdapter = import('@moonshot-ai/agent-core-v2').TurnEngineInput;
export type TurnEngineToolResultAdapter = import('@moonshot-ai/agent-core-v2').TurnEngineToolResult;

/** Token usage carried on step.end (structurally matches kosong's TokenUsage). */
interface HostTokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

const ZERO_USAGE: HostTokenUsage = {
  inputOther: 0,
  output: 0,
  inputCacheRead: 0,
  inputCacheCreation: 0,
};

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
  /** Multiple LLM providers for concurrent execution (MultiLLM). */
  providers?: LlmProviderDef[];
  /** Optional goal context for budget-aware execution. */
  goal?: GoalContext;
}

/** Goal status matching the Rust GoalStatus enum. */
type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'budgetLimited' | 'usageLimited';

/** Goal context passed to the Rust engine for budget-aware turns. */
interface GoalContext {
  goal_id: string;
  objective: string;
  status: GoalStatus;
  token_budget?: number;
  turn_budget?: number;
  tokens_used: number;
  turns_used: number;
}

interface LlmProviderDef {
  name: string;
  model: string;
  system_prompt: string;
}

/** Native HTTP LLM transport config (snake_case matches the Rust wire). */
export interface NativeLlmDef {
  /** "openai" (Chat Completions) or "anthropic" (Messages). */
  protocol: 'openai' | 'anthropic';
  /** API base URL including the version segment (e.g. `.../v1`). */
  base_url: string;
  api_key: string;
  model: string;
  max_tokens?: number;
}

/** Options controlling the native (in-Rust) execution paths. */
export interface RustEngineOptions {
  /**
   * When set, the Rust engine calls this provider directly over HTTP.
   * Can be a static value or a function evaluated fresh on each turn so
   * that model switches in the TUI are reflected.
   */
  nativeLlm?: NativeLlmDef | (() => NativeLlmDef | undefined);
  /** When true, Read/Grep/Glob execute inside the Rust process. */
  nativeTools?: boolean;
}

/** A content block on the Rust wire (see `ContentBlock` in rpc/types.rs). */
type WireContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string }
  | { type: 'image_url'; url: string };

/** Fire-and-forget engine event (Rust → host, `host/event`). */
interface EngineEvent {
  type: string;
  [key: string]: unknown;
}

interface RunTurnResult {
  stop_reason: string;
  steps: number;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number };
}

/** A message on the Rust wire, with optional multimodal/tool-call payloads. */
interface WireMessage {
  role: string;
  content: string;
  blocks?: WireContentBlock[];
  tool_calls?: { id: string; name: string; arguments: unknown }[];
  tool_call_id?: string;
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
  /** When true, skip workspace index predictions and execute precisely. */
  force_precise?: boolean;
}

interface ToolExecuteResponse {
  content: string;
  is_error: boolean;
  /** When true, the result is a fast prediction from the workspace index. */
  is_prediction?: boolean;
}

/**
 * Classify an incoming RPC line. A JSON-RPC request always carries `method`; a
 * response never does. Discriminating on `method` FIRST prevents a Rust host
 * request whose id collides with a pending request id from being mis-routed as
 * that request's response (both sides allocate ids from 1).
 */
export function classifyRpcMessage(msg: RpcMessage): 'request' | 'response' | 'ignore' {
  if (msg.method !== undefined) {
    return msg.id !== undefined ? 'request' : 'ignore';
  }
  return msg.id !== undefined ? 'response' : 'ignore';
}

// ── Napi result types (matching Rust JsRunTurnResult) ────────────────────

interface NapiRunTurnResult {
  stopReason: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ── Napi engine (in-process native addon) ─────────────────────────────────

/** Shape of the loaded `kimi_agent.node` native addon. */
interface KimiAgentNativeModule {
  getCallbackPayload(id: number): string | null;
  resolveCallback(id: number, error: string | null, result: string | null): void;
  runTurnRust(
    params: unknown,
    llmChatCb: (callbackId: number) => void,
    executeToolCb: (callbackId: number) => void,
    emitEventCb?: (callbackId: number) => void,
  ): Promise<NapiRunTurnResult>;
}

class NapiEngine {
  private nativeModule: KimiAgentNativeModule | null = null;
  private loaded = false;

  static findModule(): string | null {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const candidates: string[] = [
      // Development / production source tree: the napi build emits a
      // platform-suffixed name (e.g. kimi_agent.win32-x64-msvc.node), so glob
      // instead of requiring a fixed `kimi_agent.node` path.
      resolve(import.meta.dirname, 'kimi_agent.node'),
      resolve(projectRoot, 'packages/kimi-agent/kimi_agent.node'),
    ];
    for (const dir of [import.meta.dirname, resolve(projectRoot, 'packages/kimi-agent')]) {
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (entry.endsWith('.node') && entry.startsWith('kimi_agent')) {
            candidates.push(resolve(dir, entry));
          }
        }
      } catch {
        // ignore unreadable dirs
      }
    }

    // Packaged single-file binary: the .node file is embedded as a native
    // asset and extracted to a cache directory at runtime. The global
    // helper `__kimi_getNativePackageRoot` (installed by native-assets.ts)
    // returns the cached package root for a given package name.
    const getNativePackageRoot = (globalThis as Record<string, unknown>)[
      '__kimi_getNativePackageRoot'
    ];
    const seaPkgRoot =
      typeof getNativePackageRoot === 'function'
        ? (getNativePackageRoot as (pkg: string) => string | null)('@moonshot-ai/kimi-agent')
        : undefined;
    if (seaPkgRoot !== null && seaPkgRoot !== undefined) {
      // The .node file may be named with a platform suffix (e.g.
      // kimi_agent.win32-x64-msvc.node) or plain kimi_agent.node.
      try {
        const entries = fs.readdirSync(seaPkgRoot);
        for (const entry of entries) {
          if (entry.endsWith('.node') && entry.startsWith('kimi_agent')) {
            candidates.push(resolve(seaPkgRoot, entry));
          }
        }
      } catch {
        // ignore
      }
    }

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // ignore
      }
    }
    return null;
  }

  static isAvailable(): boolean {
    return NapiEngine.findModule() !== null;
  }

  load(): boolean {
    if (this.loaded) return true;
    const modulePath = NapiEngine.findModule();
    if (!modulePath) {
      console.warn('[kimi-agent] napi module not found');
      return false;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.nativeModule = require(modulePath) as KimiAgentNativeModule;
      this.loaded = true;
      return true;
    } catch (error) {
      console.warn('[kimi-agent] Failed to load napi module:', error);
      return false;
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Call the native runTurnRust function.
   *
   * Internally wraps the callbacks to use the **callback registry** pattern:
   * Rust invokes each JS callback with a single `callbackId: number`. The
   * handler fetches the request payload via `getCallbackPayload(id)`, calls
   * the user's async callback with the payload, then resolves via
   * `resolveCallback(id, err?, result?)`.
   *
   * The two callbacks receive JSON-serialized request payloads and must
   * return JSON-serialized response payloads (or a Promise resolving to one):
   *   - llmChatCb: receives `LlmChatRequest` JSON, returns `LlmChatResponse` JSON
   *   - executeToolCb: receives `ToolExecuteRequest` JSON, returns `ToolExecuteResponse` JSON
   */
  async runTurn(
    params: {
      turnId: string;
      systemPrompt: string;
      modelName: string;
      messages: Array<{
        role: string;
        content: string;
        blocksJson?: string;
        toolCallsJson?: string;
        toolCallId?: string;
      }>;
      tools: Array<{ name: string; description: string; inputSchema: string }>;
      maxSteps?: number;
      goal?: {
        goalId: string;
        objective: string;
        status: string;
        tokenBudget?: number;
        turnBudget?: number;
        tokensUsed: number;
        turnsUsed: number;
      };
      nativeLlm?: {
        protocol: string;
        baseUrl: string;
        apiKey: string;
        model: string;
        maxTokens?: number;
      };
      workspaceRoot?: string;
      nativeTools?: boolean;
    },
    llmChatCb: (request: string) => Promise<string>,
    executeToolCb: (request: string) => Promise<string>,
    emitEventCb?: (event: EngineEvent) => void,
  ): Promise<NapiRunTurnResult> {
    if (!this.nativeModule) {
      throw new Error('Napi module not loaded');
    }

    const nativeModule = this.nativeModule;

    /**
     * Create a callback handler for the native module.
     *
     * The native module passes a `callbackId: number` to the JS callback.
     * The handler fetches the payload via `getCallbackPayload(id)`,
     * calls the user's async handler with the payload, then resolves via
     * `resolveCallback(id, error?, result?)`.
     */
    const makeCallbackHandler = (handler: (request: string) => Promise<string>) => {
      return (callbackId: number) => {
        const payload = nativeModule.getCallbackPayload(callbackId);
        if (!payload) return;
        handler(payload).then(
          (result) => {
            nativeModule.resolveCallback(callbackId, null, result);
          },
          (error: unknown) => {
            nativeModule.resolveCallback(
              callbackId,
              error instanceof Error ? error.message : String(error),
              null,
            );
          },
        );
      };
    };

    // Fire-and-forget event channel: fetch the payload but never resolve.
    const eventHandler =
      emitEventCb === undefined
        ? undefined
        : (callbackId: number) => {
            const payload = nativeModule.getCallbackPayload(callbackId);
            if (!payload) return;
            try {
              emitEventCb(JSON.parse(payload) as EngineEvent);
            } catch {
              // Malformed events are dropped; they must never break the turn.
            }
          };

    return nativeModule.runTurnRust(
      params,
      makeCallbackHandler(llmChatCb),
      makeCallbackHandler(executeToolCb),
      eventHandler,
    );
  }
}

// ── Agent process manager (stdio JSON-RPC) ────────────────────────────────

class AgentProcess {
  // kimi-agent has no tsconfig of its own (it is a Rust package), so
  // type-aware oxlint resolves `ChildProcess` as an error/any type here and
  // flags the union as redundant. The file is a standalone JS companion that
  // is type-checked by no project; disable the rule for this line only.
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = '';
  private ready = false;

  /** Callback for handling host/llm_chat requests from the Rust side. */
  private llmChatHandler: ((req: LlmChatRequest) => Promise<LlmChatResponse>) | null = null;

  /** Callback for handling host/execute_tool requests from the Rust side. */
  private toolExecuteHandler: ((req: ToolExecuteRequest) => Promise<ToolExecuteResponse>) | null =
    null;

  /** Callback for fire-and-forget host/event notifications from Rust. */
  private eventHandler: ((event: EngineEvent) => void) | null = null;

  setLlmChatHandler(handler: (req: LlmChatRequest) => Promise<LlmChatResponse>) {
    this.llmChatHandler = handler;
  }

  setToolExecuteHandler(handler: (req: ToolExecuteRequest) => Promise<ToolExecuteResponse>) {
    this.toolExecuteHandler = handler;
  }

  setEventHandler(handler: (event: EngineEvent) => void) {
    this.eventHandler = handler;
  }

  static findBinary(): string | null {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const arch = `${process.platform}-${process.arch}`;
    const candidates = [
      // Development: directly from Rust build output
      resolve(projectRoot, 'packages/kimi-agent/target/release/kimi-agent-cli' + ext),
      resolve(projectRoot, 'packages/kimi-agent/target/debug/kimi-agent-cli' + ext),
      // Production: bundled alongside the packaged single-file binary
      resolve(projectRoot, 'dist-native', 'bin', arch, 'kimi-agent-cli' + ext),
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
    } catch (error) {
      console.warn('[kimi-agent] Failed to start:', error);
      return false;
    }
  }

  private processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as RpcMessage;

        switch (classifyRpcMessage(msg)) {
          case 'request':
            this.handleHostRequest(msg).catch((error) => {
              console.error('[kimi-agent] Failed to handle host request:', error);
            });
            break;
          case 'response': {
            if (this.pending.has(msg.id as number)) {
              const pending = this.pending.get(msg.id as number)!;
              if (msg.error) {
                pending.reject(new Error(msg.error.message));
              } else {
                pending.resolve(msg.result);
              }
              this.pending.delete(msg.id as number);
            }
            break;
          }
          case 'ignore':
            // A method without an id is a notification — the engine's
            // fire-and-forget event channel arrives this way.
            if (msg.method === 'host/event' && this.eventHandler) {
              try {
                this.eventHandler(msg.params as EngineEvent);
              } catch {
                // Event handler failures must never break the RPC loop.
              }
            }
            break;
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
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
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
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
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

// ── Engine selection ──────────────────────────────────────────────────────

/// Which transport is active for the current session.
type EngineMode = 'napi' | 'stdio' | 'js';

let engineMode: EngineMode = 'js';
let agentProcess: AgentProcess | null = null;
let napiEngine: NapiEngine | null = null;

/**
 * Initialize the Rust engine, preferring napi-rs over stdio JSON-RPC.
 * Returns the selected mode. Called once on first use; subsequent calls
 * return the same mode.
 */
function initEngine(): EngineMode {
  if (engineMode !== 'js') return engineMode;

  // 1) Try napi-rs first (in-process, no subprocess overhead)
  if (NapiEngine.isAvailable()) {
    const engine = new NapiEngine();
    if (engine.load()) {
      napiEngine = engine;
      engineMode = 'napi';
      return 'napi';
    }
  }

  // 2) Fall back to stdio JSON-RPC
  const process = new AgentProcess();
  if (process.start()) {
    agentProcess = process;
    engineMode = 'stdio';
    return 'stdio';
  }

  // 3) Both unavailable — fall back to JS
  engineMode = 'js';
  return 'js';
}

function getAgent(): AgentProcess | null {
  initEngine();
  return agentProcess;
}

function getNapiEngine(): NapiEngine | null {
  initEngine();
  return napiEngine;
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
  } catch (error) {
    console.error('[kimi-agent] RPC call failed:', error);
    return null;
  }
}

/**
 * Create a `TurnEngine` adapter wired into the agent-core-v2 loop through
 * `IEngineOverrideService`.
 *
 * This adapter bridges the v2 `TurnEngineInput` and the Rust kimi-agent
 * engine. The host stays authoritative: Rust drives control flow and calls
 * back per step/tool, while the host owns the message history and
 * transcript. It:
 * 1. Sends `agent/run_turn` to the Rust binary (no message content — see below)
 * 2. Handles `host/llm_chat` by rebuilding messages from `context` and calling
 *    `input.llm.chat()`, dispatching step/content events as it goes
 * 3. Handles `host/execute_tool` by delegating to `input.executeTool`
 *    (the host's toolExecutor runs the permission gate and lifecycle) and
 *    dispatching tool.call / tool.result
 * 4. Maps the Rust response back to the v2 `TurnEngineResult` type
 *
 * Returns `undefined` when the Rust binary is not available (falls back to JS).
 */
export function createRunTurnOverride(
  providers?: LlmProviderDef[],
  workspaceRoot?: string,
  options?: RustEngineOptions,
): TurnEngineAdapter | undefined {
  const mode = initEngine();
  if (mode === 'js') return undefined;

  const nativeLlmOpt = options?.nativeLlm;
  const nativeTools = options?.nativeTools === true;

  return async (input) => {
    // v2 hands us a numeric turnId; the wire protocol and LoopRecordedEvent
    // use a string, so normalize once per turn.
    const turnIdStr = String(input.turnId);

    // Resolve nativeLlm fresh per turn: when a function is provided it
    // re-reads the config file so TUI model switches are reflected.
    const resolvedNativeLlm = typeof nativeLlmOpt === 'function' ? nativeLlmOpt() : nativeLlmOpt;

    // Guard: when the user switches models in the TUI, the session's LLM
    // adapter (input.llm) is updated to the new provider/model, but the
    // nativeLlm config (read from config.toml) may still point to the old
    // provider. If the models don't match, fall back to the host proxy
    // (host/llm_chat) which always follows the session's current model.
    const nativeLlm =
      resolvedNativeLlm !== undefined && resolvedNativeLlm.model !== input.llm.modelName
        ? undefined
        : resolvedNativeLlm;

    // The prediction fast-path is disabled (see header note): all reads
    // execute precisely on the first call.

    // Step lifecycle. The host owns the transcript AND the message history:
    // Rust drives control flow and calls back per LLM step and per tool. We
    // open an assistant "step" on host/llm_chat and keep it open — recording
    // tool.call / tool.result against it — until the next llm_chat (or turn
    // end) closes it with step.end. buildMessages() re-reads `context` each
    // step, so these recorded events are exactly what thread history forward.
    let currentStep = 0;
    let openStep: { uuid: string; step: number; usage: HostTokenUsage } | undefined;
    const closeOpenStep = async (): Promise<void> => {
      if (openStep === undefined) return;
      const { uuid, step, usage } = openStep;
      openStep = undefined;
      await input.dispatchEvent({ type: 'step.end', uuid, turnId: turnIdStr, step, usage });
    };
    const outputToContent = (output: unknown): string =>
      typeof output === 'string' ? output : JSON.stringify(output);

    // ── Engine event handler (native LLM / native tool paths) ────────
    // Rust reports step boundaries, streaming deltas, and natively-executed
    // tool results over the fire-and-forget event channel. Events arrive
    // synchronously but dispatching is async, so they are serialized
    // through a promise chain to preserve transcript ordering.
    let eventChain: Promise<void> = Promise.resolve();
    const processEngineEvent = async (event: EngineEvent): Promise<void> => {
      switch (event.type) {
        case 'llm.step.begin': {
          await closeOpenStep();
          currentStep += 1;
          const stepUuid = randomUUID();
          await input.dispatchEvent({
            type: 'step.begin',
            uuid: stepUuid,
            turnId: turnIdStr,
            step: currentStep,
          });
          openStep = { uuid: stepUuid, step: currentStep, usage: { ...ZERO_USAGE } };
          break;
        }
        case 'llm.delta': {
          if (openStep === undefined) break;
          await input.dispatchEvent({
            type: 'content.part',
            uuid: randomUUID(),
            turnId: turnIdStr,
            step: openStep.step,
            stepUuid: openStep.uuid,
            part: event['part'] as never,
          });
          break;
        }
        case 'llm.step.end': {
          if (openStep === undefined) break;
          const usage = event['usage'] as
            | { input_tokens?: number; output_tokens?: number }
            | undefined;
          openStep.usage = {
            inputOther: usage?.input_tokens ?? 0,
            output: usage?.output_tokens ?? 0,
            inputCacheRead: 0,
            inputCacheCreation: 0,
          };
          break;
        }
        case 'tool.native': {
          // A tool that executed inside the Rust process — mirror the
          // call/result pair into the transcript.
          if (openStep === undefined) break;
          const rawCallId = event['tool_call_id'];
          const toolCallId = typeof rawCallId === 'string' ? rawCallId : randomUUID();
          const toolName = typeof event['tool_name'] === 'string' ? event['tool_name'] : '';
          await input.dispatchEvent({
            type: 'tool.call',
            uuid: toolCallId,
            turnId: turnIdStr,
            step: openStep.step,
            stepUuid: openStep.uuid,
            toolCallId,
            name: toolName,
            args: event['arguments'],
          });
          await input.dispatchEvent({
            type: 'tool.result',
            parentUuid: toolCallId,
            toolCallId,
            result: { output: event['content'], isError: event['is_error'] === true } as never,
          });
          break;
        }
        default:
          break;
      }
    };
    const handleEngineEvent = (event: EngineEvent): void => {
      eventChain = eventChain.then(() => processEngineEvent(event)).catch(() => {});
    };

    // ── Native LLM initial messages ───────────────────────────────
    // When Rust calls the provider directly it owns the in-turn message
    // history, so the host serializes the current history (text, images,
    // and tool-call structure) once at turn start.
    interface HostContentPart {
      type: string;
      text?: string;
      imageUrl?: { url: string };
    }
    interface HostMessage {
      role: string;
      content: HostContentPart[];
      toolCalls?: { id: string; name: string; arguments: string | null }[];
      toolCallId?: string;
    }
    const toWireMessage = (m: HostMessage): WireMessage => {
      let text = '';
      let hasMedia = false;
      const blocks: WireContentBlock[] = [];
      for (const part of m.content) {
        if (part.type === 'text' && typeof part.text === 'string') {
          text += part.text;
          blocks.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url' && part.imageUrl?.url !== undefined) {
          hasMedia = true;
          blocks.push({ type: 'image_url', url: part.imageUrl.url });
        }
        // think/audio/video parts are not projected to the native wire.
      }
      const toolCalls = (m.toolCalls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments === null ? {} : tryParseJson(tc.arguments),
      }));
      return {
        role: m.role,
        content: text,
        blocks: hasMedia ? blocks : undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        tool_call_id: m.toolCallId,
      };
    };
    const buildWireMessages = async (): Promise<WireMessage[]> => {
      const messages = (await input.buildMessages()) as unknown as HostMessage[];
      return messages.map(toWireMessage);
    };
    const buildWireTools = (): { name: string; description: string; parameters: unknown }[] => {
      const stepTools = input.buildTools();
      return stepTools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: (t as { parameters?: unknown }).parameters ?? {},
      }));
    };

    // ── LLM chat handler ──────────────────────────────────────────────
    const llmChatHandler = async (): Promise<LlmChatResponse> => {
      await closeOpenStep();
      currentStep += 1;
      const stepUuid = randomUUID();
      const stepNum = currentStep;
      await input.dispatchEvent({
        type: 'step.begin',
        uuid: stepUuid,
        turnId: turnIdStr,
        step: stepNum,
      });
      openStep = { uuid: stepUuid, step: stepNum, usage: { ...ZERO_USAGE } };

      const messages = await input.buildMessages();
      const stepTools = input.buildTools();

      const response = await input.llm.chat({
        messages,
        tools: stepTools,
        signal: input.signal,
        onTextPart: async (part) => {
          await input.dispatchEvent({
            type: 'content.part',
            uuid: randomUUID(),
            turnId: turnIdStr,
            step: stepNum,
            stepUuid,
            part,
          });
        },
        onThinkPart: async (part) => {
          await input.dispatchEvent({
            type: 'content.part',
            uuid: randomUUID(),
            turnId: turnIdStr,
            step: stepNum,
            stepUuid,
            part,
          });
        },
      });
      if (openStep !== undefined) openStep.usage = response.usage;

      return {
        tool_calls:
          response.toolCalls?.map((tc) => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments ? tryParseJson(tc.arguments) : null,
          })) ?? [],
        finish_reason: response.providerFinishReason ?? 'stop',
        usage: {
          input_tokens: response.usage?.inputOther ?? 0,
          output_tokens: response.usage?.output ?? 0,
          total_tokens: (response.usage?.inputOther ?? 0) + (response.usage?.output ?? 0),
        },
      };
    };

    // ── Tool execution handler ────────────────────────────────────────
    const toolExecuteHandler = async (req: ToolExecuteRequest): Promise<ToolExecuteResponse> => {
      const toolCallId = req.tool_call_id;
      const stepUuid = openStep?.uuid;
      const stepNum = openStep?.step ?? currentStep;
      const toolCall = {
        type: 'function' as const,
        id: toolCallId,
        name: req.tool_name,
        arguments: req.arguments === undefined ? null : JSON.stringify(req.arguments),
      };

      // Delegate the full tool lifecycle (prepare, permission gate, execute,
      // finalize) to the host's toolExecutor — the exact same path the JS
      // loop uses. The host owns permission and the execution; we only bridge
      // tool.call / tool.result into the transcript via dispatchEvent.
      const outcome = await input.executeTool(toolCall, {
        signal: input.signal,
        turnId: input.turnId,
        step: stepNum,
        stepUuid,
        onToolCall: (payload) => {
          if (stepUuid === undefined) return;
          void input.dispatchEvent({
            type: 'tool.call',
            uuid: payload.toolCallId,
            turnId: turnIdStr,
            step: stepNum,
            stepUuid,
            toolCallId: payload.toolCallId,
            name: payload.name,
            args: payload.args,
          });
        },
      });

      if (stepUuid !== undefined) {
        await input.dispatchEvent({
          type: 'tool.result',
          parentUuid: toolCallId,
          toolCallId,
          result: { output: outcome.output, isError: outcome.isError, note: outcome.note },
        });
      }
      return {
        content: outputToContent(outcome.output),
        is_error: outcome.isError === true,
      };
    };

    // ── Drive the turn ────────────────────────────────────────────────
    // In host-proxy mode, message content and the tool table are NOT sent:
    // the host rebuilds both from `context` on every host/llm_chat callback
    // (the source of truth), so Rust only needs metadata to drive control
    // flow. In native LLM mode, Rust calls the provider itself, so the
    // initial history and tool schemas are serialized up front and progress
    // flows back over the event channel.
    const wireMessages = nativeLlm === undefined ? [] : await buildWireMessages();
    const wireTools = nativeLlm === undefined ? [] : buildWireTools();
    let rustResult: RunTurnResult;
    try {
      if (mode === 'napi') {
        const engine = getNapiEngine()!;
        // Napi callbacks use JSON-serialized payloads (string → string)
        const napiResult = await engine.runTurn(
          {
            turnId: turnIdStr,
            systemPrompt: input.llm.systemPrompt,
            modelName: input.llm.modelName,
            messages: wireMessages.map((m) => ({
              role: m.role,
              content: m.content,
              blocksJson: m.blocks === undefined ? undefined : JSON.stringify(m.blocks),
              toolCallsJson: m.tool_calls === undefined ? undefined : JSON.stringify(m.tool_calls),
              toolCallId: m.tool_call_id,
            })),
            tools: wireTools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: JSON.stringify(t.parameters ?? {}),
            })),
            maxSteps: input.maxSteps ?? 10,
            nativeLlm:
              nativeLlm === undefined
                ? undefined
                : {
                    protocol: nativeLlm.protocol,
                    apiKey: nativeLlm.api_key,
                    baseUrl: nativeLlm.base_url,
                    model: nativeLlm.model,
                    maxTokens: nativeLlm.max_tokens,
                  },
            workspaceRoot,
            nativeTools,
          },
          // Wrap structured handler with JSON serialization for napi
          async (_requestJson: string) => {
            const response = await llmChatHandler();
            return JSON.stringify(response);
          },
          async (requestJson: string) => {
            const req = JSON.parse(requestJson) as ToolExecuteRequest;
            const response = await toolExecuteHandler(req);
            return JSON.stringify(response);
          },
          handleEngineEvent,
        );
        rustResult = {
          stop_reason: napiResult.stopReason,
          steps: napiResult.steps,
          usage: {
            input_tokens: napiResult.inputTokens,
            output_tokens: napiResult.outputTokens,
            total_tokens: napiResult.totalTokens,
          },
        };
      } else {
        // stdio JSON-RPC path
        const agent = getAgent()!;
        agent.setLlmChatHandler(llmChatHandler);
        agent.setToolExecuteHandler(toolExecuteHandler);
        agent.setEventHandler(handleEngineEvent);

        const result = await agent.request('agent/run_turn', {
          turn_id: turnIdStr,
          system_prompt: input.llm.systemPrompt,
          model_name: input.llm.modelName,
          messages: wireMessages,
          tools: wireTools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters ?? {},
          })),
          max_steps: input.maxSteps ?? 10,
          providers: providers ?? [],
          native_llm: nativeLlm,
          workspace_root: workspaceRoot,
          native_tools: nativeTools,
        });
        if (!result) {
          throw new Error('Rust engine returned null result');
        }
        rustResult = result as RunTurnResult;
      }
    } finally {
      // Flush queued engine events before closing the last step so the
      // transcript records deltas/tool results in order.
      await eventChain.catch(() => {});
      await closeOpenStep();
    }

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
 * Map Rust-style stop reason to the agent-core-v2 `FinishReason`.
 */
export function mapStopReason(reason: string): import('@moonshot-ai/agent-core-v2').FinishReason {
  switch (reason) {
    case 'EndTurn':
      return 'completed';
    case 'MaxTokens':
      return 'truncated';
    case 'Filtered':
      return 'filtered';
    case 'Paused':
      return 'paused';
    case 'Aborted':
    case 'BudgetLimited':
    default:
      return 'other';
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
  return NapiEngine.isAvailable() || AgentProcess.findBinary() !== null;
}

export function shutdownRustEngine() {
  if (agentProcess) {
    agentProcess.stop();
    agentProcess = null;
  }
  napiEngine = null;
  engineMode = 'js';
}

// ── Workspace prediction ──────────────────────────────────────────────────

/// Maximum file size for which we offer a prediction (100 KB).
/// Larger files skip the fast-path and execute precisely on the first call.
const PREDICTION_MAX_FILE_SIZE = 100 * 1024;

/// Number of preview lines included in the prediction.
const PREDICTION_PREVIEW_LINES = 5;

/**
 * Lightweight workspace file predictor for the Read tool fast-path.
 *
 * Instead of pre-scanning the entire workspace (like the Rust WorkspaceIndex),
 * this class checks individual files on-demand: stat + read first N lines.
 * This avoids the startup cost of building a full index while still
 * providing instant predictions for most Read calls.
 *
 * The prediction includes the first few lines with line numbers and a
 * note that it's a prediction — the precise result will replace it shortly.
 *
 * The Rust workspace index fast path is not wired in this build:
 * `tryNativeWorkspaceIndexPredictRead` always returns null, so every
 * prediction goes through the on-demand JS stat path.
 */
export class WorkspacePredictor {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Generate a Read prediction for the given path.
   *
   * Uses an on-demand stat + read of the first N lines. (The preheated
   * Rust workspace index fast path is not wired in this build.)
   *
   * Returns null when:
   *   - The file doesn't exist or is not a regular file
   *   - The file is too large (> 100 KB)
   *   - The file contains NUL bytes (binary)
   *   - fs/stat is not available (sandboxed environment)
   */
  predictRead(path: string): string | null {
    // 1) Try the preheated native workspace index first.
    const nativePrediction = tryNativeWorkspaceIndexPredictRead(path);
    if (nativePrediction !== undefined && nativePrediction !== null) {
      return this.formatNativePrediction(path, nativePrediction);
    }

    // 2) Fall back to on-demand JS stat + read.
    return this.predictReadViaFs(path);
  }

  /**
   * Format a native index prediction into the same shape as the JS path.
   */
  private formatNativePrediction(path: string, p: NativeReadPrediction): string {
    const previewLines = p.preview.split('\n').slice(0, PREDICTION_PREVIEW_LINES);
    const numbered = previewLines
      .map((line, i) => `${String(i + 1).padStart(6)}→${line}`)
      .join('\n');
    return (
      `cat ${path}  (prediction: ${p.lineCount} lines, ${p.size} bytes)\n` +
      `${numbered}\n` +
      `\n[... prediction — precise result loading ...]`
    );
  }

  /**
   * On-demand JS fallback: stat + read first N lines.
   */
  private predictReadViaFs(path: string): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs');

      const resolved = this.resolvePath(path);
      if (resolved === null) return null;

      const stat = fs.statSync(resolved, { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile()) return null;
      if (stat.size > PREDICTION_MAX_FILE_SIZE) return null;
      if (stat.size === 0) return null;

      // Read first N lines
      const fd = fs.openSync(resolved, 'r');
      try {
        const buf = Buffer.alloc(Math.min(stat.size, 8192));
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        const content = buf.subarray(0, bytesRead).toString('utf-8');

        // Binary detection: NUL byte
        if (content.includes('\0')) return null;

        const lines = content.split('\n');
        const previewLines = lines.slice(0, PREDICTION_PREVIEW_LINES);
        const numbered = previewLines
          .map((line, i) => `${String(i + 1).padStart(6)}→${line}`)
          .join('\n');

        const lineCount = stat.size > 0 ? this.estimateLineCount(resolved, stat.size) : 0;
        return (
          `cat ${path}  (prediction: ${lineCount} lines, ${stat.size} bytes)\n` +
          `${numbered}\n` +
          `\n[... prediction — precise result loading ...]`
        );
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  /**
   * Resolve a path relative to the workspace root.
   * Returns null if the path is outside the workspace.
   */
  private resolvePath(path: string): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pathMod = require('node:path') as typeof import('node:path');
      const resolved = pathMod.isAbsolute(path) ? path : pathMod.resolve(this.root, path);
      return resolved;
    } catch {
      return null;
    }
  }

  /**
   * Quick line count estimate without reading the whole file.
   * Uses the average line length from the preview.
   */
  private estimateLineCount(filePath: string, fileSize: number): number {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs');
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(Math.min(fileSize, 8192));
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        const sample = buf.subarray(0, bytesRead).toString('utf-8');
        const sampleLines = sample.split('\n').length;
        const avgLineLength = bytesRead / sampleLines;
        return Math.ceil(fileSize / avgLineLength);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return 0;
    }
  }
}
