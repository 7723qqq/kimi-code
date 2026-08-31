// The engine intentionally logs lifecycle diagnostics (fallback warnings,
// stderr forwarding, request handler errors) to the console so they reach
// the operator when the native addon is missing, the stdio binary fails
// to start, or the host RPC dispatcher hits an unhandled exception.
// oxlint-disable no-console
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

import type { JsRunTurnParams, JsRunTurnResult } from './napi-contract';

// Project root: packages/kimi-agent/rust-loop.ts → ../../ (project root)
const projectRoot = resolve(import.meta.dirname, '..', '..');

/**
 * The v2 engine override contract this adapter implements. Imported
 * type-only from agent-core-v2 so the shape stays in sync without a
 * runtime dependency. `createRunTurnOverride` returns this type.
 */
export type TurnEngineAdapter = import('@moonshot-ai/agent-core-v2').TurnEngine;
export type TurnEngineInputAdapter = import('@moonshot-ai/agent-core-v2').TurnEngineInput;
export type TurnEngineToolResultAdapter = import('@moonshot-ai/agent-core-v2').TurnEngineToolResult;
export type AskQuestionWire = import('@moonshot-ai/agent-core-v2').AskQuestionWire;
export type AskQuestionWireResult = import('@moonshot-ai/agent-core-v2').AskQuestionWireResult;
export type StateReadWire = import('@moonshot-ai/agent-core-v2').StateReadWire;
export type StateReadWireResult = import('@moonshot-ai/agent-core-v2').StateReadWireResult;
export type StateWriteWire = import('@moonshot-ai/agent-core-v2').StateWriteWire;
export type StateWriteWireResult = import('@moonshot-ai/agent-core-v2').StateWriteWireResult;

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

/** Goal status matching the Rust GoalStatus enum. */
type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'budgetLimited' | 'usageLimited';

/** Goal context passed to the Rust engine for budget-aware turns. */
interface GoalContext {
  goal_id: string;
  objective: string;
  status: GoalStatus;
  token_budget?: number;
  turn_budget?: number;
  wall_clock_budget_ms?: number;
  wall_clock_ms: number;
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
  /**
   * When true, the in-process toolset (Read/Grep/Glob/Write/Edit/Bash)
   * executes inside the Rust process, sandboxed to the workspace. Any
   * other tool, or any argument shape the toolset cannot handle, still
   * round-trips to the host via `host/execute_tool`.
   */
  nativeTools?: boolean;
  /**
   * When true, the Rust engine refuses to fall back to the host proxy
   * for LLM calls — the user must configure `nativeLlm` or `providers`,
   * or the engine errors out at construction time. Mirrors
   * `agent.rustSelfContained` from config. See kimi-agent ROADMAP P26
   * 批 1. Default `false` (backwards compatible).
   */
  rustSelfContained?: boolean;
  /**
   * Host shell for native Bash (bash everywhere, Git Bash on Windows —
   * the value from the host environment probe). Without it, native Bash
   * stays with the host on Windows: the engine will not guess a shell
   * that could diverge from the tool's documented bash contract.
   */
  shellPath?: string;
  /**
   * Resolve the `[github]` config credentials for the native GitHub tools.
   * Read fresh on each turn so config edits (token rotation) are reflected.
   * Env fallbacks (`GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_API_URL`) are
   * applied Rust-side, mirroring v2's envOverlay: config wins, env fills
   * the gap. When undefined, the engine runs GitHub tools on env alone.
   */
  getGithubCredentials?: () => { token?: string; baseUrl?: string } | undefined;
  /**
   * Provide the current goal snapshot for budget-aware engine turns.
   * Read fresh on each turn so host-side goal changes (pause, budget
   * edits, terminal states) are reflected. When undefined, the engine
   * runs without goal budgeting.
   */
  getGoal?: () => GoalContext | undefined;
  /**
   * Provide the current permission policy snapshot for local evaluation (P26 批 3).
   * Read fresh on each turn.
   */
  getPolicySnapshot?: () => PolicySnapshot | undefined;
  /**
   * Ask the host an interactive question and wait for a human answer
   * (`host/ask_question`). The per-turn engine input's `askUserQuestion`
   * takes precedence when both are wired; when neither is, the engine
   * reports "host does not support interactive questions" as the tool
   * result.
   */
  askUserQuestion?: (request: AskQuestionWire) => Promise<AskQuestionWireResult>;
  /**
   * Read host-owned state (`host/state_read`) for a state domain (todo/plan).
   * The per-turn engine input's `stateRead` takes precedence when both are
   * wired; when neither is, the engine reports "host does not support state
   * bridge" as the tool result.
   */
  stateRead?: (request: StateReadWire) => Promise<StateReadWireResult>;
  /**
   * Write host-owned state (`host/state_write`) for a state domain (todo/plan).
   * The per-turn engine input's `stateWrite` takes precedence when both are
   * wired; when neither is, the engine reports "host does not support state
   * bridge" as the tool result.
   */
  stateWrite?: (request: StateWriteWire) => Promise<StateWriteWireResult>;
}

/** Snapshot of permission policies for in-Rust evaluation (P26 批 3). */
export interface PolicySnapshot {
  mode?: 'manual' | 'auto' | 'yolo';
  deny_rules?: string[];
  ask_rules?: string[];
  allow_rules?: string[];
  session_approvals?: string[];
  git_cwd?: string;
}

/** A content block on the Rust wire (see `ContentBlock` in rpc/types.rs). */
type WireContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string }
  | { type: 'image_url'; url: string }
  | { type: 'audio_url'; url: string; id?: string }
  | { type: 'video_url'; url: string; id?: string };

/** A v2 content part as handed to the native path after host projection. */
interface HostContentPart {
  type: string;
  text?: string;
  imageUrl?: { url: string; id?: string };
  audioUrl?: { url: string; id?: string };
  videoUrl?: { url: string; id?: string };
}

/** A v2 message as projected by the host context projector. */
interface HostMessage {
  role: string;
  content: HostContentPart[];
  toolCalls?: { id: string; name: string; arguments: string | null }[];
  toolCallId?: string;
}

const HOST_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function isHostMessage(value: unknown): value is HostMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m['role'] !== 'string' || !HOST_ROLES.has(m['role'])) return false;
  if (!Array.isArray(m['content'])) return false;
  return true;
}

function isHostContentPart(value: unknown): value is HostContentPart {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'text' ||
    type === 'think' ||
    type === 'image_url' ||
    type === 'audio_url' ||
    type === 'video_url'
  );
}

/** Project a host-projected v2 message onto the Rust wire (P1 projection). */
export function projectHostMessageToWire(m: HostMessage): WireMessage {
  let text = '';
  let hasMedia = false;
  const blocks: WireContentBlock[] = [];
  for (const part of m.content.filter(isHostContentPart)) {
    switch (part.type) {
      case 'text':
        if (typeof part.text !== 'string') continue;
        text += part.text;
        blocks.push({ type: 'text', text: part.text });
        break;
      case 'think':
        // Think parts are hosted as reasoning content on the JS path
        // (never part of the message `content`); the native wire has no
        // reasoning field, so they are intentionally not projected.
        break;
      case 'image_url':
        if (part.imageUrl?.url === undefined) continue;
        hasMedia = true;
        blocks.push({ type: 'image_url', url: part.imageUrl.url });
        break;
      case 'audio_url':
        if (part.audioUrl?.url === undefined) continue;
        hasMedia = true;
        blocks.push({ type: 'audio_url', url: part.audioUrl.url, id: part.audioUrl.id });
        break;
      case 'video_url':
        if (part.videoUrl?.url === undefined) continue;
        hasMedia = true;
        blocks.push({ type: 'video_url', url: part.videoUrl.url, id: part.videoUrl.id });
        break;
      default:
        continue;
    }
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
}

/**
 * Tracks the `AbortController` of every in-flight LLM request that the Rust
 * side can name, so a provider that loses a MultiLLM race can actually be
 * stopped instead of running to completion and billing for a response nobody
 * will read.
 *
 * Cancellation can overtake its request: `llm_chat` and the cancel event
 * travel on separate channels, so an id that arrives before its request is
 * remembered and applied the moment the request shows up.
 */
interface LlmAbortRegistry {
  /** Register a request; returns the signal to pass to the provider. */
  begin(requestId: string | undefined): { signal?: AbortSignal; finish(): void };
  /** Abort a request if it is in flight. */
  cancel(requestId: string): void;
}

export function createLlmAbortRegistry(): LlmAbortRegistry {
  const inFlight = new Map<string, AbortController>();
  const cancelledEarly = new Set<string>();

  return {
    begin(requestId) {
      // Single-provider turns are unnamed; they use the turn's own signal.
      if (requestId === undefined) return { finish() {} };
      const controller = new AbortController();
      if (cancelledEarly.delete(requestId)) controller.abort();
      inFlight.set(requestId, controller);
      return {
        signal: controller.signal,
        finish() {
          inFlight.delete(requestId);
        },
      };
    },
    cancel(requestId) {
      const controller = inFlight.get(requestId);
      if (controller === undefined) {
        cancelledEarly.add(requestId);
        return;
      }
      controller.abort();
      inFlight.delete(requestId);
    },
  };
}

/** Fire-and-forget engine event (Rust → host, `host/event`). */
type EngineEvent =
  | { type: 'llm.step.begin'; model: string }
  | { type: 'llm.delta'; part: { type: 'text'; text: string } }
  | {
      type: 'llm.step.end';
      content: string;
      finish_reason?: string;
      latency_ms?: number;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_cache_read?: number;
        input_cache_creation?: number;
      };
    }
  | {
      type: 'tool.native';
      tool_call_id: string;
      tool_name: string;
      arguments: unknown;
      content: string;
      is_error: boolean;
      note?: string;
    }
  | { type: 'goal.budget.limit_reached'; goal_id: string }
  /** A racing provider lost; the host may abort its in-flight request. */
  | { type: 'llm_chat.cancel'; request_id: string };

interface RunTurnResult {
  stop_reason: string;
  steps: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_cache_read?: number;
    input_cache_creation?: number;
  };
  /** Host-visible engine events emitted during the turn. */
  events_emitted?: number;
  /** LLM retries performed during the turn (attempts beyond the first). */
  llm_retries?: number;
  /** Which LLM transport served the turn: `native-http` / `host-proxy` / `multi`. */
  llm_transport?: string;
  /** Tool calls the engine ran in its own process instead of on the host. */
  native_tool_calls?: number;
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
  /** Present only for racing providers, so a loser can be aborted. */
  request_id?: string;
}

interface LlmChatResponse {
  tool_calls: { id: string; name: string; arguments: unknown }[];
  finish_reason?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_cache_read?: number;
    input_cache_creation?: number;
  };
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
  note?: string;
}

/** Permission check request from the engine (host/check_permission). */
interface PermissionCheckRequest {
  tool_name: string;
  tool_call_id: string;
  arguments: unknown;
}

/**
 * Result finalization request from the engine (host/finalize_tool_result): a
 * tool result the engine executed in its own process, handed to the host so its
 * truncation and spill-to-disk policy applies before the model sees it.
 */
interface ToolFinalizeRequest {
  tool_name: string;
  tool_call_id: string;
  content: string;
  is_error: boolean;
  note?: string;
}

interface PermissionDecision {
  decision: 'allow' | 'deny';
  reason?: string;
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

/**
 * Turn result shape returned by the native addon. Aliased to the
 * napi-generated `JsRunTurnResult` (`napi-contract.d.ts`, regenerated by
 * `bun run build` from the Rust `JsRunTurnResult` struct) so the wire shape
 * is compile-time checked against the engine instead of hand-maintained.
 */
type NapiRunTurnResult = JsRunTurnResult;

// ── Napi engine (in-process native addon) ─────────────────────────────────

/** Shape of the loaded `kimi_agent.node` native addon. */
interface KimiAgentNativeModule {
  getCallbackPayload(id: number): string | null;
  resolveCallback(id: number, error: string | null, result: string | null): void;
  cancelTurn(turnId: string): void;
  initTracingFromEnv?(): boolean;
  runTurnRust(
    params: unknown,
    llmChatCb: (callbackId: number) => void,
    executeToolCb: (callbackId: number) => void,
    emitEventCb?: (callbackId: number) => void,
    checkPermissionCb?: (callbackId: number) => void,
    finalizeToolCb?: (callbackId: number) => void,
    drainSteersCb?: (callbackId: number) => void,
    askQuestionCb?: (callbackId: number) => void,
    stateReadCb?: (callbackId: number) => void,
    stateWriteCb?: (callbackId: number) => void,
  ): Promise<NapiRunTurnResult>;
}

/** In-process napi-rs engine transport. Exported for unit tests. */
export class NapiEngine {
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

  initTracing(): boolean {
    if (!this.load()) return false;
    return this.nativeModule?.initTracingFromEnv?.() ?? false;
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
    params: JsRunTurnParams,
    llmChatCb: (request: string) => Promise<string>,
    executeToolCb: (request: string) => Promise<string>,
    emitEventCb?: (event: EngineEvent) => void,
    checkPermissionCb?: (request: PermissionCheckRequest) => Promise<PermissionDecision>,
    finalizeToolCb?: (request: ToolFinalizeRequest) => Promise<ToolExecuteResponse>,
    drainSteersCb?: () => Promise<WireMessage[]>,
    askQuestionCb?: (request: AskQuestionWire) => Promise<AskQuestionWireResult>,
    stateReadCb?: (request: StateReadWire) => Promise<StateReadWireResult>,
    stateWriteCb?: (request: StateWriteWire) => Promise<StateWriteWireResult>,
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
        void (async () => {
          try {
            const result = await handler(payload);
            nativeModule.resolveCallback(callbackId, null, result);
          } catch (error: unknown) {
            nativeModule.resolveCallback(
              callbackId,
              error instanceof Error ? error.message : String(error),
              null,
            );
          }
        })();
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

    // Permission channel: resolve like the request/response callbacks.
    const permissionHandler =
      checkPermissionCb === undefined
        ? undefined
        : makeCallbackHandler(async (payload: string) => {
            const decision = await checkPermissionCb(
              JSON.parse(payload) as PermissionCheckRequest,
            );
            return JSON.stringify(decision);
          });

    const finalizeHandler =
      finalizeToolCb === undefined
        ? undefined
        : makeCallbackHandler(async (payload: string) => {
            const finalized = await finalizeToolCb(JSON.parse(payload) as ToolFinalizeRequest);
            return JSON.stringify(finalized);
          });

    const drainHandler =
      drainSteersCb === undefined
        ? undefined
        : makeCallbackHandler(async () => JSON.stringify(await drainSteersCb()));

    // Question channel: resolve like the request/response callbacks. The
    // host owns the interaction runtime and answers with the v2
    // QuestionResult three states (answered / dismissed / cancelled).
    const askQuestionHandler =
      askQuestionCb === undefined
        ? undefined
        : makeCallbackHandler(async (payload: string) => {
            const result = await askQuestionCb(JSON.parse(payload) as AskQuestionWire);
            return JSON.stringify(result);
          });

    // State bridge channels: resolve like the request/response callbacks.
    // The host owns the state (todo/plan) and answers with the wire value;
    // a handler failure carries the JSON-RPC code the engine maps to a tool
    // result error.
    const stateReadHandler =
      stateReadCb === undefined
        ? undefined
        : makeCallbackHandler(async (payload: string) => {
            const result = await stateReadCb(JSON.parse(payload) as StateReadWire);
            return JSON.stringify(result);
          });

    const stateWriteHandler =
      stateWriteCb === undefined
        ? undefined
        : makeCallbackHandler(async (payload: string) => {
            const result = await stateWriteCb(JSON.parse(payload) as StateWriteWire);
            return JSON.stringify(result);
          });

    return nativeModule.runTurnRust(
      params,
      makeCallbackHandler(llmChatCb),
      makeCallbackHandler(executeToolCb),
      eventHandler,
      permissionHandler,
      finalizeHandler,
      drainHandler,
      askQuestionHandler,
      stateReadHandler,
      stateWriteHandler,
    );
  }

  /** Ask a running turn to stop at the next step boundary. */
  cancel(turnId: string): void {
    this.nativeModule?.cancelTurn(turnId);
  }
}

// ── Agent process manager (stdio JSON-RPC) ────────────────────────────────

/* oxlint-disable no-non-null-assertion */
// All non-null assertions inside `AgentProcess` are guarded by either
// `this.ready` (set true only after `start()` has populated `this.process`
// and the child stdio streams are wired) or an explicit `!this.process ||
// !this.ready` throw at the top of the calling method. TypeScript cannot
// narrow through the `throw` without a helper, and the assertions here are
// the documented lifecycle contract rather than speculative `!`s.
/** stdio JSON-RPC engine transport. Exported for unit tests. */
export class AgentProcess {
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
  private llmChatHandler:
    | ((signal: AbortSignal | undefined, modelName?: string) => Promise<LlmChatResponse>)
    | null = null;

  /** Lets a losing MultiLLM provider be aborted mid-flight. */
  private llmAbortRegistry: LlmAbortRegistry | null = null;

  /** Callback for handling host/execute_tool requests from the Rust side. */
  private toolExecuteHandler: ((req: ToolExecuteRequest) => Promise<ToolExecuteResponse>) | null =
    null;

  /** Callback for handling host/check_permission requests from the Rust side. */
  private permissionHandler:
    | ((req: PermissionCheckRequest) => Promise<PermissionDecision>)
    | null = null;

  /** Callback for handling host/finalize_tool_result requests from Rust. */
  private finalizeHandler:
    | ((req: ToolFinalizeRequest) => Promise<ToolExecuteResponse>)
    | null = null;

  /** Callback for handling host/drain_steers requests from Rust. */
  private drainSteersHandler: (() => Promise<WireMessage[]>) | null = null;

  /** Callback for handling host/ask_question requests from Rust. */
  private askQuestionHandler:
    | ((req: AskQuestionWire) => Promise<AskQuestionWireResult>)
    | null = null;

  /** Callback for handling host/state_read requests from Rust. */
  private stateReadHandler:
    | ((req: StateReadWire) => Promise<StateReadWireResult>)
    | null = null;

  /** Callback for handling host/state_write requests from Rust. */
  private stateWriteHandler:
    | ((req: StateWriteWire) => Promise<StateWriteWireResult>)
    | null = null;

  /** Callback for fire-and-forget host/event notifications from Rust. */
  private eventHandler: ((event: EngineEvent) => void) | null = null;

  setLlmChatHandler(
    handler: (signal: AbortSignal | undefined, modelName?: string) => Promise<LlmChatResponse>,
  ) {
    this.llmChatHandler = handler;
  }

  setLlmAbortRegistry(registry: LlmAbortRegistry) {
    this.llmAbortRegistry = registry;
  }

  setToolExecuteHandler(handler: (req: ToolExecuteRequest) => Promise<ToolExecuteResponse>) {
    this.toolExecuteHandler = handler;
  }

  setPermissionHandler(handler: (req: PermissionCheckRequest) => Promise<PermissionDecision>) {
    this.permissionHandler = handler;
  }

  setFinalizeHandler(handler: (req: ToolFinalizeRequest) => Promise<ToolExecuteResponse>) {
    this.finalizeHandler = handler;
  }

  setDrainSteersHandler(handler: () => Promise<WireMessage[]>) {
    this.drainSteersHandler = handler;
  }

  setAskQuestionHandler(handler: (req: AskQuestionWire) => Promise<AskQuestionWireResult>) {
    this.askQuestionHandler = handler;
  }

  setStateReadHandler(handler: (req: StateReadWire) => Promise<StateReadWireResult>) {
    this.stateReadHandler = handler;
  }

  setStateWriteHandler(handler: (req: StateWriteWire) => Promise<StateWriteWireResult>) {
    this.stateWriteHandler = handler;
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
        onAgentProcessExit(this);
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
    } else if (msg.method === 'host/check_permission') {
      await this.handleHostCheckPermission(msg);
    } else if (msg.method === 'host/finalize_tool_result') {
      await this.handleHostFinalizeToolResult(msg);
    } else if (msg.method === 'host/drain_steers') {
      await this.handleHostDrainSteers(msg);
    } else if (msg.method === 'host/ask_question') {
      await this.handleHostAskQuestion(msg);
    } else if (msg.method === 'host/state_read') {
      await this.handleHostStateRead(msg);
    } else if (msg.method === 'host/state_write') {
      await this.handleHostStateWrite(msg);
    } else {
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unknown method: ${msg.method}` },
      });
      this.process!.stdin!.write(response + '\n');
    }
  }

  private async handleHostDrainSteers(msg: RpcMessage) {
    if (!this.drainSteersHandler) {
      this.writeHostResult(msg.id, [] satisfies WireMessage[]);
      return;
    }
    try {
      this.writeHostResult(msg.id, await this.drainSteersHandler());
    } catch {
      // An undrained steer stays in the host queue and reaches the model once
      // the turn ends, so a failed drain must not abort the running turn.
      this.writeHostResult(msg.id, [] satisfies WireMessage[]);
    }
  }

  private async handleHostAskQuestion(msg: RpcMessage) {
    if (!this.askQuestionHandler) {
      // Unwired host: the engine maps this error to the v2
      // QUESTION_UNSUPPORTED_FAILURE_MESSAGE tool result.
      this.writeHostError(msg.id, 'host does not support interactive questions');
      return;
    }
    try {
      const result = await this.askQuestionHandler(msg.params as AskQuestionWire);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleHostStateRead(msg: RpcMessage) {
    if (!this.stateReadHandler) {
      // Unwired host: the engine maps this error to a "state bridge not
      // supported" tool result telling the model not to retry.
      this.writeHostError(msg.id, 'host does not support state bridge');
      return;
    }
    try {
      const result = await this.stateReadHandler(msg.params as StateReadWire);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(
        msg.id,
        error instanceof Error ? error.message : String(error),
        stateBridgeErrorCode(error),
      );
    }
  }

  private async handleHostStateWrite(msg: RpcMessage) {
    if (!this.stateWriteHandler) {
      this.writeHostError(msg.id, 'host does not support state bridge');
      return;
    }
    try {
      const result = await this.stateWriteHandler(msg.params as StateWriteWire);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(
        msg.id,
        error instanceof Error ? error.message : String(error),
        stateBridgeErrorCode(error),
      );
    }
  }

  private async handleHostFinalizeToolResult(msg: RpcMessage) {
    const req = msg.params as ToolFinalizeRequest;
    if (!this.finalizeHandler) {
      // No policy registered: hand the result back unchanged rather than
      // failing the call the engine already completed.
      this.writeHostResult(msg.id, {
        content: req.content,
        is_error: req.is_error,
        note: req.note,
      } satisfies ToolExecuteResponse);
      return;
    }
    try {
      this.writeHostResult(msg.id, await this.finalizeHandler(req));
    } catch (error) {
      this.writeHostResult(msg.id, {
        content: req.content,
        is_error: req.is_error,
        note: req.note,
        _finalizeError: error instanceof Error ? error.message : String(error),
      } satisfies ToolExecuteResponse & { _finalizeError?: string });
    }
  }

  private async handleHostCheckPermission(msg: RpcMessage) {
    if (!this.permissionHandler) {
      // Fail closed: without a permission checker the engine must not run
      // mutating tools natively.
      this.writeHostResult(msg.id, {
        decision: 'deny',
        reason: 'no permission handler registered',
      } satisfies PermissionDecision);
      return;
    }
    try {
      const result = await this.permissionHandler(msg.params as PermissionCheckRequest);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostResult(msg.id, {
        decision: 'deny',
        reason: error instanceof Error ? error.message : String(error),
      } satisfies PermissionDecision);
    }
  }

  private async handleHostLlmChat(msg: RpcMessage) {
    if (!this.llmChatHandler) {
      this.writeHostError(msg.id, 'No LLM chat handler registered');
      return;
    }
    const params = msg.params as LlmChatRequest;
    const request = this.llmAbortRegistry?.begin(params.request_id) ?? { finish() {} };
    try {
      // MultiLLM races each provider under its own model; hand the model to
      // the host chat so it can route to the right endpoint.
      const result = await this.llmChatHandler(request.signal, params.model_name);
      this.writeHostResult(msg.id, result);
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    } finally {
      request.finish();
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

  private writeHostError(id: unknown, message: string, code = -32603) {
    this.process!.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n',
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

  /** Ask the server to cancel a running turn (fire-and-forget). */
  cancel(turnId: string): void {
    if (!this.process || !this.ready) return;
    const request = {
      jsonrpc: '2.0' as const,
      id: this.nextId++,
      method: 'agent/cancel_turn',
      params: { turn_id: turnId },
    };
    this.process.stdin!.write(JSON.stringify(request) + '\n');
  }
}

// ── Engine selection ──────────────────────────────────────────────────────

/// Which transport is active for the current session.
type EngineMode = 'napi' | 'stdio' | 'js';

let engineMode: EngineMode = 'js';
let agentProcess: AgentProcess | null = null;
let napiEngine: NapiEngine | null = null;

/**
 * Crash accounting for the stdio engine.
 *
 * A crash used to be terminal: `engineMode` stayed `'stdio'` while the
 * process handle went null, so every later turn failed with "Agent process
 * is not running" and the only way out was restarting the CLI. Dropping back
 * to `'js'` lets the next turn re-run `initEngine` and spawn a replacement —
 * but only a few times, since a binary that crashes every turn is broken and
 * respawning it is churn.
 */
let stdioCrashes = 0;
const MAX_STDIO_RESTARTS = 3;

function onAgentProcessExit(agent: AgentProcess): void {
  // A stale process exiting — one already replaced or shut down — must not
  // disturb the mode of the process now in use.
  if (agentProcess !== agent) return;
  stdioCrashes += 1;
  if (stdioCrashes <= MAX_STDIO_RESTARTS) {
    engineMode = 'js';
  }
}

/**
 * Test seam: when set, `initEngine` uses this transport instead of the
 * napi-first default. Tests force stdio on machines that also have the napi
 * addon so the JS-side handler paths (e.g. `handleHostCheckPermission`) are
 * exercised end to end.
 */
let forcedTransport: 'napi' | 'stdio' | undefined;

/**
 * Initialize the Rust engine, preferring napi-rs over stdio JSON-RPC.
 * Returns the selected mode. Called once on first use; subsequent calls
 * return the same mode.
 */
function initEngine(): EngineMode {
  if (engineMode !== 'js') return engineMode;

  // 1) Try napi-rs first (in-process, no subprocess overhead), unless a
  //    test has forced the stdio transport.
  if (forcedTransport !== 'stdio' && NapiEngine.isAvailable()) {
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
  // P21 D-1: nativeTools defaults to true now that local permission and
  // truncation engines are self-contained. Opt-out via `nativeTools: false`.
  const nativeTools = options?.nativeTools !== false;
  const rustSelfContained = options?.rustSelfContained === true;
  const shellPathOpt = options?.shellPath;

  return async (input) => {
    // v2 hands us a numeric turnId; the wire protocol and LoopRecordedEvent
    // use a string, so normalize once per turn.
    const turnIdStr = String(input.turnId);

    // Propagate host cancellation to the Rust engine: on abort, ask the
    // active transport to stop the turn at the next step boundary so a
    // Ctrl+C / stop doesn't leave the engine burning LLM/tool work.
    const onAbort = (): void => {
      if (mode === 'napi') {
        getNapiEngine()?.cancel(turnIdStr);
      } else if (mode === 'stdio') {
        getAgent()?.cancel(turnIdStr);
      }
    };
    input.signal.addEventListener('abort', onAbort, { once: true });

    // Resolve nativeLlm fresh per turn: when a function is provided it
    // re-reads the config file so TUI model switches are reflected.
    const resolvedNativeLlm = typeof nativeLlmOpt === 'function' ? nativeLlmOpt() : nativeLlmOpt;

    // Guard: when the user switches models in the TUI, the session's LLM
    // adapter (input.llm) is updated to the new provider/model, but the
    // nativeLlm config (read from config.toml) may still point to the old
    // provider. Both sides are compared as wire model ids — `nativeLlm.model`
    // is what the engine sends to the provider, so comparing it against the
    // session's alias (often `provider/id`) would never match.
    const nativeLlm =
      resolvedNativeLlm !== undefined && resolvedNativeLlm.model !== input.llm.modelId
        ? undefined
        : resolvedNativeLlm;

    // Step lifecycle. The host owns the transcript AND the message history:
    // Rust drives control flow and calls back per LLM step and per tool. We
    // open an assistant "step" on host/llm_chat and keep it open — recording
    // tool.call / tool.result against it — until the next llm_chat (or turn
    // end) closes it with step.end. buildMessages() re-reads `context` each
    // step, so these recorded events are exactly what thread history forward.
    let currentStep = 0;
    /** Most recently closed (or current) step, indexed for events that arrive
     *  after their producer step was already closed by llmChatHandler. */
    let lastClosedStep: { uuid: string; step: number } | undefined;
    let openStep: { uuid: string; step: number; usage: HostTokenUsage } | undefined;
    const closeOpenStep = async (): Promise<void> => {
      if (openStep === undefined) return;
      const { uuid, step, usage } = openStep;
      lastClosedStep = { uuid, step };
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
            part: event.part as never,
          });
          break;
        }
        case 'llm.step.end': {
          if (openStep === undefined) break;
          openStep.usage = {
            inputOther: event.usage?.input_tokens ?? 0,
            output: event.usage?.output_tokens ?? 0,
            inputCacheRead: event.usage?.input_cache_read ?? 0,
            inputCacheCreation: event.usage?.input_cache_creation ?? 0,
          };
          break;
        }
        case 'tool.native': {
          // The tool ran inside the step that the next host/llm_chat may
          // already have closed (llmChatHandler runs outside the event
          // chain, so its openStep handover leaves a window where openStep
          // is momentarily undefined). Fall back to the last closed step so
          // the card is never dropped — dropping it loses the tool.call/
          // tool.result transcript pair entirely.
          const targetStep = openStep ?? lastClosedStep;
          if (targetStep === undefined) break;
          const toolCallId = event.tool_call_id;
          await input.dispatchEvent({
            type: 'tool.call',
            uuid: toolCallId,
            turnId: turnIdStr,
            step: targetStep.step,
            stepUuid: targetStep.uuid,
            toolCallId,
            name: event.tool_name,
            args: event.arguments,
          });
          await input.dispatchEvent({
            type: 'tool.result',
            parentUuid: toolCallId,
            toolCallId,
            result: {
              output: event.content,
              isError: event.is_error,
              note: event.note,
            } as never,
          });
          break;
        }
        case 'goal.budget.limit_reached': {
          // Forwarded for host-side accounting; the turn already stops
          // with a BudgetLimited stop reason from the Rust loop.
          break;
        }
        default:
          break;
      }
    };
    const llmAbortRegistry = createLlmAbortRegistry();

    const handleEngineEvent = (event: EngineEvent): void => {
      // Handled outside the chain: an abort that waits behind the event
      // backlog defeats the point of cancelling.
      if (event.type === 'llm_chat.cancel') {
        llmAbortRegistry.cancel(event.request_id);
        return;
      }
      eventChain = eventChain.then(() => processEngineEvent(event)).catch(() => {});
    };

    // ── Native LLM initial messages ───────────────────────────────
    // When Rust calls the provider directly it owns the in-turn message
    // history, so the host serializes the current history once at turn
    // start. The host already ran the context projector (structure
    // repairs); `projectHostMessageToWire` mirrors the v2 content-part
    // wire so the projection round-trips losslessly for text/image/
    // audio/video.
    const buildWireMessages = async (): Promise<WireMessage[]> => {
      const projected = await input.buildMessages();
      // Strict validation: the host projection must stay wire-valid.
      // Malformed entries are filtered rather than cast through, so a host
      // regression cannot silently corrupt the native request.
      return projected.filter(isHostMessage).map(projectHostMessageToWire);
    };
    const buildWireTools = (): { name: string; description: string; parameters: unknown }[] => {
      const stepTools = input.buildTools();
      return stepTools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: (t as { parameters?: unknown }).parameters ?? {},
      }));
    };

    // Mid-turn steering lands in the host's step queue, which the JS loop would
    // normally drain at the next step head. An engine driving the whole turn
    // has to ask, or a steered prompt waits for the turn to end. Awaiting the
    // event chain first keeps the record ordered after the tool results that
    // are still being appended for the step that just ran.
    const drainSteers = async (): Promise<WireMessage[]> => {
      await eventChain;
      const steered = await input.drainSteers?.();
      return (steered ?? []).filter(isHostMessage).map(projectHostMessageToWire);
    };

    // ── LLM chat handler ──────────────────────────────────────────────
    /**
     * `signal` is set when this request is one of several racing providers;
     * otherwise the turn's own signal governs it.
     */
    const llmChatHandler = async (
      signal?: AbortSignal,
      modelName?: string,
    ): Promise<LlmChatResponse> => {
      await closeOpenStep();
      await drainSteers();
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
        signal: signal ?? input.signal,
        modelName,
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
          input_cache_read: response.usage?.inputCacheRead ?? 0,
          input_cache_creation: response.usage?.inputCacheCreation ?? 0,
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
        note: outcome.note,
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
    const goal = options?.getGoal?.();
    const policySnapshot = options?.getPolicySnapshot?.();
    const githubCredentials = options?.getGithubCredentials?.();
    const askUserQuestion = input.askUserQuestion?.bind(input) ?? options?.askUserQuestion;
    const stateRead = input.stateRead?.bind(input) ?? options?.stateRead;
    const stateWrite = input.stateWrite?.bind(input) ?? options?.stateWrite;
    const policySnapshotJson =
      policySnapshot === undefined ? undefined : JSON.stringify(policySnapshot);
    // The host owns tool-result truncation and spill-to-disk, so a result the
    // engine produced in its own process must pass through the same policy
    // before the model sees it. Engines whose input lacks the capability get an
    // unchanged result instead of a failed call.
    const finalizeNativeResult = async (
      req: ToolFinalizeRequest,
    ): Promise<ToolExecuteResponse> => {
      if (input.finalizeToolResult === undefined) {
        return { content: req.content, is_error: req.is_error, note: req.note };
      }
      const finalized = await input.finalizeToolResult(req.tool_name, req.tool_call_id, {
        output: req.content,
        isError: req.is_error,
        note: req.note,
      });
      return {
        content: typeof finalized.output === 'string' ? finalized.output : JSON.stringify(finalized.output),
        is_error: finalized.isError ?? false,
        note: finalized.note,
      };
    };

    let rustResult: RunTurnResult;
    try {
      if (mode === 'napi') {
        const engine = getNapiEngine()!;
        // Napi callbacks use JSON-serialized payloads (string → string)
        const napiResult = await engine.runTurn(
          {
            turnId: turnIdStr,
            systemPrompt: input.llm.systemPrompt,
            modelName: input.llm.modelAlias,
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
            maxSteps: input.maxSteps,
            // The stdio wire is snake_case; the napi object wire is
            // camelCase (napi-rs converts Rust field names), so project
            // the goal context explicitly instead of passing it through.
            goal:
              goal === undefined
                ? undefined
                : {
                    goalId: goal.goal_id,
                    objective: goal.objective,
                    status: goal.status,
                    tokenBudget: goal.token_budget,
                    turnBudget: goal.turn_budget,
                    wallClockBudgetMs: goal.wall_clock_budget_ms,
                    wallClockMs: goal.wall_clock_ms,
                    tokensUsed: goal.tokens_used,
                    turnsUsed: goal.turns_used,
                  },
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
            rustSelfContained,
            shellPath: shellPathOpt,
            policySnapshotJson,
            githubToken: githubCredentials?.token,
            githubBaseUrl: githubCredentials?.baseUrl,
            providers: providers?.map((p) => ({
              name: p.name,
              model: p.model,
              systemPrompt: p.system_prompt,
            })),
          },
          // Wrap structured handler with JSON serialization for napi
          async (requestJson: string) => {
            const params = JSON.parse(requestJson) as LlmChatRequest;
            const request = llmAbortRegistry.begin(params.request_id);
            try {
              const response = await llmChatHandler(request.signal, params.model_name);
              return JSON.stringify(response);
            } finally {
              request.finish();
            }
          },
          async (requestJson: string) => {
            const req = JSON.parse(requestJson) as ToolExecuteRequest;
            const response = await toolExecuteHandler(req);
            return JSON.stringify(response);
          },
          handleEngineEvent,
          async (req: PermissionCheckRequest) => {
            if (input.checkToolPermission === undefined) {
              // Fail closed when the host input does not expose a checker.
              return {
                decision: 'deny',
                reason: 'engine input has no checkToolPermission capability',
              } satisfies PermissionDecision;
            }
            return input.checkToolPermission({
              type: 'function',
              id: req.tool_call_id,
              name: req.tool_name,
              arguments: req.arguments === undefined ? null : JSON.stringify(req.arguments),
            });
          },
          finalizeNativeResult,
          drainSteers,
          askUserQuestion,
          stateRead,
          stateWrite,
        );
        rustResult = {
          stop_reason: napiResult.stopReason,
          steps: napiResult.steps,
          usage: {
            input_tokens: napiResult.inputTokens,
            output_tokens: napiResult.outputTokens,
            total_tokens: napiResult.totalTokens,
            input_cache_read: napiResult.inputCacheRead,
            input_cache_creation: napiResult.inputCacheCreation,
          },
          events_emitted: napiResult.eventsEmitted,
          llm_retries: napiResult.llmRetries,
          llm_transport: napiResult.llmTransport,
          native_tool_calls: napiResult.nativeToolCalls,
        };
      } else {
        // stdio JSON-RPC path
        const agent = getAgent()!;
        agent.setLlmChatHandler(llmChatHandler);
        agent.setLlmAbortRegistry(llmAbortRegistry);
        agent.setToolExecuteHandler(toolExecuteHandler);
        agent.setFinalizeHandler(finalizeNativeResult);
        agent.setDrainSteersHandler(drainSteers);
        if (askUserQuestion !== undefined) {
          agent.setAskQuestionHandler(askUserQuestion);
        }
        if (stateRead !== undefined) {
          agent.setStateReadHandler(stateRead);
        }
        if (stateWrite !== undefined) {
          agent.setStateWriteHandler(stateWrite);
        }
        agent.setPermissionHandler(async (req) => {
          if (input.checkToolPermission === undefined) {
            return {
              decision: 'deny',
              reason: 'engine input has no checkToolPermission capability',
            } satisfies PermissionDecision;
          }
          return input.checkToolPermission({
            type: 'function',
            id: req.tool_call_id,
            name: req.tool_name,
            arguments: req.arguments === undefined ? null : JSON.stringify(req.arguments),
          });
        });
        agent.setEventHandler(handleEngineEvent);

        const result = await agent.request('agent/run_turn', {
          turn_id: turnIdStr,
          system_prompt: input.llm.systemPrompt,
          model_name: input.llm.modelAlias,
          messages: wireMessages,
          tools: wireTools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters ?? {},
          })),
          max_steps: input.maxSteps,
          providers: providers ?? [],
          goal,
          native_llm: nativeLlm,
          workspace_root: workspaceRoot,
          native_tools: nativeTools,
          rust_self_contained: rustSelfContained,
          shell_path: shellPathOpt,
          policy_snapshot: policySnapshot,
          github_token: githubCredentials?.token,
          github_base_url: githubCredentials?.baseUrl,
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
        inputCacheRead: rustResult.usage.input_cache_read ?? 0,
        inputCacheCreation: rustResult.usage.input_cache_creation ?? 0,
      },
      telemetry: {
        eventsEmitted: rustResult.events_emitted ?? 0,
        llmRetries: rustResult.llm_retries ?? 0,
        llmTransport: rustResult.llm_transport,
        nativeToolCallCount: rustResult.native_tool_calls,
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

/**
 * Extract the JSON-RPC error code a host state-bridge adapter attached to a
 * thrown error. Unknown shapes fall back to -32603 (the generic host error).
 */
function stateBridgeErrorCode(error: unknown): number {
  if (typeof error !== 'object' || error === null) return -32603;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : -32603;
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
  forcedTransport = undefined;
  stdioCrashes = 0;
}

/**
 * Test seam: force the transport the engine initializes with on the next
 * `initEngine()` call. `shutdownRustEngine()` resets this back to `undefined`.
 * Must be called before the first turn (before `createRunTurnOverride` runs
 * its lazy init).
 */
export function forceEngineTransport(mode: 'napi' | 'stdio'): void {
  forcedTransport = mode;
}

/**
 * Test seam: the live stdio engine process, if one is running. Killing it
 * lets a test exercise crash recovery without reaching into module state.
 */
export function activeAgentProcessForTests(): { stop(): void } | null {
  return agentProcess;
}

/**
 * Initialise the Rust-side tracing subscriber from
 * `KIMI_AGENT_TRACE` (presence enables) and `KIMI_AGENT_TRACE_FORMAT` (set to
 * `json` for chrome://tracing / speedscope.app). Mirrors the CLI binary's
 * `main.rs` setup so the vitest harness can opt into structured traces
 * without re-launching the binary. Returns `true` when the subscriber was
 * actually installed by this call, `false` when one was already registered
 * (a process-wide subscriber can only be set once) or when the env is unset.
 *
 * Loads the native module directly so this can be called *before* the
 * napiEngine is constructed (the test harness invokes it inside
 * `describe()` setup, which runs before the first `createRunTurnOverride`).
 */
export function initRustTracing(): boolean {
  const modulePath = NapiEngine.findModule();
  if (!modulePath) return false;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(modulePath) as KimiAgentNativeModule;
  return mod.initTracingFromEnv?.() ?? false;
}

