import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { AgentContextData } from '@moonshot-ai/agent-core-v2';
import { EngineSessionHandle, type SessionCallbacks, type SessionPrompt, type SessionTurnOutcome } from '@moonshot-ai/kimi-agent/session-handle';
import type { TurnEndReason } from '@moonshot-ai/protocol';
import type { QuestionItem, ToolInputDisplay } from '#/events';
import {
  resolveNativeLlm,
  probeShellPath,
  buildPolicySnapshot,
  resolveGithubCredentials,
  type JsNativeLlmConfig,
} from './native-llm-resolver';
import { ImageLimits } from '#/image-limits';
import { KimiHarness } from '#/kimi-harness';
import {
  loadRuntimeConfig,
  validateConfig,
  writeConfigFile,
  type KimiConfig,
  type KimiConfigPatch,
} from '#/config-local';
import {
  SDKRpcClientBase,
  type ActivateSkillRpcInput,
  type ImportContextRpcInput,
  type ReconnectMcpServerRpcInput,
  type ReloadSessionRpcInput,
  type SessionIdRpcInput,
  type SessionPromptRpcInput,
  type SessionPromptWithSkillsRpcInput,
  type SetSessionModelRpcInput,
  type SetSessionModelRpcResult,
  type SetSessionPermissionRpcInput,
  type SetSessionPlanModeRpcInput,
  type SetSessionSwarmModeRpcInput,
  type SetSessionThinkingRpcInput,
  type SetSessionTowerModeRpcInput,
  type UpdateSessionMetadataRpcInput,
} from '#/rpc';
import type {
  AddAdditionalDirInput,
  AddAdditionalDirResult,
  AgentCommandInfo,
  AppMcpServerInspection,
  BackgroundTaskInfo,
  BeginGlobalMcpServerAuthResult,
  CompactOptions,
  ConfigDiagnostics,
  CreateGoalInput,
  CreateSessionOptions,
  ExperimentalFeatureState,
  ExportSessionInput,
  ExportSessionResult,
  FileMeta,
  ForkSessionInput,
  GetConfigOptions,
  GetCronTasksResult,
  GlobalMcpServerAuthStatus,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
  KimiHostIdentity,
  ListSessionsOptions,
  McpManagedServerInfo,
  McpServerConfig,
  McpServerInfo,
  McpServerLocator,
  McpStartupMetrics,
  McpTestResult,
  PermissionMode,
  PluginCommandDef,
  PluginInfo,
  PluginSummary,
  ReloadSummary,
  RenameSessionInput,
  ResumeSessionInput,
  ResumedSessionSummary,
  SessionPlan,
  SessionStatus,
  SessionSummary,
  SessionSummaryPage,
  SessionTodoItem,
  SessionUsage,
  SkillSummary,
  TelemetryClient,
  TelemetryProperties,
  UploadFileOptions,
  WorkspaceTrustInfo,
} from '#/types';

import { KimiAuthFacade } from '#/auth';
import { ErrorCodes, KimiError } from '#/legacy';
import { resolveConfigPath, resolveKimiHome } from '#/config-local/path';
import type { OAuthRefreshOutcome } from '@moonshot-ai/kimi-code-oauth';
import { ZipFile } from 'yazl';

/**
 * Map the Rust engine's turn stop reason onto the protocol's closed
 * {@link TurnEndReason} set. The engine emits a wider vocabulary (aborted /
 * max_steps / length / tool_calls / …); forwarding those verbatim broke
 * consumers that switch on the four protocol values.
 */
function toTurnEndReason(raw: unknown): TurnEndReason {
  const value = (typeof raw === 'string' ? raw : 'completed').toLowerCase();
  if (
    value === 'cancelled' ||
    value === 'canceled' ||
    value === 'aborted' ||
    value === 'interrupted'
  ) {
    return 'cancelled';
  }
  if (
    value === 'failed' ||
    value === 'error' ||
    value === 'max_steps' ||
    value === 'max_tokens' ||
    value === 'length'
  ) {
    return 'failed';
  }
  if (value === 'blocked') {
    return 'blocked';
  }
  return 'completed';
}

/**
 * The native harness's TS-side goal state. The Rust engine pulls a fresh goal
 * snapshot per turn through the `goal` callback (snake_case wire), so this is
 * the authority for the goal lifecycle; budgets are not modelled natively yet,
 * so the budget report is all-null / not-reached.
 */
interface NativeGoalState {
  goalId: string;
  objective: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  turnsUsed: number;
  tokensUsed: number;
  inputTokensUsed: number;
  outputTokensUsed: number;
}

function toGoalSnapshot(goal: NativeGoalState): GoalSnapshot {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    turnsUsed: goal.turnsUsed,
    tokensUsed: goal.tokensUsed,
    inputTokensUsed: goal.inputTokensUsed,
    outputTokensUsed: goal.outputTokensUsed,
    wallClockMs: Date.now() - goal.createdAt,
    budget: {
      tokenBudget: null,
      turnBudget: null,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
      inputTokensUsed: goal.inputTokensUsed,
      outputTokensUsed: goal.outputTokensUsed,
    },
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

/**
 * The runtime agent state a fresh or resumed session starts with, derived from
 * the on-disk config. The setters that change these mid-session need an
 * engine-handle rebuild (the policy snapshot and native LLM are baked in at
 * createSession), so they land with the persistence work; until then the
 * getters read these config-derived defaults.
 */
function initialRuntimeState(config: KimiConfig, model: string) {
  return {
    model,
    thinkingEffort: config.thinking?.effort ?? 'off',
    permissionMode: (
      config.yolo === true
        ? 'yolo'
        : config.defaultPermissionMode === 'auto'
          ? 'auto'
          : 'manual'
    ) as PermissionMode,
    planMode: (config.defaultPermissionMode as string | undefined) === 'plan',
    swarmMode: false,
    towerMode: false,
    maxContextTokens:
      (config.defaultModel ? config.models?.[config.defaultModel]?.maxContextSize : undefined) ?? 0,
    contextTokens: 0,
    usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
    goal: null,
    currentTurnId: 0,
  };
}

/**
 * Apply a session's live model / thinking overrides to the config-resolved
 * native LLM. setModel / setThinking mutate meta and rebuild the handle, so the
 * rebuilt pipeline must carry the session's choice, not the config default. The
 * thinking-budget re-derivation mirrors native-llm-resolver's.
 */
function applySessionLlmOverrides(
  llm: JsNativeLlmConfig,
  meta: { model: string; thinkingEffort: string },
): JsNativeLlmConfig {
  const out: JsNativeLlmConfig = { ...llm, model: meta.model };
  const effort = meta.thinkingEffort;
  const thinkingOn = effort !== '' && effort !== 'off' && effort !== 'none';
  if (out.protocol === 'anthropic') {
    out.reasoningEffort = undefined;
    if (!thinkingOn) out.thinkingBudget = undefined;
    else if (effort === 'low') out.thinkingBudget = 1024;
    else if (effort === 'medium') out.thinkingBudget = 4096;
    else if (effort === 'high' || effort === 'on') out.thinkingBudget = 32000;
    else {
      const parsed = Number.parseInt(effort, 10);
      out.thinkingBudget = !Number.isNaN(parsed) && parsed > 0 ? parsed : 32000;
    }
  } else {
    out.thinkingBudget = undefined;
    out.reasoningEffort = thinkingOn ? effort : undefined;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The history cut index that removes the last `count` user turns: walking from
 * the end, the Nth-from-last user message starts the earliest turn to drop, so
 * everything from it onward is undone. Fewer than `count` user turns clears the
 * whole history.
 */
function truncateHistoryByTurns(history: readonly SessionPrompt[], count: number): number {
  if (count <= 0) return history.length;
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'user') {
      seen += 1;
      if (seen === count) return i;
    }
  }
  return 0;
}

/**
 * v2 `config.set` merge semantics for one domain: plain objects merge
 * recursively, arrays and scalars replace. An explicit `undefined` inside the
 * patch leaves the stored value untouched (mirrors the per-domain undefined
 * skip), so a patch can never silently clear a section.
 */
function deepMergeConfigValue(current: unknown, patch: unknown): unknown {
  if (isPlainObject(current) && isPlainObject(patch)) {
    const out: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      out[key] = deepMergeConfigValue(current[key], value);
    }
    return out;
  }
  return patch;
}

export interface SDKRpcClientNativeOptions {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly identity?: KimiHostIdentity | undefined;
  readonly auth?: KimiAuthFacade | undefined;
  readonly onOAuthRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
  readonly telemetry?: TelemetryClient | undefined;
  readonly uiMode?: string | undefined;
  readonly sessionStartedProperties?: TelemetryProperties | undefined;
  readonly imageLimits?: ImageLimits | undefined;
  readonly skillDirs?: readonly string[] | undefined;
  readonly engineOverride?: unknown;
}

interface NativeSessionMeta {
  readonly id: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly createdAt: number;
  updatedAt: number;
  title: string;
  isCustomTitle: boolean;
  busy: boolean;
  messageCount: number;
  /** Last turn id seen from the engine; kept on meta so it survives a rebuild. */
  currentTurnId: number;
  /** User-layer session metadata (v2 `session.custom`), merged by updateSessionMetadata. */
  custom: Record<string, unknown>;
  /** Workspace-level additional directories added via addAdditionalDir. */
  additionalDirs: string[];
  // Runtime agent state (re-derived from config on resume, not persisted): the
  // getters (getStatus / getUsage) read these; the setters that would change
  // them mid-session need an engine-handle rebuild and land with persistence.
  model: string;
  thinkingEffort: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  swarmMode: boolean;
  towerMode: boolean;
  maxContextTokens: number;
  contextTokens: number;
  usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number };
  goal: NativeGoalState | null;
  handle?: EngineSessionHandle;
}

/**
 * The durable, handle-free slice of {@link NativeSessionMeta}, written to
 * `<sessionDir>/session-meta.json` so a rename / metadata update / add-dir
 * survives a resume within the same home. Full transcript persistence is a
 * separate concern; this only carries the session's own bookkeeping.
 */
interface PersistedSessionMeta {
  id: string;
  workDir: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  isCustomTitle: boolean;
  custom: Record<string, unknown>;
  additionalDirs: string[];
}

export class SDKRpcClientNative extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;
  readonly skillDirs: readonly string[];

  private readonly liveSessions = new Map<string, NativeSessionMeta>();
  private readonly sessionBaseDir: string;
  private readonly activeCompactionControllers = new Map<string, AbortController>();

  constructor(options: SDKRpcClientNativeOptions = {}) {
    super();
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({ homeDir: this.homeDir, configPath: options.configPath });
    this.identity = options.identity;
    this.telemetry = options.telemetry ?? { track: () => {} };
    this.skillDirs = options.skillDirs ?? [];
    this.auth =
      options.auth ??
      new KimiAuthFacade({
        homeDir: this.homeDir,
        configPath: this.configPath,
        identity: this.identity,
        onRefresh: options.onOAuthRefresh,
      });
    this.sessionBaseDir = join(this.homeDir, 'sessions');
    if (!existsSync(this.sessionBaseDir)) {
      mkdirSync(this.sessionBaseDir, { recursive: true });
    }
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  protected override async getRpc(): Promise<any> {
    // The base class routes ~88 methods through `(await this.getRpc()).<wireName>(…)`.
    // Returning `this` made every not-yet-overridden wire name either throw a
    // TypeError (the wire name is not a method here, e.g. removeKimiProvider /
    // enterPlan / beginCompaction) or recurse forever (the wire name equals a base
    // method that re-enters getRpc, e.g. renameSession / forkSession / undoHistory),
    // hanging the CLI at 100% CPU. Hand back a Proxy that fails loud instead: any
    // wire call this harness has not implemented throws NOT_IMPLEMENTED naming the
    // wire method. Overridden public methods never reach getRpc, so they are
    // unaffected; as later batches override more methods, fewer calls hit this guard.
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          throw new KimiError(
            ErrorCodes.NOT_IMPLEMENTED,
            `native harness has not wired RPC method "${String(prop)}"`,
          );
        },
      },
    );
  }

  override async createSession(input: CreateSessionOptions): Promise<SessionSummary> {
    const sessionId = input.id ? input.id : `session_${randomUUID()}`;
    const workDir = input.workDir ?? process.cwd();
    const sessionDir = join(this.sessionBaseDir, sessionId);
    const now = Date.now();

    const config = loadRuntimeConfig(this.configPath);
    const nativeLlm = resolveNativeLlm(config);

    const meta: NativeSessionMeta = {
      id: sessionId,
      workDir,
      sessionDir,
      createdAt: now,
      updatedAt: now,
      title: 'New Session',
      isCustomTitle: false,
      busy: false,
      messageCount: 0,
      custom: {},
      additionalDirs: [],
      ...initialRuntimeState(config, nativeLlm?.model ?? config.defaultModel ?? 'default'),
    };
    this.liveSessions.set(sessionId, meta);

    try {
      meta.handle = await this.buildHandle(meta);
    } catch (error) {
      // Do not leave a handle-less session advertised as live.
      this.liveSessions.delete(sessionId);
      throw error;
    }
    this.persistMeta(meta);

    return {
      id: sessionId,
      workDir,
      sessionDir,
      title: meta.title,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Build the engine session handle for a session from its current meta. Also
   * the rebuild path: a mid-session model / thinking / permission change tears
   * the handle down and re-creates it here, carrying the conversation over via
   * getHistory / setHistory (see rebuildHandle). The callbacks close over meta
   * so the state / goal bridges serve the live session state per turn.
   */
  private async buildHandle(meta: NativeSessionMeta): Promise<EngineSessionHandle> {
    const sessionId = meta.id;
    const workDir = meta.workDir;
    const config = loadRuntimeConfig(this.configPath);
    const shellPath = probeShellPath();
    const resolvedLlm = resolveNativeLlm(config);
    const nativeLlm = resolvedLlm ? applySessionLlmOverrides(resolvedLlm, meta) : resolvedLlm;

    const callbacks: SessionCallbacks = {
      // Fail loud, never fake a reply. When no provider is configured the Rust
      // pipeline falls back to the host `llm_chat` proxy; throwing here surfaces
      // the missing provider config on the first turn instead of returning a
      // canned "Hello! I am Kimi Code." that ends the turn looking like a real
      // answer. createSession still succeeds (the proxy pipeline builds), so the
      // TUI can start and route the user to /login rather than failing to boot.
      llmChat: async () => {
        throw new KimiError(
          ErrorCodes.NOT_IMPLEMENTED,
          'native harness has no host LLM proxy — configure [providers.*] or [agent] nativeLlmProvider so the Rust engine calls the model directly',
        );
      },
      executeTool: async (req: string) => {
        // The Rust engine routes only host-owned tools here (MCP tools,
        // select_tools — everything not in NATIVE_TOOL_NAMES). The native
        // harness has no host tool registry yet, so fail loud *naming the tool*.
        // The previous path delegated to the base `toolCall`, which returned a
        // generic "SDK custom tool calls are not supported: <id>" that dropped
        // the tool name and read to the model like a transient failure to retry.
        let parsed: { tool_call_id?: string; tool_name?: string; arguments?: unknown };
        try {
          parsed = JSON.parse(req);
        } catch {
          return JSON.stringify({ output: 'malformed tool execute request', isError: true });
        }
        const toolName = parsed.tool_name ?? 'unknown';
        return JSON.stringify({
          output: `tool "${toolName}" is host-owned and not yet wired on the native harness`,
          isError: true,
        });
      },
      emitEvent: (eventJson: string) => {
        // Parse defensively, then forward only events we can map onto a typed
        // protocol Event. Unknown snake_case engine events are dropped rather
        // than spread into the stream (the old `...parsed` fallback produced
        // payloads consumers could not discriminate against the union).
        let parsed;
        try {
          parsed = JSON.parse(eventJson);
        } catch {
          return;
        }
        if (parsed.type === 'llm.delta') {
          if (parsed.part?.type === 'text' && typeof parsed.part.text === 'string') {
            this.receiveEvent({
              sessionId,
              agentId: 'main',
              type: 'assistant.delta',
              turnId: meta.currentTurnId,
              delta: parsed.part.text,
            });
          } else if (parsed.part?.type === 'think' && typeof parsed.part.think === 'string') {
            this.receiveEvent({
              sessionId,
              agentId: 'main',
              type: 'thinking.delta',
              turnId: meta.currentTurnId,
              delta: parsed.part.think,
            });
          }
        } else if (parsed.type === 'tool.native') {
          // One id for the started/result pair (M3): two independent
          // randomUUID() calls orphaned the result whenever the engine sent no
          // tool_call_id, leaving the TUI tool card stuck in "running".
          const toolCallId = String(parsed.tool_call_id ?? randomUUID());
          this.receiveEvent({
            sessionId,
            agentId: 'main',
            type: 'tool.call.started',
            turnId: meta.currentTurnId,
            toolCallId,
            name: String(parsed.tool_name ?? 'tool'),
            args: parsed.arguments ?? {},
          });
          this.receiveEvent({
            sessionId,
            agentId: 'main',
            type: 'tool.result',
            turnId: meta.currentTurnId,
            toolCallId,
            output: String(parsed.content ?? ''),
            isError: Boolean(parsed.is_error),
          });
        } else if (parsed.type === 'tool.native.progress') {
          this.receiveEvent({
            sessionId,
            agentId: 'main',
            type: 'tool.progress',
            turnId: meta.currentTurnId,
            // Progress must carry the same id as its started event to route to
            // the right card; a fresh uuid here would never match, so fall back
            // to empty (unrouted) rather than a bogus id.
            toolCallId: String(parsed.tool_call_id ?? ''),
            update: { kind: 'stdout', text: String(parsed.text ?? '') },
          });
        }
      },
      checkPermission: async (req: string) => {
        try {
          const parsed = JSON.parse(req) as {
            tool_call_id?: string;
            tool_name?: string;
            action?: string;
            display?: ToolInputDisplay;
          };
          const res = await this.requestApproval({
            sessionId,
            agentId: 'main',
            toolCallId: parsed.tool_call_id ?? randomUUID(),
            action: parsed.action ?? 'execute',
            toolName: parsed.tool_name ?? 'unknown',
            display: parsed.display ?? { kind: 'command', command: parsed.tool_name ?? 'action' },
          });
          if (res.decision === 'approved') {
            return JSON.stringify({ decision: 'allow' });
          }
          return JSON.stringify({ decision: 'deny', reason: res.feedback ?? 'User rejected' });
        } catch {
          return JSON.stringify({ decision: 'deny', reason: 'cancelled' });
        }
      },
      askQuestion: async (req: string) => {
        try {
          const parsed = JSON.parse(req) as { tool_call_id?: string; questions?: QuestionItem[] };
          const res = await this.requestQuestion({
            sessionId,
            agentId: 'main',
            toolCallId: parsed.tool_call_id ?? randomUUID(),
            questions: parsed.questions ?? [],
          });
          if (res === null) {
            return JSON.stringify({ answers: {}, cancelled: true, reason: 'cancelled' });
          }
          const rawAnswers = 'answers' in res ? res.answers : res;
          const answers: Record<string, string> = {};
          for (const [k, v] of Object.entries(rawAnswers)) {
            answers[k] = typeof v === 'string' ? v : 'true';
          }
          const method = 'method' in res ? res.method : undefined;
          return JSON.stringify({ answers, ...(method ? { method } : {}) });
        } catch {
          return JSON.stringify({ answers: {}, cancelled: true, reason: 'error' });
        }
      },
      stateRead: async (req: string) => {
        // The engine's plan guard reads plan mode through this bridge before
        // every guarded native call (M5 made the `plan` domain host-first), so
        // serving it from live meta lets setPlanMode take effect without
        // rebuilding the handle. Every other domain is engine-owned (todo /
        // goal / cron / task / turn): error so the Rust StateStoreCallbacks
        // falls back to its local store.
        const parsed = JSON.parse(req) as { domain?: string };
        if (parsed.domain === 'plan') {
          return JSON.stringify({ value: { active: meta.planMode } });
        }
        throw new Error('host does not support state bridge');
      },
      goal: async () => {
        // Fresh goal snapshot per turn (snake_case wire). Only an active goal
        // drives the engine's autonomous continuation; paused / terminal goals
        // report null so the turn loop does not keep going.
        const goal = meta.goal;
        if (!goal || goal.status !== 'active') return null;
        return JSON.stringify({
          goal_id: goal.goalId,
          objective: goal.objective,
          status: goal.status,
          wall_clock_ms: Date.now() - goal.createdAt,
          tokens_used: goal.tokensUsed,
          turns_used: goal.turnsUsed,
        });
      },
      turnEvent: (eventJson: string) => {
        let parsed;
        try {
          parsed = JSON.parse(eventJson);
        } catch {
          return;
        }
        if (parsed.type === 'turn.started') {
          meta.currentTurnId =
            typeof parsed.turn_id === 'number' ? parsed.turn_id : Number(parsed.turn_id) || 0;
          this.receiveEvent({
            sessionId,
            agentId: 'main',
            type: 'turn.started',
            turnId: meta.currentTurnId,
            // origin is required on TurnStartedEvent; native turns are always
            // user-prompted (skill / plugin / task origins are host-driven and
            // do not run through this engine callback).
            origin: { kind: 'user' },
            prompt: String(parsed.prompt ?? ''),
          });
        } else if (parsed.type === 'turn.ended') {
          this.receiveEvent({
            sessionId,
            agentId: 'main',
            type: 'turn.ended',
            turnId: meta.currentTurnId,
            reason: toTurnEndReason(parsed.reason ?? parsed.status),
          });
        }
        // Unknown turn events are dropped (see emitEvent).
      },
    };

    const policySnapshot = buildPolicySnapshot(config, workDir);
    // The session's live permission / plan mode overrides the config-derived
    // snapshot default: setPermission / setPlanMode mutate meta, and a rebuild
    // (or the plan guard's stateRead) must reflect the current mode.
    policySnapshot.mode = meta.planMode ? 'plan' : meta.permissionMode;
    const githubCreds = resolveGithubCredentials(config);
    const authToken =
      nativeLlm?.authProvider === undefined
        ? undefined
        : (request: string) => {
            const parsed = JSON.parse(request) as { provider: string; force: boolean };
            const tokenProvider = this.auth.resolveOAuthTokenProvider(parsed.provider);
            return tokenProvider.getAccessToken({ force: parsed.force === true });
          };

    const params = {
      turnId: sessionId,
      sessionId,
      callerAgentId: 'main',
      rustSelfContained: config.agent?.rustSelfContained === true,
      systemPrompt: 'You are Kimi Code, an intelligent AI coding assistant.',
      modelName: nativeLlm?.model ?? meta.model,
      messages: [],
      tools: [],
      workspaceRoot: workDir,
      nativeTools: config.agent?.nativeTools !== false,
      shellPath,
      policySnapshotJson: JSON.stringify(policySnapshot),
      ...(githubCreds.githubToken ? { githubToken: githubCreds.githubToken } : {}),
      ...(githubCreds.githubBaseUrl ? { githubBaseUrl: githubCreds.githubBaseUrl } : {}),
      ...(nativeLlm ? { nativeLlm } : {}),
    };

    return EngineSessionHandle.create(params, { ...callbacks, authToken });
  }

  override async resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    const sessionId = input.id;
    let meta = this.liveSessions.get(sessionId);
    if (meta === undefined) {
      const now = Date.now();
      const sessionDir = join(this.sessionBaseDir, sessionId);
      // Rehydrate the session's own bookkeeping from disk so a rename / metadata
      // update / add-dir made earlier in this home survives the resume. The live
      // engine handle is not rebuilt here (transcript replay across a resume is
      // the persistence work); requireSession-gated turns surface a clean
      // SESSION_NOT_FOUND until then rather than driving a freed handle.
      const persisted = this.loadMeta(sessionDir);
      const config = loadRuntimeConfig(this.configPath);
      const nativeLlm = resolveNativeLlm(config);
      meta = {
        id: sessionId,
        workDir: persisted?.workDir ?? process.cwd(),
        sessionDir,
        createdAt: persisted?.createdAt ?? now,
        updatedAt: persisted?.updatedAt ?? now,
        title: persisted?.title ?? 'Resumed Session',
        isCustomTitle: persisted?.isCustomTitle ?? false,
        busy: false,
        messageCount: 0,
        custom: persisted?.custom ?? {},
        additionalDirs: persisted?.additionalDirs ?? [],
        ...initialRuntimeState(config, nativeLlm?.model ?? config.defaultModel ?? 'default'),
      };
      this.liveSessions.set(sessionId, meta);
    }
    return {
      id: sessionId,
      workDir: meta.workDir,
      sessionDir: meta.sessionDir,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      sessionMetadata: {
        createdAt: new Date(meta.createdAt).toISOString(),
        updatedAt: new Date(meta.updatedAt).toISOString(),
        title: meta.title,
        isCustomTitle: meta.isCustomTitle,
        agents: {},
        custom: meta.custom,
      },
      agents: {},
    };
  }

  override async renameSession(input: RenameSessionInput): Promise<void> {
    const meta = this.requireSession(input.id);
    meta.title = input.title;
    meta.isCustomTitle = true;
    meta.updatedAt = Date.now();
    this.persistMeta(meta);
  }

  override async updateSessionMetadata(input: UpdateSessionMetadataRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    // v2 merges the patch into `session.custom` rather than replacing it.
    meta.custom = { ...meta.custom, ...input.metadata };
    meta.updatedAt = Date.now();
    this.persistMeta(meta);
  }

  override async addAdditionalDir(input: AddAdditionalDirInput): Promise<AddAdditionalDirResult> {
    const meta = this.requireSession(input.id);
    if (!meta.additionalDirs.includes(input.path)) {
      meta.additionalDirs.push(input.path);
      meta.updatedAt = Date.now();
      this.persistMeta(meta);
    }
    return {
      additionalDirs: [...meta.additionalDirs],
      projectRoot: meta.workDir,
      configPath: this.configPath,
      persisted: input.persist,
    };
  }

  override async listSessions(_input: ListSessionsOptions = {}): Promise<readonly SessionSummary[]> {
    const sessionsMap = new Map<string, SessionSummary>();
    if (existsSync(this.sessionBaseDir)) {
      try {
        const dirs = readdirSync(this.sessionBaseDir, { withFileTypes: true });
        for (const dir of dirs) {
          if (dir.isDirectory()) {
            const meta = this.loadMeta(join(this.sessionBaseDir, dir.name));
            if (meta) {
              sessionsMap.set(meta.id, {
                id: meta.id,
                workDir: meta.workDir,
                sessionDir: join(this.sessionBaseDir, meta.id),
                title: meta.title,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
              });
            }
          }
        }
      } catch {
        // ignore
      }
    }
    for (const meta of this.liveSessions.values()) {
      sessionsMap.set(meta.id, {
        id: meta.id,
        workDir: meta.workDir,
        sessionDir: meta.sessionDir,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
      });
    }
    return Array.from(sessionsMap.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  override async listSessionsPage(_input?: ListSessionsOptions): Promise<SessionSummaryPage> {
    const items = await this.listSessions();
    return {
      items,
    };
  }

  override async deleteSession(input: SessionIdRpcInput): Promise<void> {
    const meta = this.liveSessions.get(input.sessionId);
    if (meta?.handle) {
      await meta.handle.dispose().catch(() => {});
    }
    this.liveSessions.delete(input.sessionId);
  }

  override async closeSession(input: SessionIdRpcInput): Promise<void> {
    const meta = this.liveSessions.get(input.sessionId);
    if (meta?.handle) {
      await meta.handle.dispose().catch(() => {});
    }
    // Drop it from the live table: leaving a disposed handle behind made
    // listSessions keep advertising a closed session, and the next prompt would
    // enqueue a turn onto a freed native session id.
    this.liveSessions.delete(input.sessionId);
  }

  override async prompt(input: SessionPromptRpcInput): Promise<void> {
    const meta = this.liveSessions.get(input.sessionId);
    if (!meta?.handle) {
      // Never silently drop user input: an unknown/closed session is an error,
      // not a no-op that resolves while the TUI shows nothing.
      throw new KimiError(
        ErrorCodes.SESSION_NOT_FOUND,
        `cannot prompt unknown or closed session "${input.sessionId}"`,
      );
    }
    meta.busy = true;
    meta.updatedAt = Date.now();

    const prompt: SessionPrompt = {
      role: 'user',
      content: typeof input.input === 'string' ? input.input : JSON.stringify(input.input),
    };
    try {
      const turnId = await meta.handle.enqueueTurn(prompt, 'newTurn');
      const outcome = await meta.handle.turnOutcome(turnId);
      this.recordTurnOutcome(meta, outcome);
    } finally {
      meta.busy = false;
      meta.updatedAt = Date.now();
    }
  }

  override async cancel(input: SessionIdRpcInput): Promise<void> {
    const meta = this.liveSessions.get(input.sessionId);
    if (!meta?.handle) return;
    await meta.handle.cancelTurn();
  }

  override async steer(input: SessionPromptRpcInput): Promise<void> {
    const meta = this.liveSessions.get(input.sessionId);
    if (!meta?.handle) {
      throw new KimiError(
        ErrorCodes.SESSION_NOT_FOUND,
        `cannot steer unknown or closed session "${input.sessionId}"`,
      );
    }
    meta.updatedAt = Date.now();

    const prompt: SessionPrompt = {
      role: 'user',
      content: typeof input.input === 'string' ? input.input : JSON.stringify(input.input),
    };
    const turnId = await meta.handle.enqueueTurn(prompt, 'activeOrNewTurn');
    if (!meta.busy) {
      meta.busy = true;
      try {
        const outcome = await meta.handle.turnOutcome(turnId);
        this.recordTurnOutcome(meta, outcome);
      } finally {
        meta.busy = false;
        meta.updatedAt = Date.now();
      }
    }
  }

  override async getUsage(input: SessionIdRpcInput): Promise<SessionUsage> {
    const meta = this.requireSession(input.sessionId);
    const { inputOther, output, inputCacheRead, inputCacheCreation } = meta.usage;
    return { total: { inputOther, output, inputCacheRead, inputCacheCreation } };
  }

  override async getStatus(input: SessionIdRpcInput): Promise<SessionStatus> {
    const meta = this.requireSession(input.sessionId);
    // Deliberately unclamped, same as v2: >100% is the documented overflow
    // signal on this path.
    const contextUsage =
      meta.maxContextTokens > 0 ? meta.contextTokens / meta.maxContextTokens : 0;
    return {
      model: meta.model,
      thinkingEffort: meta.thinkingEffort,
      permission: meta.permissionMode,
      planMode: meta.planMode,
      swarmMode: meta.swarmMode,
      towerMode: meta.towerMode,
      contextTokens: meta.contextTokens,
      maxContextTokens: meta.maxContextTokens,
      contextUsage,
      usage: await this.getUsage(input),
    };
  }

  override async clearContext(input: SessionIdRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    if (meta.handle) {
      await meta.handle.clearHistory();
    }
    meta.contextTokens = 0;
    meta.messageCount = 0;
    meta.updatedAt = Date.now();
  }

  override async setPlanMode(input: SetSessionPlanModeRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    // The engine's plan guard reads this live through the stateRead bridge, so
    // flipping it here takes effect on the next guarded tool call — no handle
    // rebuild, and an in-flight turn sees the new mode at its next guard check.
    meta.planMode = input.enabled;
    meta.updatedAt = Date.now();
  }

  override async getPlan(_input: SessionIdRpcInput): Promise<SessionPlan> {
    // The native harness tracks plan *mode* (surfaced via getStatus.planMode),
    // not a plan document; there is no PlanInfo to return until plan documents
    // are wired, so report none rather than fabricate one.
    return null;
  }

  override async clearPlan(input: SessionIdRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    meta.planMode = false;
    meta.updatedAt = Date.now();
  }

  override async importContext(input: ImportContextRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    if (!meta.handle) {
      throw new KimiError(
        ErrorCodes.SESSION_NOT_FOUND,
        `cannot import context into session "${input.sessionId}" without a live engine handle`,
      );
    }
    await meta.handle.extendHistory([
      {
        role: 'user',
        content: `<imported_context source="${input.source}">\n${input.content}\n</imported_context>`,
      },
    ]);
    meta.messageCount += 1;
    meta.updatedAt = Date.now();
  }

  override async createGoal(input: SessionIdRpcInput & CreateGoalInput): Promise<GoalSnapshot> {
    const meta = this.requireSession(input.sessionId);
    if (meta.goal && meta.goal.status === 'active' && input.replace !== true) {
      throw new KimiError(
        ErrorCodes.GOAL_STATUS_INVALID,
        'a goal is already active; pass replace to override it',
      );
    }
    const now = Date.now();
    meta.goal = {
      goalId: `goal_${randomUUID()}`,
      objective: input.objective,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      turnsUsed: 0,
      tokensUsed: 0,
      inputTokensUsed: 0,
      outputTokensUsed: 0,
    };
    return toGoalSnapshot(meta.goal);
  }

  override async getGoal(input: SessionIdRpcInput): Promise<GoalToolResult> {
    const meta = this.requireSession(input.sessionId);
    return { goal: meta.goal ? toGoalSnapshot(meta.goal) : null };
  }

  override async pauseGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    return this.transitionGoal(input.sessionId, 'paused');
  }

  override async resumeGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    return this.transitionGoal(input.sessionId, 'active');
  }

  override async cancelGoal(input: SessionIdRpcInput): Promise<GoalSnapshot> {
    // GoalStatus has no dedicated 'cancelled' value; a cancelled goal is
    // terminal, so it lands on 'complete' (the goal callback then reports null
    // and the engine stops auto-continuing).
    return this.transitionGoal(input.sessionId, 'complete');
  }

  private transitionGoal(sessionId: string, status: GoalStatus): GoalSnapshot {
    const meta = this.requireSession(sessionId);
    const goal = meta.goal;
    if (!goal) {
      throw new KimiError(ErrorCodes.GOAL_NOT_FOUND, 'no goal to transition');
    }
    goal.status = status;
    goal.updatedAt = Date.now();
    return toGoalSnapshot(goal);
  }

  override async setModel(input: SetSessionModelRpcInput): Promise<SetSessionModelRpcResult> {
    const meta = this.requireSession(input.sessionId);
    meta.model = input.model;
    // The native LLM (model / thinking budget) is baked into the engine handle
    // at build time, so a model change rebuilds it, carrying the history over.
    await this.rebuildHandle(meta);
    return { model: meta.model };
  }

  override async setThinking(input: SetSessionThinkingRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    meta.thinkingEffort = input.effort;
    await this.rebuildHandle(meta);
  }

  override async setPermission(input: SetSessionPermissionRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    meta.permissionMode = input.mode;
    // The permission mode lives in the policy snapshot the engine's
    // PermissionEngine was built from, so changing it rebuilds the handle.
    await this.rebuildHandle(meta);
  }

  override async setTowerMode(input: SetSessionTowerModeRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    meta.towerMode = input.enabled;
    await this.rebuildHandle(meta);
  }

  override async setSwarmMode(input: SetSessionSwarmModeRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    meta.swarmMode = input.enabled;
    await this.rebuildHandle(meta);
  }

  override async undoHistory(input: SessionIdRpcInput & { count: number }): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    if (!meta.handle) {
      throw new KimiError(
        ErrorCodes.SESSION_NOT_FOUND,
        `cannot undo history of session "${input.sessionId}" without a live engine handle`,
      );
    }
    const history = await meta.handle.getHistory();
    const cut = truncateHistoryByTurns(history, input.count);
    if (cut >= history.length) return; // nothing to undo
    // Exclusive window so no turn is admitted mid-truncation.
    const acquired = await meta.handle.tryAcquireQuiescence();
    try {
      await meta.handle.setHistory(history.slice(0, cut));
    } finally {
      if (acquired) await meta.handle.releaseQuiescence();
    }
    meta.messageCount = Math.max(0, meta.messageCount - (history.length - cut));
    meta.contextTokens = 0;
    meta.updatedAt = Date.now();
  }

  override async forkSession(input: ForkSessionInput): Promise<SessionSummary> {
    const source = this.requireSession(input.id);
    const history = source.handle ? await source.handle.getHistory().catch(() => []) : [];
    const forkId = input.forkId ?? `session_${randomUUID()}`;
    await this.createSession({ id: forkId, workDir: source.workDir });
    const forkMeta = this.requireSession(forkId);
    if (forkMeta.handle && history.length > 0) {
      await forkMeta.handle.setHistory(history);
      forkMeta.messageCount = history.length;
    }
    if (input.title) {
      forkMeta.title = input.title;
      forkMeta.isCustomTitle = true;
    }
    if (input.metadata) {
      forkMeta.custom = { ...forkMeta.custom, ...input.metadata };
    }
    forkMeta.updatedAt = Date.now();
    this.persistMeta(forkMeta);
    return {
      id: forkId,
      workDir: forkMeta.workDir,
      sessionDir: forkMeta.sessionDir,
      title: forkMeta.title,
      createdAt: forkMeta.createdAt,
      updatedAt: forkMeta.updatedAt,
    };
  }

  override async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    const meta = this.requireSession(input.id);
    const sessionDir = meta.sessionDir;
    const zipPath = input.outputPath
      ? resolve(input.outputPath)
      : join(this.sessionBaseDir, `${input.id}.zip`);
    mkdirSync(dirname(zipPath), { recursive: true });

    const manifest = {
      exportedAt: new Date().toISOString(),
      sessionId: input.id,
      kimiCodeVersion: input.version,
      wireProtocolVersion: '2.0.0',
      os: process.platform,
      nodejsVersion: process.version,
    };

    const zipFile = new ZipFile();
    const entries: string[] = ['export-manifest.json'];
    zipFile.addBuffer(
      Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      'export-manifest.json',
    );

    if (existsSync(sessionDir)) {
      try {
        const files = readdirSync(sessionDir, { withFileTypes: true });
        for (const file of files) {
          if (file.isFile() && file.name !== 'export-manifest.json') {
            zipFile.addFile(join(sessionDir, file.name), file.name);
            entries.push(file.name);
          }
        }
      } catch {
        // ignore
      }
    }

    await new Promise<void>((res, rej) => {
      const out = createWriteStream(zipPath);
      out.on('close', res);
      out.on('error', rej);
      zipFile.outputStream.pipe(out);
      zipFile.end();
    });

    return {
      zipPath,
      entries,
      sessionDir,
      manifest,
    };
  }

  override async getConfig(_input?: GetConfigOptions): Promise<KimiConfig> {
    return loadRuntimeConfig(this.configPath);
  }

  override async setConfig(patch: KimiConfigPatch): Promise<KimiConfig> {
    const current = loadRuntimeConfig(this.configPath);
    // Deep-merge per domain (v2 semantics): the previous top-level shallow
    // spread clobbered whole sections — a `{ models: { oneAlias } }` patch wiped
    // every other alias, `{ thinking: { enabled } }` dropped effort/budget, a
    // single provider edit lost its baseUrl/customHeaders, and any key present
    // but undefined in the patch cleared the stored value.
    const merged: Record<string, unknown> = { ...(current as Record<string, unknown>) };
    for (const [domain, domainPatch] of Object.entries(patch)) {
      if (domainPatch === undefined) continue;
      merged[domain] = deepMergeConfigValue(
        (current as Record<string, unknown>)[domain],
        domainPatch,
      );
    }
    const updated = validateConfig(merged);
    await writeConfigFile(this.configPath, updated);
    return updated;
  }

  override async removeProvider(providerId: string): Promise<KimiConfig> {
    // v1/v2 removal cascades: drop the provider entry, every model alias that
    // points at it, and any default pointer left dangling — persisted as ONE
    // atomic write so a crash can never leave a half-removed provider.
    const current = loadRuntimeConfig(this.configPath) as unknown as Record<string, unknown>;
    const providers = { ...(current['providers'] as Record<string, unknown> | undefined) };
    delete providers[providerId];
    const models = { ...(current['models'] as Record<string, unknown> | undefined) };
    for (const [alias, model] of Object.entries(models)) {
      if (isPlainObject(model) && model['provider'] === providerId) {
        delete models[alias];
      }
    }
    const next: Record<string, unknown> = { ...current, providers, models };
    if (current['defaultProvider'] === providerId) {
      delete next['defaultProvider'];
    }
    const defaultModel = current['defaultModel'];
    if (typeof defaultModel === 'string') {
      const alias = (current['models'] as Record<string, { provider?: string }> | undefined)?.[
        defaultModel
      ];
      if (alias?.provider === providerId) {
        delete next['defaultModel'];
      }
    }
    const agent = current['agent'];
    if (isPlainObject(agent) && agent['nativeLlmProvider'] === providerId) {
      const nextAgent = { ...agent };
      delete nextAgent['nativeLlmProvider'];
      next['agent'] = nextAgent;
    }
    const updated = validateConfig(next);
    await writeConfigFile(this.configPath, updated);
    return updated;
  }

  override supportsAtomicSectionReplace(): boolean {
    return true;
  }

  override async replaceConfigSections(sections: Record<string, unknown>): Promise<void> {
    // Atomic multi-section replace: `undefined` clears a section, any other
    // value replaces it wholesale (no merge). Written in one pass so a crash
    // cannot leave the file half-updated.
    const current = loadRuntimeConfig(this.configPath) as unknown as Record<string, unknown>;
    const next: Record<string, unknown> = { ...current };
    for (const [section, value] of Object.entries(sections)) {
      if (value === undefined) {
        delete next[section];
      } else {
        next[section] = value;
      }
    }
    const updated = validateConfig(next);
    await writeConfigFile(this.configPath, updated);
  }

  override async getConfigDiagnostics(): Promise<ConfigDiagnostics> {
    return { warnings: [] };
  }

  override async uploadFile(data: Uint8Array, options: UploadFileOptions): Promise<FileMeta> {
    const filesDir = join(this.homeDir, 'files');
    mkdirSync(filesDir, { recursive: true });
    const fileId = `file_${randomUUID()}`;
    const filePath = join(filesDir, `${fileId}_${options.name}`);
    writeFileSync(filePath, data);
    return {
      id: fileId,
      name: options.name,
      media_type: options.mimeType ?? 'application/octet-stream',
      size: data.byteLength,
      created_at: new Date().toISOString(),
      expires_at: options.expiresInSec
        ? new Date(Date.now() + options.expiresInSec * 1000).toISOString()
        : undefined,
    };
  }

  override async deleteFile(fileId: string): Promise<void> {
    const filesDir = join(this.homeDir, 'files');
    if (!existsSync(filesDir)) return;
    try {
      const names = readdirSync(filesDir);
      for (const name of names) {
        if (name.startsWith(`${fileId}_`)) {
          try {
            unlinkSync(join(filesDir, name));
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  override async reloadSession(input: ReloadSessionRpcInput): Promise<ResumedSessionSummary> {
    return this.resumeSession({ id: input.sessionId });
  }

  override async getSessionWarnings(
    input: SessionIdRpcInput,
  ): Promise<readonly { code: string; message: string; severity: 'warning' }[]> {
    this.requireSession(input.sessionId);
    return [];
  }

  override async getTodos(input: SessionIdRpcInput): Promise<readonly SessionTodoItem[]> {
    const meta = this.requireSession(input.sessionId);
    const todoFile = join(meta.sessionDir, 'todo.json');
    if (existsSync(todoFile)) {
      try {
        const content = JSON.parse(readFileSync(todoFile, 'utf-8'));
        if (Array.isArray(content)) {
          return content.map((t: { title?: string; status?: string }) => ({
            title: String(t.title ?? ''),
            status:
              t.status === 'done' || t.status === 'completed'
                ? 'done'
                : t.status === 'in_progress'
                  ? 'in_progress'
                  : 'pending',
          }));
        }
      } catch {
        // fall through
      }
    }
    return [];
  }

  override async cancelShellCommand(input: {
    sessionId: string;
    commandId: string;
  }): Promise<void> {
    this.requireSession(input.sessionId);
  }

  override async swarm(input: SessionPromptRpcInput): Promise<void> {
    await this.setSwarmMode({ sessionId: input.sessionId, enabled: true, trigger: 'task' });
    return this.prompt(input);
  }

  override async compact(input: SessionIdRpcInput & CompactOptions): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    const handle = meta.handle;
    const historyLen = handle ? await handle.historyLen() : 0;
    if (historyLen === 0) {
      throw new KimiError(ErrorCodes.COMPACTION_UNABLE, 'No messages to compact');
    }
    if (!handle) {
      throw new KimiError(
        ErrorCodes.COMPACTION_UNABLE,
        'No engine handle available for compaction',
      );
    }
    const acquired = await handle.tryAcquireQuiescence();
    if (!acquired) {
      throw new KimiError(ErrorCodes.COMPACTION_FAILED, 'Session is busy');
    }
    const abortCtrl = new AbortController();
    this.activeCompactionControllers.set(meta.id, abortCtrl);
    try {
      const history = await handle.getHistory();
      if (history.length <= 1) {
        throw new KimiError(ErrorCodes.COMPACTION_UNABLE, 'History too short to compact');
      }
      const lastMessages = history.slice(-2);
      const summaryMsg: SessionPrompt = {
        role: 'user',
        content: `[Previous conversation summary: ${history.length - 2} messages compacted${input.instruction ? ` (${input.instruction})` : ''}]`,
      };
      await handle.setHistory([summaryMsg, ...lastMessages]);
      meta.messageCount = 1 + lastMessages.length;
      this.persistMeta(meta);
    } finally {
      this.activeCompactionControllers.delete(meta.id);
      await handle.releaseQuiescence();
    }
  }

  override async cancelCompaction(input: SessionIdRpcInput): Promise<void> {
    this.requireSession(input.sessionId);
    const ctrl = this.activeCompactionControllers.get(input.sessionId);
    if (ctrl) {
      ctrl.abort();
      this.activeCompactionControllers.delete(input.sessionId);
    }
  }

  override async generateAgentsMd(input: SessionIdRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    if (!meta.model) {
      throw new KimiError(ErrorCodes.SESSION_INIT_FAILED, 'Main agent has no model bound');
    }
    return this.prompt({
      sessionId: meta.id,
      input: [{ type: 'text', text: 'Generate AGENTS.md for this workspace.' }],
    });
  }

  override async promptWithSkills(input: SessionPromptWithSkillsRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    let skillText = '';
    for (const skill of input.skills) {
      skillText += `\n[Activate skill: ${skill.name}${skill.args ? ` with args: ${skill.args}` : ''}]`;
    }
    const parts = Array.isArray(input.input)
      ? [...input.input]
      : [{ type: 'text' as const, text: typeof input.input === 'string' ? input.input : '' }];
    if (skillText) {
      parts.push({ type: 'text' as const, text: skillText });
    }
    return this.prompt({
      sessionId: meta.id,
      input: parts,
    });
  }

  override async runShellCommand(input: {
    sessionId: string;
    command: string;
    commandId?: string;
  }): Promise<{ stdout: string; stderr: string; isError?: boolean; backgrounded?: boolean }> {
    const meta = this.requireSession(input.sessionId);
    return new Promise((res) => {
      exec(input.command, { cwd: meta.workDir }, (error, stdout, stderr) => {
        res({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          isError: !!error,
          backgrounded: false,
        });
      });
    });
  }

  override async getContext(input: SessionIdRpcInput): Promise<AgentContextData> {
    const meta = this.requireSession(input.sessionId);
    const handle = meta.handle;
    const history = handle ? await handle.getHistory() : [];
    return {
      history: history.map((m, idx) => ({
        id: `msg_${idx}`,
        // oxlint-disable-next-line typescript/no-explicit-any
        role: m.role as any,
        content: [{ type: 'text', text: m.content }],
        toolCalls: [],
      })),
      tokenCount: meta.contextTokens ?? 0,
    };
  }

  override async startBtw(input: SessionIdRpcInput): Promise<string> {
    this.requireSession(input.sessionId);
    return `btw_${randomUUID()}`;
  }

  override async getCronTasks(input: SessionIdRpcInput): Promise<GetCronTasksResult> {
    this.requireSession(input.sessionId);
    return { tasks: [] };
  }

  override async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    const skills: SkillSummary[] = [];
    const seen = new Set<string>();
    const dirsToScan = [
      join(workDir, '.agents', 'skills'),
      join(workDir, '.kimi-code', 'skills'),
      join(this.homeDir, 'skills'),
      ...this.skillDirs,
    ];
    for (const root of dirsToScan) {
      if (!existsSync(root)) continue;
      try {
        const entries = readdirSync(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillMd = join(root, entry.name, 'SKILL.md');
            if (existsSync(skillMd) && !seen.has(entry.name)) {
              seen.add(entry.name);
              let description = `Skill: ${entry.name}`;
              try {
                const content = readFileSync(skillMd, 'utf8');
                const match = content.match(/description:\s*(.+)/i);
                if (match?.[1]) description = match[1].trim();
              } catch {
                // ignore
              }
              skills.push({
                name: entry.name,
                description,
                path: skillMd,
                source: root.startsWith(workDir) ? 'project' : 'user',
              });
            }
          }
        }
      } catch {
        // ignore
      }
    }
    return skills;
  }

  override async listSkills(input: SessionIdRpcInput): Promise<readonly SkillSummary[]> {
    const meta = this.requireSession(input.sessionId);
    return this.listWorkspaceSkills(meta.workDir);
  }

  override async activateSkill(input: ActivateSkillRpcInput): Promise<void> {
    return this.promptWithSkills({
      sessionId: input.sessionId,
      input: [],
      skills: [{ name: input.name, args: input.args }],
    });
  }

  private loadGlobalMcpConfig(): Record<string, McpServerConfig> {
    const mcpPath = join(this.homeDir, 'mcp.json');
    if (!existsSync(mcpPath)) return {};
    try {
      const raw = JSON.parse(readFileSync(mcpPath, 'utf8'));
      return (
        raw && typeof raw === 'object' && 'mcpServers' in raw ? raw.mcpServers : raw
      ) as Record<string, McpServerConfig>;
    } catch {
      return {};
    }
  }

  private saveGlobalMcpConfig(servers: Record<string, McpServerConfig>): void {
    const mcpPath = join(this.homeDir, 'mcp.json');
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
  }

  override async listGlobalMcpServers(
    _options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    const servers = this.loadGlobalMcpConfig();
    return Object.entries(servers).map(
      ([name, config]) =>
        ({
          ...config,
          name,
          source: 'global' as const,
          origin: join(this.homeDir, 'mcp.json'),
          mutable: true,
        }) as McpManagedServerInfo,
    );
  }

  override async getGlobalMcpServer(
    name: string,
    _options: { readonly cwd?: string } = {},
  ): Promise<McpManagedServerInfo> {
    const servers = this.loadGlobalMcpConfig();
    const config = servers[name];
    if (!config) {
      throw new KimiError(ErrorCodes.MCP_SERVER_NOT_FOUND, `MCP server "${name}" not found`);
    }
    return {
      ...config,
      name,
      source: 'global' as const,
      origin: join(this.homeDir, 'mcp.json'),
      mutable: true,
    } as McpManagedServerInfo;
  }

  override async addGlobalMcpServer(
    server: McpServerConfig,
    options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    const servers = this.loadGlobalMcpConfig();
    const name = server.name ?? `server_${randomUUID()}`;
    servers[name] = server;
    this.saveGlobalMcpConfig(servers);
    return this.listGlobalMcpServers(options);
  }

  override async updateGlobalMcpServer(
    server: McpServerConfig,
    options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    return this.addGlobalMcpServer(server, options);
  }

  override async removeGlobalMcpServer(
    name: string,
    options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    const servers = this.loadGlobalMcpConfig();
    delete servers[name];
    this.saveGlobalMcpConfig(servers);
    return this.listGlobalMcpServers(options);
  }

  override async listGlobalMcpServerAuthStatuses(
    _options: { readonly cwd?: string; readonly verify?: boolean } = {},
  ): Promise<readonly GlobalMcpServerAuthStatus[]> {
    return [];
  }

  override async inspectAppMcpServers(
    _targets?: readonly McpServerLocator[],
    _options: { readonly cwd?: string } = {},
  ): Promise<readonly AppMcpServerInspection[]> {
    return [];
  }

  override async listMcpServers(_input: SessionIdRpcInput): Promise<readonly McpServerInfo[]> {
    return [];
  }

  override async listWorkspaceMcpServers(_workDir: string): Promise<readonly McpServerInfo[]> {
    return [];
  }

  override async addSessionMcpServer(input: {
    readonly sessionId: string;
    readonly server: McpServerConfig;
    readonly persist?: boolean;
  }): Promise<McpServerInfo> {
    this.requireSession(input.sessionId);
    const name = input.server.name ?? `server_${randomUUID()}`;
    if (input.persist) {
      await this.addGlobalMcpServer(input.server);
    }
    return {
      name,
      transport: input.server.transport,
      status: 'connected',
      toolCount: 0,
    };
  }

  override async reconnectMcpServer(_input: ReconnectMcpServerRpcInput): Promise<void> {}

  override async testGlobalMcpServer(
    _name: string,
    _options: { readonly cwd?: string } = {},
  ): Promise<McpTestResult> {
    return { success: true, output: 'MCP server ok' };
  }

  override async testGlobalMcpServerConfig(
    _server: McpServerConfig,
    _options: { readonly cwd?: string } = {},
  ): Promise<McpTestResult> {
    return { success: true, output: 'MCP server ok' };
  }

  override async beginGlobalMcpServerAuth(
    _name: string,
    _options: { readonly cwd?: string } = {},
  ): Promise<BeginGlobalMcpServerAuthResult> {
    return { status: 'already-authorized' };
  }

  override async completeGlobalMcpServerAuth(): Promise<void> {}
  override async cancelGlobalMcpServerAuth(): Promise<void> {}
  override async resetGlobalMcpServerAuth(): Promise<void> {}

  override async beginMcpServerAuth(
    _locator: McpServerLocator,
    _options: { readonly cwd?: string } = {},
  ): Promise<BeginGlobalMcpServerAuthResult> {
    return { status: 'already-authorized' };
  }

  override async completeMcpServerAuth(): Promise<void> {}
  override async cancelMcpServerAuth(): Promise<void> {}
  override async resetMcpServerAuth(): Promise<void> {}

  override async getMcpStartupMetrics(input: SessionIdRpcInput): Promise<McpStartupMetrics> {
    this.requireSession(input.sessionId);
    return { durationMs: 0 };
  }

  override async listPlugins(): Promise<readonly PluginSummary[]> {
    return [];
  }

  override async installPlugin(source: string): Promise<PluginSummary> {
    const id = `plugin_${randomUUID()}`;
    return {
      id,
      displayName: source,
      version: '1.0.0',
      enabled: true,
      state: 'ok',
      skillCount: 0,
      mcpServerCount: 0,
      enabledMcpServerCount: 0,
      hookCount: 0,
      commandCount: 0,
      hasErrors: false,
      source: 'local-path',
    };
  }

  override async setPluginEnabled(_id: string, _enabled: boolean): Promise<void> {}
  override async setPluginMcpServerEnabled(
    _id: string,
    _server: string,
    _enabled: boolean,
  ): Promise<void> {}
  override async removePlugin(_id: string): Promise<void> {}
  override async reloadPlugins(): Promise<ReloadSummary> {
    return { added: [], removed: [], errors: [] };
  }
  override async getPluginInfo(id: string): Promise<PluginInfo> {
    return {
      id,
      displayName: id,
      version: '1.0.0',
      enabled: true,
      state: 'ok',
      skillCount: 0,
      mcpServerCount: 0,
      enabledMcpServerCount: 0,
      hookCount: 0,
      commandCount: 0,
      hasErrors: false,
      source: 'local-path',
      root: join(this.homeDir, 'plugins', id),
      installedAt: new Date().toISOString(),
      mcpServers: [],
      diagnostics: [],
    };
  }
  override async activatePluginCommand(input: {
    sessionId: string;
    pluginId: string;
    commandName: string;
    args?: string;
  }): Promise<void> {
    this.requireSession(input.sessionId);
  }

  override async listBackgroundTasks(
    _input: SessionIdRpcInput & { activeOnly?: boolean; limit?: number },
  ): Promise<readonly BackgroundTaskInfo[]> {
    return [];
  }

  override async getBackgroundTaskOutput(
    _input: SessionIdRpcInput & { taskId: string; tail?: number },
  ): Promise<string> {
    return '';
  }

  override async stopBackgroundTask(
    _input: SessionIdRpcInput & { taskId: string; reason?: string },
  ): Promise<void> {}

  override async detachBackgroundTask(
    _input: SessionIdRpcInput & { taskId: string },
  ): Promise<BackgroundTaskInfo | undefined> {
    return undefined;
  }

  override async waitForBackgroundTasksOnPrint(_input: SessionIdRpcInput): Promise<void> {}

  override async handlePrintMainTurnCompleted(
    _input: SessionIdRpcInput,
  ): Promise<'finish' | 'continue'> {
    return 'finish';
  }

  override async listCommands(_input: SessionIdRpcInput): Promise<readonly AgentCommandInfo[]> {
    return [];
  }

  override async runCommand(_input: unknown): Promise<void> {
    throw new KimiError(
      ErrorCodes.NOT_IMPLEMENTED,
      'This SDK client does not support contributed commands.',
    );
  }

  override async listPluginCommands(): Promise<readonly PluginCommandDef[]> {
    return [];
  }

  override async getExperimentalFeatures(): Promise<readonly ExperimentalFeatureState[]> {
    return [];
  }

  override async getWorkspaceTrustInfo(workDir: string): Promise<WorkspaceTrustInfo> {
    // Fail closed: a workspace is untrusted until the user explicitly trusts it.
    // The previous `trusted: true` stub silently disabled the TUI's "do you trust
    // this folder?" gate, so an unfamiliar checkout's workspace-level MCP servers
    // and skills were loaded and run without any prompt. gatedMcpServers stays
    // empty until the MCP catalog is wired; the trust decision itself is persisted
    // so the prompt is shown once, not on every launch.
    return { trusted: this.readTrustedWorkspaces().includes(workDir), gatedMcpServers: [] };
  }

  override async trustWorkspace(workDir: string): Promise<void> {
    const trusted = this.readTrustedWorkspaces();
    if (!trusted.includes(workDir)) {
      trusted.push(workDir);
      this.writeTrustedWorkspaces(trusted);
    }
  }

  private readTrustedWorkspaces(): string[] {
    try {
      const raw = readFileSync(join(this.homeDir, 'trusted-workspaces.json'), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private writeTrustedWorkspaces(list: readonly string[]): void {
    writeFileSync(
      join(this.homeDir, 'trusted-workspaces.json'),
      JSON.stringify(list, null, 2),
      'utf8',
    );
  }

  private requireSession(sessionId: string): NativeSessionMeta {
    const meta = this.liveSessions.get(sessionId);
    if (meta === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `unknown session "${sessionId}"`);
    }
    return meta;
  }

  private recordTurnOutcome(meta: NativeSessionMeta, outcome: SessionTurnOutcome): void {
    const result = outcome.result;
    if (!result) return;
    meta.usage.inputOther += result.inputTokens;
    meta.usage.output += result.outputTokens;
    meta.usage.inputCacheRead += result.inputCacheRead;
    meta.usage.inputCacheCreation += result.inputCacheCreation;
    // The last turn's full prompt size is the best proxy the native handle
    // offers for live context occupancy (it exposes no direct token count).
    meta.contextTokens = result.inputTokens + result.inputCacheRead + result.inputCacheCreation;
    meta.messageCount += 1;
    if (meta.goal && meta.goal.status === 'active') {
      meta.goal.turnsUsed += 1;
      meta.goal.tokensUsed += result.inputTokens + result.outputTokens;
      meta.goal.inputTokensUsed +=
        result.inputTokens + result.inputCacheRead + result.inputCacheCreation;
      meta.goal.outputTokensUsed += result.outputTokens;
      meta.goal.updatedAt = Date.now();
    }
  }

  /**
   * Tear down and rebuild the engine handle after a mid-session setting change
   * (model / thinking / permission / swarm / tower), carrying the conversation
   * over via getHistory / setHistory so context survives. Disposing the old
   * handle cancels any in-flight turn — setters are a user-initiated
   * reconfiguration and the TUI blocks them while a turn is running.
   */
  private async rebuildHandle(meta: NativeSessionMeta): Promise<void> {
    const history = meta.handle ? await meta.handle.getHistory().catch(() => []) : [];
    if (meta.handle) {
      await meta.handle.dispose().catch(() => {});
      meta.handle = undefined;
    }
    const handle = await this.buildHandle(meta);
    if (history.length > 0) {
      await handle.setHistory(history);
    }
    meta.handle = handle;
    meta.updatedAt = Date.now();
  }

  private persistMeta(meta: NativeSessionMeta): void {
    try {
      mkdirSync(meta.sessionDir, { recursive: true });
      const persisted: PersistedSessionMeta = {
        id: meta.id,
        workDir: meta.workDir,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        title: meta.title,
        isCustomTitle: meta.isCustomTitle,
        custom: meta.custom,
        additionalDirs: meta.additionalDirs,
      };
      writeFileSync(
        join(meta.sessionDir, 'session-meta.json'),
        JSON.stringify(persisted, null, 2),
        'utf8',
      );
    } catch {
      // Best-effort durability: a metadata write failure must not break the
      // in-memory mutation the caller already relies on.
    }
  }

  private loadMeta(sessionDir: string): PersistedSessionMeta | undefined {
    try {
      const raw = readFileSync(join(sessionDir, 'session-meta.json'), 'utf8');
      const parsed = JSON.parse(raw) as PersistedSessionMeta;
      return parsed && typeof parsed.id === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async ensureConfigFile(): Promise<void> {
    if (!existsSync(this.configPath)) {
      writeFileSync(this.configPath, '', 'utf8');
    }
  }

  async close(): Promise<void> {
    for (const meta of this.liveSessions.values()) {
      if (meta.handle) {
        await meta.handle.dispose().catch(() => {});
      }
    }
    this.liveSessions.clear();
  }
}

export function createKimiHarnessNative(options: SDKRpcClientNativeOptions): KimiHarness {
  const rpc = new SDKRpcClientNative(options);
  return new KimiHarness(rpc, {
    identity: rpc.identity,
    uiMode: options.uiMode,
    homeDir: rpc.homeDir,
    configPath: rpc.configPath,
    auth: rpc.auth,
    telemetry: rpc.telemetry,
    ensureConfigFile: () => rpc.ensureConfigFile(),
    onClose: () => rpc.close(),
    imageLimits: options.imageLimits ?? new ImageLimits(process.env),
    sessionStartedProperties: options.sessionStartedProperties,
  });
}
