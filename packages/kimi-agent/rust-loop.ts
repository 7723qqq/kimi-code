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
import { z, type ZodType } from 'zod';
import {
  EngineSessionHandle,
  findKimiAgentAddon,
  type SessionAdmission,
  type SessionCallbacks,
  type SessionPrompt,
  type SessionStatus,
  type SessionTransport,
  type SessionTurnOutcome,
} from './session-handle';
import type { TelemetryEventWire, TurnEventWire } from './wire-schema';
import {
  llmChatRequestSchema,
  permissionCheckRequestSchema,
  runTurnParamsSchema,
  sessionEnqueueTurnParamsSchema,
  sessionHistoryParamsSchema,
  sessionStatusResultSchema,
  sessionTurnOutcomeResultSchema,
  telemetryEventSchema,
  toolExecuteRequestSchema,
  turnEventSchema,
} from './wire-schema';
import type { SessionMessageWire, SessionStatusWire, SessionTurnOutcomeWire } from './wire-schema';

// Project root: packages/kimi-agent/rust-loop.ts → ../../ (project root)
const projectRoot = resolve(import.meta.dirname, '..', '..');

/**
 * The v2 engine override contract this adapter implements. Imported
 * type-only from agent-core-v2 so the shape stays in sync without a
 * runtime dependency. `createRunTurnOverride` returns this type.
 */
export type TurnEngineAdapter = import('@moonshot-ai/agent-core-v2').TurnEngine & {
  /** Push a mid-turn steer into the engine session's steer queue. */
  deliverSteer?(message: unknown): Promise<void>;
};
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
   * Called once per completed turn with the result handed back to v2. The host
   * surfaces which transport actually ran the turn (`/status`); the adapter
   * stays the sole owner of the engine call, so the host does not have to wrap
   * it.
   */
  onTurnResult?: (result: Awaited<ReturnType<TurnEngineAdapter>>) => void;
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
  /**
   * Sink for engine turn telemetry (`host/telemetry`): the engine emits
   * `turn_started` / `turn_ended` / `turn_interrupted` per turn and the host
   * forwards one track2 per event. When undefined the events are dropped at
   * the transport.
   */
  onTelemetry?: (event: TelemetryEventWire) => void;
  /**
   * Host-injected telemetry context merged into the engine's turn telemetry
   * events (mode / provider_type / protocol / thinking_effort — the fields
   * the host knows from its model configuration). Read fresh on each turn.
   * When undefined the engine runs the plain `run_turn` path and emits no
   * telemetry: the host keeps owning its turn telemetry end to end.
   */
  getTelemetryContext?: () => EngineTelemetryContext | undefined;
}

/** Host-side half of the engine turn telemetry payload (M1c). */
export interface EngineTelemetryContext {
  mode: string;
  provider_type: string;
  protocol: string;
  thinking_effort?: string;
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
 * Project the v2 engine goal context (camelCase) onto the snake_case wire
 * goal the Rust engine consumes. The engine reads it fresh every turn for
 * its per-step budget checks; `undefined` runs the turn without budgeting.
 */
function projectEngineGoal(
  goal: import('@moonshot-ai/agent-core-v2').TurnEngineGoalContext | undefined,
): GoalContext | undefined {
  if (goal === undefined) return undefined;
  return {
    goal_id: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    token_budget: goal.tokenBudget,
    turn_budget: goal.turnBudget,
    wall_clock_budget_ms: goal.wallClockBudgetMs,
    wall_clock_ms: goal.wallClockMs,
    tokens_used: goal.tokensUsed,
    turns_used: goal.turnsUsed,
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
      note?: string | null;
    }
  | { type: 'goal.budget.limit_reached'; goal_id: string }
  /** A racing provider lost; the host may abort its in-flight request. */
  | { type: 'llm_chat.cancel'; request_id: string }
  /** Native `Agent` tool lifecycle (P51): the mirror of v2's `Subagent*`
   *  Event2 surface, mapped onto `input.onSubagentEvent`. */
  | {
      type: 'subagent.spawned';
      subagent_id: string;
      subagent_name: string;
      parent_tool_call_id?: string | null;
      description?: string | null;
      run_in_background?: boolean | null;
    }
  | { type: 'subagent.started'; subagent_id: string }
  | {
      type: 'subagent.completed';
      subagent_id: string;
      result_summary: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_cache_read?: number;
        input_cache_creation?: number;
      };
    }
  | { type: 'subagent.failed'; subagent_id: string; error: string }
  /** P57: native bash output stream (`tool.progress` mirror). */
  | {
      type: 'tool.native.progress';
      turn_id: string;
      tool_call_id: string;
      kind: string;
      text: string;
    };

/** `host/checkpoint` payload (P53): native write executions snapshot
 *  pre-images host-side before writing and note post-images after. */
interface CheckpointWire {
  turn_id: string;
  tool_call_id: string;
  phase: 'prepare' | 'record';
  paths: string[];
  executed?: boolean;
}

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
  content?: string;
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

/** The host's answer to `host/list_tools` (M1d): the current tool table in
 *  the same shape as the `agent/run_turn` snapshot entries, so the engine
 *  can swap them interchangeably. */
export interface ListToolsResult {
  tools: { name: string; description: string; input_schema: unknown }[];
}

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
    askQuestionCb?: (callbackId: number) => void,
    stateReadCb?: (callbackId: number) => void,
    stateWriteCb?: (callbackId: number) => void,
    checkpointCb?: (callbackId: number) => void,
    turnEventCb?: (callbackId: number) => void,
    telemetryCb?: (callbackId: number) => void,
    listToolsCb?: (callbackId: number) => void,
  ): Promise<NapiRunTurnResult>;
}

/** In-process napi-rs engine transport. Exported for unit tests. */
export class NapiEngine {
  private nativeModule: KimiAgentNativeModule | null = null;
  private loaded = false;

  static findModule(): string | null {
    // Shared with the session handle (session-handle.ts): both the per-turn
    // napi path and the session path locate the same addon. Kept as the
    // canonical entry point; the lookup itself lives in findKimiAgentAddon.
    return findKimiAgentAddon();
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
    askQuestionCb?: (request: AskQuestionWire) => Promise<AskQuestionWireResult>,
    stateReadCb?: (request: StateReadWire) => Promise<StateReadWireResult>,
    stateWriteCb?: (request: StateWriteWire) => Promise<StateWriteWireResult>,
    checkpointCb?: (request: CheckpointWire) => Promise<void>,
    turnEventCb?: (event: TurnEventWire) => void,
    telemetryCb?: (event: TelemetryEventWire) => void,
    listToolsCb?: () => Promise<ListToolsResult>,
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
              parseWire(permissionCheckRequestSchema, payload, 'host/check_permission request'),
            );
            return JSON.stringify(decision);
          });

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

    // Checkpoint channel (P53): resolve like the request/response callbacks.
    // The host captures pre-images before the engine writes and notes
    // post-images after; an unwired host skips checkpointing (fail-open).
    const checkpointHandler =
      checkpointCb === undefined
        ? undefined
        : makeCallbackHandler(async (payload: string) => {
            await checkpointCb(JSON.parse(payload) as CheckpointWire);
            return 'null';
          });

    // Turn lifecycle channel: fetch the payload but never resolve. Unlike a
    // display event, a dropped durable record corrupts the transcript, so a
    // rejected payload is reported instead of swallowed.
    const turnEventHandler =
      turnEventCb === undefined
        ? undefined
        : (callbackId: number) => {
            const payload = nativeModule.getCallbackPayload(callbackId);
            if (!payload) return;
            try {
              turnEventCb(parseWire(turnEventSchema, payload, 'host/turn_event'));
            } catch (error: unknown) {
              console.error('[kimi-agent] rejected host/turn_event:', error);
            }
          };

    // Turn telemetry channel: fetch the payload but never resolve. A rejected
    // payload is reported like turn_event — the host forwards these to its
    // telemetry sink, so a shape drift is a dashboard drift, not a display
    // glitch.
    const telemetryHandler =
      telemetryCb === undefined
        ? undefined
        : (callbackId: number) => {
            const payload = nativeModule.getCallbackPayload(callbackId);
            if (!payload) return;
            try {
              telemetryCb(parseWire(telemetryEventSchema, payload, 'host/telemetry'));
            } catch (error: unknown) {
              console.error('[kimi-agent] rejected host/telemetry:', error);
            }
          };

    // Tool-table channel: resolve like the request/response callbacks. The
    // engine pulls the fresh table before each native LLM call; an unwired
    // host leaves the turn-start snapshot as the only table.
    const listToolsHandler =
      listToolsCb === undefined
        ? undefined
        : makeCallbackHandler(async () => JSON.stringify(await listToolsCb()));

    return nativeModule.runTurnRust(
      params,
      makeCallbackHandler(llmChatCb),
      makeCallbackHandler(executeToolCb),
      eventHandler,
      permissionHandler,
      askQuestionHandler,
      stateReadHandler,
      stateWriteHandler,
      checkpointHandler,
      turnEventHandler,
      telemetryHandler,
      listToolsHandler,
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

  /** Callback for handling host/checkpoint requests from Rust (P53). */
  private checkpointHandler: ((req: CheckpointWire) => Promise<void>) | null = null;

  /** Callback for fire-and-forget host/event notifications from Rust. */
  private eventHandler: ((event: EngineEvent) => void) | null = null;

  /** Callback for engine turn lifecycle records (`host/turn_event`). */
  private turnEventHandler: ((event: TurnEventWire) => void) | null = null;

  /** Callback for engine turn telemetry (`host/telemetry`). */
  private telemetryHandler: ((event: TelemetryEventWire) => void) | null = null;

  /** Callback for answering `host/list_tools` with the current tool table. */
  private listToolsHandler: (() => Promise<ListToolsResult>) | null = null;

  /** Callback for answering `host/goal` with the current goal snapshot. */
  private goalHandler: (() => Promise<GoalContext | null>) | null = null;

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

  setAskQuestionHandler(handler: (req: AskQuestionWire) => Promise<AskQuestionWireResult>) {
    this.askQuestionHandler = handler;
  }

  setStateReadHandler(handler: (req: StateReadWire) => Promise<StateReadWireResult>) {
    this.stateReadHandler = handler;
  }

  setStateWriteHandler(handler: (req: StateWriteWire) => Promise<StateWriteWireResult>) {
    this.stateWriteHandler = handler;
  }

  setCheckpointHandler(handler: (req: CheckpointWire) => Promise<void>) {
    this.checkpointHandler = handler;
  }

  setEventHandler(handler: (event: EngineEvent) => void) {
    this.eventHandler = handler;
  }

  setTurnEventHandler(handler: (event: TurnEventWire) => void) {
    this.turnEventHandler = handler;
  }

  setTelemetryHandler(handler: (event: TelemetryEventWire) => void) {
    this.telemetryHandler = handler;
  }

  setListToolsHandler(handler: () => Promise<ListToolsResult>) {
    this.listToolsHandler = handler;
  }

  setGoalHandler(handler: () => Promise<GoalContext | null>) {
    this.goalHandler = handler;
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
            } else if (msg.method === 'host/turn_event' && this.turnEventHandler) {
              try {
                this.turnEventHandler(
                  parseWireObject(turnEventSchema, msg.params, 'host/turn_event'),
                );
              } catch (error: unknown) {
                console.error('[kimi-agent] rejected host/turn_event:', error);
              }
            } else if (msg.method === 'host/telemetry' && this.telemetryHandler) {
              try {
                this.telemetryHandler(
                  parseWireObject(telemetryEventSchema, msg.params, 'host/telemetry'),
                );
              } catch (error: unknown) {
                console.error('[kimi-agent] rejected host/telemetry:', error);
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
    } else if (msg.method === 'host/ask_question') {
      await this.handleHostAskQuestion(msg);
    } else if (msg.method === 'host/state_read') {
      await this.handleHostStateRead(msg);
    } else if (msg.method === 'host/state_write') {
      await this.handleHostStateWrite(msg);
    } else if (msg.method === 'host/checkpoint') {
      await this.handleHostCheckpoint(msg);
    } else if (msg.method === 'host/list_tools') {
      await this.handleHostListTools(msg);
    } else if (msg.method === 'host/goal') {
      await this.handleHostGoal(msg);
    } else {
      const response = JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unknown method: ${msg.method}` },
      });
      this.process!.stdin!.write(response + '\n');
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

  private async handleHostCheckpoint(msg: RpcMessage) {
    if (!this.checkpointHandler) {
      // Unwired host: the engine fail-opens and skips checkpointing.
      this.writeHostError(msg.id, 'host does not support checkpoint');
      return;
    }
    try {
      await this.checkpointHandler(msg.params as CheckpointWire);
      this.writeHostResult(msg.id, null);
    } catch (error) {
      // Fail-open: a checkpoint failure skips the snapshot but never
      // blocks the write.
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleHostStateWrite(msg: RpcMessage) {
    if (!this.stateWriteHandler) {
      this.writeHostError(msg.id, 'host does not support state bridge');
      return;
    }    try {
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

  private async handleHostListTools(msg: RpcMessage) {
    if (!this.listToolsHandler) {
      // Unwired host: the engine falls back to the turn-start snapshot.
      this.writeHostError(msg.id, 'host does not support list_tools');
      return;
    }
    try {
      this.writeHostResult(msg.id, await this.listToolsHandler());
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
    }
  }

  private async handleHostGoal(msg: RpcMessage) {
    if (!this.goalHandler) {
      // Unwired host: the session's goal provider degrades to no goal
      // budgeting (the engine treats the answer as absent).
      this.writeHostResult(msg.id, null);
      return;
    }
    try {
      this.writeHostResult(msg.id, await this.goalHandler());
    } catch (error) {
      this.writeHostError(msg.id, error instanceof Error ? error.message : String(error));
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

  // ── EngineSession handle RPCs (M1d 3b) ──────────────────────────────────
  // The stdio transport drives the same session surface as the napi addon.
  // Params mirror rpc/types.rs (`SessionEnqueueParams` etc.); responses are
  // validated against the wire-schema mirrors on the way out.

  async sessionCreate(params: unknown): Promise<string> {
    const result = await this.request('session/create', params);
    return parseWireObject(z.string(), result, 'session/create result');
  }

  async sessionEnqueueTurn(
    sessionId: string,
    prompt: SessionMessageWire,
    admission: SessionAdmission,
  ): Promise<number> {
    const result = await this.request('session/enqueue_turn', {
      session_id: sessionId,
      prompt,
      admission,
    });
    return parseWireObject(z.number(), result, 'session/enqueue_turn result');
  }

  async sessionTurnOutcome(sessionId: string, turnId: number): Promise<SessionTurnOutcomeWire> {
    const result = await this.request('session/turn_outcome', {
      session_id: sessionId,
      turn_id: turnId,
    });
    return parseWireObject(
      sessionTurnOutcomeResultSchema,
      result,
      'session/turn_outcome result',
    );
  }

  async sessionCancelTurn(sessionId: string, turnId?: number): Promise<boolean> {
    const result = await this.request('session/cancel_turn', {
      session_id: sessionId,
      ...(turnId === undefined ? {} : { turn_id: turnId }),
    });
    return parseWireObject(z.boolean(), result, 'session/cancel_turn result');
  }

  async sessionStatus(sessionId: string): Promise<SessionStatusWire> {
    const result = await this.request('session/status', { session_id: sessionId });
    return parseWireObject(sessionStatusResultSchema, result, 'session/status result');
  }

  async sessionIsSettled(sessionId: string): Promise<boolean> {
    const result = await this.request('session/is_settled', { session_id: sessionId });
    return parseWireObject(z.boolean(), result, 'session/is_settled result');
  }

  async sessionSettled(sessionId: string): Promise<void> {
    await this.request('session/settled', { session_id: sessionId });
  }

  async sessionTryAcquireQuiescence(sessionId: string): Promise<boolean> {
    const result = await this.request('session/try_acquire_quiescence', {
      session_id: sessionId,
    });
    return parseWireObject(z.boolean(), result, 'session/try_acquire_quiescence result');
  }

  async sessionReleaseQuiescence(sessionId: string): Promise<void> {
    await this.request('session/release_quiescence', { session_id: sessionId });
  }

  async sessionSetHistory(sessionId: string, history: SessionMessageWire[]): Promise<void> {
    await this.request('session/set_history', { session_id: sessionId, history });
  }

  async sessionClearHistory(sessionId: string): Promise<void> {
    await this.request('session/clear_history', { session_id: sessionId });
  }

  async sessionExtendHistory(sessionId: string, history: SessionMessageWire[]): Promise<void> {
    await this.request('session/extend_history', { session_id: sessionId, history });
  }

  async sessionHistoryLen(sessionId: string): Promise<number> {
    const result = await this.request('session/history_len', { session_id: sessionId });
    return parseWireObject(z.number(), result, 'session/history_len result');
  }

  async sessionDispose(sessionId: string): Promise<void> {
    await this.request('session/dispose', { session_id: sessionId });
  }
}

// ── Stdio session transport (M1d 3b) ──────────────────────────────────────
// The stdio transport drives the same EngineSession surface as the napi
// addon, over JSON-RPC. Host callbacks are wired onto the AgentProcess at
// session create; the engine's session turns route through them.

/**
 * Transport-neutral per-turn host handlers. The override packs the current
 * turn's closures into this shape; the napi transport wraps them into its
 * JSON-string callback registry and the stdio transport hands them to
 * AgentProcess as-is.
 */
type ActiveCallbacks = {
  llmChat: (signal: AbortSignal | undefined, modelName?: string) => Promise<LlmChatResponse>;
  executeTool: (req: ToolExecuteRequest) => Promise<ToolExecuteResponse>;
  emitEvent: (event: EngineEvent) => void;
  checkPermission: (req: PermissionCheckRequest) => Promise<PermissionDecision>;
  askQuestion?: (req: AskQuestionWire) => Promise<AskQuestionWireResult>;
  stateRead?: (req: StateReadWire) => Promise<StateReadWireResult>;
  stateWrite?: (req: StateWriteWire) => Promise<StateWriteWireResult>;
  checkpoint?: (req: CheckpointWire) => Promise<void>;
  listTools: () => Promise<ListToolsResult>;
  goal: () => GoalContext | undefined;
  turnEvent?: (event: TurnEventWire) => void;
  telemetry?: (event: TelemetryEventWire) => void;
};

/** Convert the napi-shaped session params to the snake_case stdio wire. */
function toStdioSessionParams(params: Record<string, unknown>): Record<string, unknown> {
  const nativeLlm = params['nativeLlm'] as
    | { protocol: string; apiKey?: string; baseUrl?: string; model: string; maxTokens?: number }
    | undefined;
  const telemetry = params['telemetry'] as
    | { mode: string; providerType: string; protocol: string; thinkingEffort?: string }
    | undefined;
  const providers = params['providers'] as
    | { name: string; model: string; systemPrompt: string }[]
    | undefined;
  const policySnapshotJson = params['policySnapshotJson'] as string | undefined;
  const subagentProfiles = params['subagentProfiles'] as
    | {
        name: string;
        description?: string;
        systemPrompt?: string;
        tools?: string[];
        disallowedTools?: string[];
        promptPrefix?: string;
        /** Serialized `{ min_chars, continuation_prompt, retries }` (the
         *  serde shape the engine parses). */
        summaryPolicyJson?: string;
      }[]
    | undefined;
  return {
    turn_id: params['turnId'],
    system_prompt: params['systemPrompt'],
    model_name: params['modelName'],
    messages: [],
    tools: [],
    max_steps: params['maxSteps'],
    providers: providers?.map((p) => ({
      name: p.name,
      model: p.model,
      system_prompt: p.systemPrompt,
    })),
    native_llm:
      nativeLlm === undefined
        ? undefined
        : {
            protocol: nativeLlm.protocol,
            base_url: nativeLlm.baseUrl,
            api_key: nativeLlm.apiKey,
            model: nativeLlm.model,
            max_tokens: nativeLlm.maxTokens,
          },
    workspace_root: params['workspaceRoot'],
    native_tools: params['nativeTools'],
    rust_self_contained: params['rustSelfContained'],
    shell_path: params['shellPath'],
    policy_snapshot:
      policySnapshotJson === undefined ? undefined : JSON.parse(policySnapshotJson),
    github_token: params['githubToken'],
    github_base_url: params['githubBaseUrl'],
    telemetry:
      telemetry === undefined
        ? undefined
        : {
            mode: telemetry.mode,
            provider_type: telemetry.providerType,
            protocol: telemetry.protocol,
            thinking_effort: telemetry.thinkingEffort,
          },
    subagent_profiles: subagentProfiles?.map((p) => ({
      name: p.name,
      description: p.description,
      system_prompt: p.systemPrompt,
      tools: p.tools,
      disallowed_tools: p.disallowedTools,
      prompt_prefix: p.promptPrefix,
      summary_policy:
        p.summaryPolicyJson === undefined
          ? undefined
          : (JSON.parse(p.summaryPolicyJson) as unknown),
    })),
    subagent_timeout_ms: params['subagentTimeoutMs'],
    agent_tool_veto: params['agentToolVeto'],
    tools_veto: params['toolsVeto'],
  };
}

/** Convert a `SessionPrompt` (napi shape) to the stdio wire `Message`. */
function sessionPromptToWire(prompt: SessionPrompt): SessionMessageWire {
  return {
    role: prompt.role,
    content: prompt.content,
    blocks:
      prompt.blocksJson === undefined ? undefined : (JSON.parse(prompt.blocksJson) as unknown[]),
    tool_calls:
      prompt.toolCallsJson === undefined
        ? undefined
        : (JSON.parse(prompt.toolCallsJson) as { id: string; name: string; arguments: unknown }[]),
    tool_call_id: prompt.toolCallId,
  };
}

/** Convert a wire `Message` to the `SessionPrompt` (napi shape). */
function wireToSessionPrompt(m: WireMessage): SessionPrompt {
  return {
    role: m.role,
    content: typeof m.content === 'string' ? m.content : '',
    blocksJson: m.blocks === undefined ? undefined : JSON.stringify(m.blocks),
    toolCallsJson: m.tool_calls === undefined ? undefined : JSON.stringify(m.tool_calls),
    toolCallId: m.tool_call_id ?? undefined,
  };
}

/** Project a wire `SessionTurnOutcomeWire` (snake_case) onto the handle shape. */
function wireOutcomeToSession(w: SessionTurnOutcomeWire): SessionTurnOutcome {
  if (w.status !== 'ran' || w.result === undefined) {
    return { status: w.status };
  }
  const r = w.result;
  return {
    status: 'ran',
    result: {
      stopReason: r.stop_reason,
      steps: r.steps,
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
      totalTokens: r.usage.total_tokens,
      inputCacheRead: r.usage.input_cache_read ?? 0,
      inputCacheCreation: r.usage.input_cache_creation ?? 0,
      eventsEmitted: r.events_emitted ?? 0,
      llmRetries: r.llm_retries ?? 0,
      llmTransport: r.llm_transport ?? '',
      nativeToolCalls: r.native_tool_calls ?? 0,
    },
  };
}

export class StdioSessionTransport implements SessionTransport {
  constructor(private readonly agent: AgentProcess) {}

  async createSession(params: Record<string, unknown>, callbacks: unknown): Promise<string> {
    const c = callbacks as ActiveCallbacks;
    this.agent.setLlmChatHandler((signal, modelName) => c.llmChat(signal, modelName));
    this.agent.setToolExecuteHandler((req) => c.executeTool(req));
    this.agent.setEventHandler((event) => c.emitEvent(event));
    this.agent.setPermissionHandler((req) => c.checkPermission(req));
    if (c.askQuestion !== undefined) {
      this.agent.setAskQuestionHandler((req) => c.askQuestion!(req));
    }
    if (c.stateRead !== undefined) {
      this.agent.setStateReadHandler((req) => c.stateRead!(req));
    }
    if (c.stateWrite !== undefined) {
      this.agent.setStateWriteHandler((req) => c.stateWrite!(req));
    }
    if (c.checkpoint !== undefined) {
      this.agent.setCheckpointHandler((req) => c.checkpoint!(req));
    }
    this.agent.setListToolsHandler(() => c.listTools());
    this.agent.setGoalHandler(() => Promise.resolve(c.goal() ?? null));
    this.agent.setTurnEventHandler((event) => c.turnEvent?.(event));
    this.agent.setTelemetryHandler((event) => c.telemetry?.(event));
    const stdioParams = toStdioSessionParams(params);
    parseWireObject(runTurnParamsSchema, stdioParams, 'session/create request');
    return this.agent.sessionCreate(stdioParams);
  }

  async enqueueTurn(
    sessionId: string,
    prompt: SessionPrompt,
    admission: SessionAdmission,
  ): Promise<number> {
    const wire = sessionPromptToWire(prompt);
    parseWireObject(
      sessionEnqueueTurnParamsSchema,
      { session_id: sessionId, prompt: wire, admission },
      'session/enqueue_turn request',
    );
    return this.agent.sessionEnqueueTurn(sessionId, wire, admission);
  }

  async turnOutcome(sessionId: string, turnId: number): Promise<SessionTurnOutcome> {
    return wireOutcomeToSession(await this.agent.sessionTurnOutcome(sessionId, turnId));
  }

  async cancelTurn(sessionId: string, turnId?: number): Promise<boolean> {
    return this.agent.sessionCancelTurn(sessionId, turnId);
  }

  async status(sessionId: string): Promise<SessionStatus> {
    const w = await this.agent.sessionStatus(sessionId);
    return {
      activeTurnId: w.active_turn_id,
      pendingTurnIds: w.pending_turn_ids,
      engine: w.engine ?? null,
    };
  }

  async isSettled(sessionId: string): Promise<boolean> {
    return this.agent.sessionIsSettled(sessionId);
  }

  async settled(sessionId: string): Promise<void> {
    return this.agent.sessionSettled(sessionId);
  }

  async tryAcquireQuiescence(sessionId: string): Promise<boolean> {
    return this.agent.sessionTryAcquireQuiescence(sessionId);
  }

  async releaseQuiescence(sessionId: string): Promise<void> {
    return this.agent.sessionReleaseQuiescence(sessionId);
  }

  async setHistory(sessionId: string, history: SessionPrompt[]): Promise<void> {
    const wire = history.map(sessionPromptToWire);
    parseWireObject(
      sessionHistoryParamsSchema,
      { session_id: sessionId, history: wire },
      'session/set_history request',
    );
    return this.agent.sessionSetHistory(sessionId, wire);
  }

  async clearHistory(sessionId: string): Promise<void> {
    return this.agent.sessionClearHistory(sessionId);
  }

  async extendHistory(sessionId: string, history: SessionPrompt[]): Promise<void> {
    return this.agent.sessionExtendHistory(sessionId, history.map(sessionPromptToWire));
  }

  async historyLen(sessionId: string): Promise<number> {
    return this.agent.sessionHistoryLen(sessionId);
  }

  async dispose(sessionId: string): Promise<void> {
    return this.agent.sessionDispose(sessionId);
  }
}

// ── Engine selection ──────────────────────────────────────────────────────

/// Which transport is active for the current session.
export type EngineMode = 'napi' | 'stdio' | 'js';

let engineMode: EngineMode = 'js';
let agentProcess: AgentProcess | null = null;

/**
 * The transport currently driving turns, without resolving it. `initEngine()`
 * would spawn the stdio child process, so a status read must not trigger it:
 * `'js'` here means no native transport has run a turn yet, or the stdio
 * engine hit its restart cap and fell back.
 */
export function activeEngineMode(): EngineMode {
  return engineMode;
}

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

  // ── M1d 3a + 3b: session-backed transports ────────────────────────────
  // Both transports (napi and stdio) drive turns through one engine-owned
  // session for the process lifetime: admission, the pending FIFO, the
  // pump, turn ids, cancellation, and quiescence live engine-side across
  // turns. The host routes per-turn capabilities through the `active` slot
  // the session-scoped delegates read. turn_event/telemetry stay unwired
  // until 3c (dropped) — v2 keeps durable-event + telemetry ownership.
  //
  // The slot variables live here (not per turn): the session is created
  // once and reused until the per-turn config fingerprint (nativeLlm /
  // policy / github) changes, and `active` is reassigned at the top of every
  // turn so the session-scoped delegates always read the running turn.
  type ActiveTurn = ActiveCallbacks & {
    input: TurnEngineInputAdapter;
    turnId: string;
    llmAbort: LlmAbortRegistry;
  };
  let active: ActiveTurn | undefined;
  let sessionHandle: EngineSessionHandle | undefined;
  let sessionFingerprint: string | undefined;
  /// The stdio agent process the session was created on. A stdio crash drops
  /// the process and re-spawns a new one; a session built on the old process
  /// is dead and must be rebuilt (the crash-recovery contract).
  let sessionAgent: AgentProcess | null = null;

  // The napi callback registry is JSON-string shaped; wrap the raw
  // per-turn handlers (read through the shared `active` slot, so every
  // turn sees its own handlers) into that contract.
  const wrapActiveForNapi = (): SessionCallbacks => ({
    llmChat: async (requestJson: string): Promise<string> => {
      const params = parseWire(llmChatRequestSchema, requestJson, 'host/llm_chat request');
      const request = active!.llmAbort.begin(params.request_id);
      try {
        const response = await active!.llmChat(request.signal, params.model_name);
        return JSON.stringify(response);
      } finally {
        request.finish();
      }
    },
    executeTool: async (requestJson: string): Promise<string> => {
      const req = parseWire(toolExecuteRequestSchema, requestJson, 'host/execute_tool request');
      const response = await active!.executeTool(req);
      return JSON.stringify(response);
    },
    emitEvent: (json: string): void => {
      try {
        active!.emitEvent(JSON.parse(json) as EngineEvent);
      } catch {
        // Event handler failures must never break the RPC loop (the engine
        // is fire-and-forget on this channel).
      }
    },
    checkPermission: async (requestJson: string): Promise<string> => {
      const req = parseWire(
        permissionCheckRequestSchema,
        requestJson,
        'host/check_permission request',
      );
      const response = await active!.checkPermission(req);
      return JSON.stringify(response);
    },
    askQuestion:
      active!.askQuestion === undefined
        ? undefined
        : async (requestJson: string): Promise<string> => {
            const response = await active!.askQuestion!(JSON.parse(requestJson) as AskQuestionWire);
            return JSON.stringify(response);
          },
    stateRead:
      active!.stateRead === undefined
        ? undefined
        : async (requestJson: string): Promise<string> => {
            const response = await active!.stateRead!(JSON.parse(requestJson) as StateReadWire);
            return JSON.stringify(response);
          },
    stateWrite:
      active!.stateWrite === undefined
        ? undefined
        : async (requestJson: string): Promise<string> => {
            const response = await active!.stateWrite!(JSON.parse(requestJson) as StateWriteWire);
            return JSON.stringify(response);
          },
    checkpoint:
      active!.checkpoint === undefined
        ? undefined
        : async (requestJson: string): Promise<string> => {
            await active!.checkpoint!(JSON.parse(requestJson) as CheckpointWire);
            return 'null';
          },
    listTools: async (): Promise<string> => JSON.stringify(await active!.listTools()),
    goal: () => {
      const g = active!.goal();
      return Promise.resolve(g === undefined ? null : JSON.stringify(g));
    },
    turnEvent: (eventJson: string): void => {
      try {
        active!.turnEvent?.(parseWireObject(turnEventSchema, JSON.parse(eventJson), 'host/turn_event'));
      } catch (error) {
        // A malformed durable record must not be dropped silently — the
        // transcript would fold a corrupt lifecycle.
        console.error('[kimi-agent] rejected host/turn_event:', error);
      }
    },
    telemetry: (eventJson: string): void => {
      try {
        active!.telemetry?.(
          parseWireObject(telemetryEventSchema, JSON.parse(eventJson), 'host/telemetry'),
        );
      } catch (error) {
        console.error('[kimi-agent] rejected host/telemetry:', error);
      }
    },
  });

  // Mid-turn steer delivery: the loop materializes the steer into the host
  // context and pushes the projected message into the engine session's steer
  // queue, where the running turn's per-step drain picks it up. Best-effort —
  // a failed push (e.g. the engine turn just ended) leaves the steer to reach
  // the model through the next turn's context projection.
  const deliverSteer = async (message: unknown): Promise<void> => {
    const handle = sessionHandle;
    if (handle === undefined) return;
    if (!isHostMessage(message)) return;
    await handle.enqueueTurn(wireToSessionPrompt(projectHostMessageToWire(message)), 'activeTurnOnly');
  };

  const engine = async (input: TurnEngineInputAdapter) => {
    // v2 hands us a numeric turnId; the wire protocol and LoopRecordedEvent
    // use a string, so normalize once per turn.
    const turnIdStr = String(input.turnId);

    // Host cancellation reaches the engine through the session handle:
    // the per-turn code registers an abort listener that cancels by the
    // engine-assigned turn id after enqueue (see the session section).

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
              note: event.note ?? undefined,
            } as never,
          });
          break;
        }
        case 'tool.native.progress': {
          input.onToolProgress?.({
            turnId: Number(event.turn_id),
            toolCallId: event.tool_call_id,
            update: {
              kind: event.kind === 'stderr' ? 'stderr' : 'stdout',
              text: event.text,
            },
          });
          break;
        }
        case 'goal.budget.limit_reached': {
          // Forwarded for host-side accounting; the turn already stops
          // with a BudgetLimited stop reason from the Rust loop.
          break;
        }
        case 'subagent.spawned': {
          input.onSubagentEvent?.({
            type: 'subagent.spawned',
            subagentId: event.subagent_id,
            subagentName: event.subagent_name,
            parentToolCallId: event.parent_tool_call_id ?? undefined,
            description: event.description ?? undefined,
            runInBackground: event.run_in_background ?? false,
          });
          break;
        }
        case 'subagent.started': {
          input.onSubagentEvent?.({ type: 'subagent.started', subagentId: event.subagent_id });
          break;
        }
        case 'subagent.completed': {
          input.onSubagentEvent?.({
            type: 'subagent.completed',
            subagentId: event.subagent_id,
            resultSummary: event.result_summary,
            usage:
              event.usage === undefined
                ? undefined
                : {
                    inputOther: event.usage.input_tokens ?? 0,
                    output: event.usage.output_tokens ?? 0,
                    inputCacheRead: event.usage.input_cache_read ?? 0,
                    inputCacheCreation: event.usage.input_cache_creation ?? 0,
                  },
          });
          break;
        }
        case 'subagent.failed': {
          input.onSubagentEvent?.({
            type: 'subagent.failed',
            subagentId: event.subagent_id,
            error: event.error,
          });
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

    // M1d: the engine pulls the fresh tool table before each native LLM call
    // (host/list_tools) — same source as the turn-start snapshot but read per
    // call, so mid-turn registry changes reach the model. Host-proxy mode
    // never consults it (the host rebuilds tools inside llm_chat).
    const listToolsHandler = async (): Promise<ListToolsResult> => ({
      tools: input.buildTools().map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: (t as { parameters?: unknown }).parameters ?? {},
      })),
    });

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
      // Steers are materialized into the context at steer time (the loop's
      // engine-path steer delivery), so the next buildMessages projection
      // already carries them. Awaiting the event chain first keeps the step
      // record ordered after the tool results that are still being appended
      // for the step that just ran.
      await eventChain;
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

      // Accumulate the streamed text so the wire response carries it: the
      // main host-proxy turn does not need it (the host owns the
      // transcript), but engine-spawned subagents read their summary from
      // the assistant text the engine sees (P46).
      let chatText = '';
      const response = await input.llm.chat({
        messages,
        tools: stepTools,
        signal: signal ?? input.signal,
        modelName,
        onTextPart: async (part) => {
          chatText += part.text;
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
        content: chatText,
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
    // In host-proxy mode, message content and the tool table are NOT sent
    // to the engine up front: the host rebuilds both from `context` on
    // every host/llm_chat callback (the source of truth), so Rust only
    // needs metadata to drive control flow. In native LLM mode the engine
    // reads its history (set per turn below) and calls the provider itself,
    // with progress flowing back over the event channel.
    const policySnapshot = options?.getPolicySnapshot?.();
    const githubCredentials = options?.getGithubCredentials?.();
    const telemetryContext = options?.getTelemetryContext?.();
    const askUserQuestion = input.askUserQuestion?.bind(input) ?? options?.askUserQuestion;
    const stateRead = input.stateRead?.bind(input) ?? options?.stateRead;
    const stateWrite = input.stateWrite?.bind(input) ?? options?.stateWrite;
    const policySnapshotJson =
      policySnapshot === undefined ? undefined : JSON.stringify(policySnapshot);

    // Pack the per-turn handlers into the `active` slot the session-scoped
    // delegates read. Set before any session call so late events route here.
    // The handlers are transport-neutral; each transport adapts them (napi:
    // JSON-string callback registry, stdio: AgentProcess handlers).
    active = {
      input,
      turnId: turnIdStr,
      llmAbort: llmAbortRegistry,
      llmChat: llmChatHandler,
      executeTool: toolExecuteHandler,
      emitEvent: handleEngineEvent,
      checkPermission: async (req: PermissionCheckRequest): Promise<PermissionDecision> => {
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
      },
      askQuestion: askUserQuestion,
      stateRead,
      stateWrite,
      checkpoint: async (req: CheckpointWire) => {
        await input.onCheckpoint?.({
          turnId: Number(req.turn_id),
          phase: req.phase,
          paths: req.paths,
        });
      },
      listTools: listToolsHandler,
      goal: () => options?.getGoal?.() ?? projectEngineGoal(input.getGoal?.()),
      turnEvent: (event) => input.onTurnEvent?.(event),
      telemetry: (event) => input.onTurnTelemetry?.(event),
    };

    let rustResult: RunTurnResult;
    try {
      // ── Session-backed transports (M1d 3a napi + 3b stdio) ──────────
      // Both transports replace the per-turn `runTurn` / `agent/run_turn`
      // calls with setHistory + enqueueTurn on a process-wide session
      // handle. Re-create the handle when the per-turn config fingerprint
      // (nativeLlm / policy / github) changes.
      const fingerprint = JSON.stringify({
        nativeLlm,
        policy: policySnapshot,
        github: githubCredentials,
        subagentProfiles: input.subagentProfiles,
        subagentTimeoutMs: input.subagentTimeoutMs,
        agentToolVeto: input.agentToolVeto,
        toolsVeto: input.toolsVeto,
      });
      // A stdio crash re-spawns the agent process; a session on the old
      // process is dead and must be rebuilt (the crash-recovery contract).
      const agentChanged = mode === 'stdio' && sessionAgent !== getAgent();
      if (
        sessionHandle === undefined ||
        fingerprint !== sessionFingerprint ||
        agentChanged
      ) {
        if (sessionHandle !== undefined) {
          await sessionHandle.dispose();
          sessionHandle = undefined;
        }
        sessionFingerprint = fingerprint;
        sessionAgent = mode === 'stdio' ? getAgent() : null;
        const sessionParams: Record<string, unknown> = {
          turnId: turnIdStr,
          systemPrompt: input.llm.systemPrompt,
          modelName: input.llm.modelAlias,
          messages: [],
          tools: [],
          maxSteps: input.maxSteps,
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
          telemetry:
            telemetryContext === undefined
              ? undefined
              : {
                  mode: telemetryContext.mode,
                  providerType: telemetryContext.provider_type,
                  protocol: telemetryContext.protocol,
                  thinkingEffort: telemetryContext.thinking_effort,
                },
          subagentProfiles: input.subagentProfiles?.map((p) => ({
            name: p.name,
            description: p.description,
            systemPrompt: p.systemPrompt,
            tools: p.tools,
            disallowedTools: p.disallowedTools,
            promptPrefix: p.promptPrefix,
            // napi carries the policy as a serialized JSON string; the
            // engine parses it with the serde snake_case field names.
            summaryPolicyJson: p.summaryPolicy
              ? JSON.stringify({
                  min_chars: p.summaryPolicy.minChars,
                  continuation_prompt: p.summaryPolicy.continuationPrompt,
                  retries: p.summaryPolicy.retries,
                })
              : undefined,
          })),
          subagentTimeoutMs: input.subagentTimeoutMs,
          // P52 native-path vetoes (swarm Agent denial / btw full tool
          // denial): part of the session fingerprint, so an enter/exit
          // rebuilds the session and the engine sees the fresh reasons.
          agentToolVeto: input.agentToolVeto,
          toolsVeto: input.toolsVeto,
        };
        // Stable delegates over the shared `active` slot: bound once at
        // session create, read the current turn's handlers at call time
        // (the session runs turns serially, so one slot suffices).
        const sessionCallbacks: ActiveCallbacks = {
          llmChat: (signal, modelName) => active!.llmChat(signal, modelName),
          executeTool: (req) => active!.executeTool(req),
          emitEvent: (event) => {
            active!.emitEvent(event);
          },
          checkPermission: (req) => active!.checkPermission(req),
          askQuestion:
            active!.askQuestion === undefined
              ? undefined
              : (req) => active!.askQuestion!(req),
          stateRead:
            active!.stateRead === undefined ? undefined : (req) => active!.stateRead!(req),
          stateWrite:
            active!.stateWrite === undefined ? undefined : (req) => active!.stateWrite!(req),
          checkpoint:
            active!.checkpoint === undefined ? undefined : (req) => active!.checkpoint!(req),
          listTools: () => active!.listTools(),
          goal: () => active!.goal(),
          turnEvent: (event) => active!.turnEvent?.(event),
          telemetry: (event) => active!.telemetry?.(event),
        };
        sessionHandle =
          mode === 'napi'
            ? await EngineSessionHandle.create(sessionParams, wrapActiveForNapi())
            : await EngineSessionHandle.createWith(
                new StdioSessionTransport(getAgent()!),
                sessionParams,
                sessionCallbacks,
              );
      }
      // The stdio transport's host handlers read the current turn's abort
      // registry (napi reaches it through the shared `active` slot), so it
      // is refreshed every turn — not just at session create.
      if (mode === 'stdio') {
        getAgent()!.setLlmAbortRegistry(llmAbortRegistry);
      }
      const handle = sessionHandle;

      // Per-turn context projection: the host's `buildWireMessages()` is the
      // single source of truth (the engine's own history is control-flow
      // plumbing in host-proxy mode; in native mode the wire projection keeps
      // image/audio/video blocks lossless — raw v2 blocks would fail the Rust
      // ContentBlock parse and be dropped silently).
      const messages = await buildWireMessages();
      const prompts: SessionPrompt[] = messages.map(wireToSessionPrompt);
      // The engine history is replaced every turn (host owns context), so
      // set it even when the projected context holds only the prompt.
      await handle.setHistory(prompts.slice(0, -1));
      const lastPrompt = prompts[prompts.length - 1] ?? { role: 'user', content: '' };
      const engineTurnId = await handle.enqueueTurn(lastPrompt, 'newTurn');

      // Abort → cancel the engine-assigned turn id. Guard the
      // already-aborted race: the listener is registered after the async
      // projection above.
      input.signal.addEventListener('abort', () => void handle.cancelTurn(engineTurnId), {
        once: true,
      });
      if (input.signal.aborted) void handle.cancelTurn(engineTurnId);

      const outcome = await handle.turnOutcome(engineTurnId);
      if (outcome.status !== 'ran' || !outcome.result) {
        throw new Error(`session turn ${engineTurnId} did not complete (${outcome.status})`);
      }
      const o = outcome.result;
      rustResult = {
        stop_reason: o.stopReason,
        steps: o.steps,
        usage: {
          input_tokens: o.inputTokens,
          output_tokens: o.outputTokens,
          total_tokens: o.totalTokens,
          input_cache_read: o.inputCacheRead,
          input_cache_creation: o.inputCacheCreation,
        },
        events_emitted: o.eventsEmitted,
        llm_retries: o.llmRetries,
        llm_transport: o.llmTransport,
        native_tool_calls: o.nativeToolCalls,
      };
    } finally {
      // Flush queued engine events before closing the last step so the
      // transcript records deltas/tool results in order.
      await eventChain.catch(() => {});
      await closeOpenStep();
    }

    const stopReason = mapStopReason(rustResult.stop_reason);

    const turnResult = {
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
    options?.onTurnResult?.(turnResult);
    return turnResult;
  };
  engine.deliverSteer = deliverSteer;
  return engine;
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
 * Parse and validate an engine→host wire payload against its zod mirror
 * (`wire-schema.ts`). The napi boundary crosses these as JSON strings, so the
 * compile-time check on `napi-contract.d.ts` does not reach them — a Rust-side
 * shape change must fail here with a named payload instead of silently
 * misbehaving downstream. Throws (the callback error path surfaces it to the
 * engine as a failed host call).
 */
function parseWire<T>(schema: ZodType<T>, payload: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch (error) {
    throw new Error(
      `Malformed ${what}: payload is not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return parseWireObject(schema, value, what);
}

/** Validate an already-parsed engine→host wire value (see {@link parseWire}). */
function parseWireObject<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Malformed ${what}: ${parsed.error.message}`);
  }
  return parsed.data;
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

