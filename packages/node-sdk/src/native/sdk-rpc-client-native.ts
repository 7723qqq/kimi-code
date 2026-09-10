import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { AgentContextData, JsonObject } from '#/types';
import {
  EngineSessionHandle,
  type SessionCallbacks,
  type SessionPrompt,
  type SessionTurnOutcome,
} from '@moonshot-ai/kimi-agent/session-handle';
import type { OAuthRefreshOutcome } from '@moonshot-ai/kimi-code-oauth';
import { assertKimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';
import { estimateTokensForMessages } from '@moonshot-ai/kosong/tokens';
import type { TurnEndReason } from '@moonshot-ai/protocol';
import { mcpOAuthStoreKey } from '@moonshot-ai/protocol';
import { ZipFile } from 'yazl';

import { KimiAuthFacade } from '#/auth';
import {
  cloneRecord,
  loadRuntimeConfig,
  loadRuntimeConfigLenient,
  readConfigFile,
  validateConfig,
  writeConfigFile,
  type KimiConfig,
  type KimiConfigPatch,
} from '#/config-local';
import { ensureConfigFile as ensureConfigFileScaffold } from '#/config-helpers';
import { resolveConfigPath, resolveKimiHome } from '#/config-local/path';
import type { QuestionItem, ToolInputDisplay } from '#/events';
import { ImageLimits } from '#/image-limits';
import { KimiHarness } from '#/kimi-harness';
import { ErrorCodes, KimiError } from '#/error-protocol';
import { flushDiagnosticLogs, getRootLogger, resolveLoggingConfig } from '#/logging';
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
  GenerateSessionTitleInput,
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
  PromptPart,
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
import type { ExperimentalFlagSource } from '#/types';

import {
  resolveNativeLlm,
  probeShellPath,
  buildPolicySnapshot,
  resolveSecondaryModelPool,
  resolveGithubCredentials,
  resolveSubagentTimeoutMs,
  resolveSwarmTimeoutMs,
  resolveMaxAttemptsPerStep,
  resolveWebSearchService,
  resolveWebFetchService,
  type JsNativeLlmConfig,
} from './native-llm-resolver';

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
function initialRuntimeState(config: KimiConfig, model: string | undefined) {
  return {
    model,
    thinkingEffort:
      config.thinking?.enabled === false ? 'off' : (config.thinking?.effort ?? 'medium'),
    permissionMode: (config.yolo === true
      ? 'yolo'
      : config.defaultPermissionMode === 'auto'
        ? 'auto'
        : 'manual') as PermissionMode,
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
  meta: { model: string | undefined; thinkingEffort: string },
): JsNativeLlmConfig {
  const out: JsNativeLlmConfig = { ...llm, model: meta.model ?? llm.model };
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
  // `[thinking] keep` is only injected while thinking is on (env-vars.md).
  out.thinkingKeep = thinkingOn ? llm.thinkingKeep : undefined;
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
 * The history cut that retains user turns 0..turnIndex: the (index+1)-th user
 * message from the start ends the retained window, so everything from it
 * onward is dropped.
 */
function retainThroughTurn(history: readonly SessionPrompt[], turnIndex: number): number {
  let seen = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i]?.role === 'user') {
      if (seen === turnIndex) return i + 1;
      seen += 1;
    }
  }
  return history.length;
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

/** The SDK normalizes returned paths to forward slashes (pathe semantics). */
function posixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

/** v1's `requiredWorkDir`: reject blank and normalize to the canonical spelling. */
function normalizeRequiredWorkDir(operation: string, workDir: unknown): string {
  if (typeof workDir !== 'string' || workDir.trim() === '') {
    throw new KimiError(ErrorCodes.REQUEST_WORK_DIR_REQUIRED, `${operation} requires workDir`);
  }
  return posixPath(resolve(workDir));
}

const MAX_TITLE_LENGTH = 200;
const MAX_LAST_PROMPT_LENGTH = 4000;

/**
 * The prompt-derived title/lastPrompt sanitizer, ported byte-identically from
 * the retired engine's `promptMetadataText` so prompt metadata redacts the
 * same credential shapes the engine used to.
 */
function promptMetadataTextFromText(text: string): string | undefined {
  const sanitized = text
    .replaceAll(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      '[redacted]',
    )
    .replaceAll(/\b(authorization)\s*:\s*bearer\s+\S+/gi, '$1: Bearer [redacted]')
    .replaceAll(
      /\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1=[redacted]',
    )
    .replaceAll(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replaceAll(/\b[A-Za-z0-9][A-Za-z0-9+/=_-]{39,}\b/g, '[redacted]')
    .replaceAll(/\p{Cc}+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

  if (sanitized.length === 0) return undefined;
  return sanitized.slice(0, MAX_LAST_PROMPT_LENGTH);
}

function promptMetadataTextFromPrompt(input: SessionPromptRpcInput['input']): string | undefined {
  const texts: string[] = [];
  for (const part of input) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'image_url') texts.push('[image]');
    else texts.push('[video]');
  }
  return promptMetadataTextFromText(texts.join('\n'));
}

function isUntitledTitle(title: string): boolean {
  return title.trim().length === 0 || title === 'New Session';
}

/** Byte-identical with the v1 import-context guidance text. */
const IMPORT_CONTEXT_GUIDANCE =
  'This is a prior conversation history that may be relevant to the current session. ' +
  'Please review this context and use it to inform your responses.';

/** Byte-identical with v1's `escapeXml` (& < > "). */
function escapeXml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Byte-identical with v1's `escapeXmlAttr` (& " only). */
function escapeXmlAttr(input: string): string {
  return input.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/**
 * The exact user message v1's importContext appended, including its
 * rejections: blank content (`import_content_empty`) and blank source
 * (`import_source_empty`) fail with v1's `request.invalid` shapes before any
 * token math runs.
 */
function buildImportContextParts(content: string, source: string): PromptPart[] {
  if (content.trim().length === 0) {
    throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Imported context cannot be empty', {
      details: { reason: 'import_content_empty' },
    });
  }
  const normalizedSource = source.trim();
  if (normalizedSource.length === 0) {
    throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Imported context source cannot be empty', {
      details: { reason: 'import_source_empty' },
    });
  }
  return [
    {
      type: 'text',
      text:
        `<system>The user has imported context from ${escapeXml(normalizedSource)}. ` +
        `${IMPORT_CONTEXT_GUIDANCE}</system>`,
    },
    {
      type: 'text',
      text:
        `<imported_context source="${escapeXmlAttr(normalizedSource)}">\n` +
        `${content}\n</imported_context>`,
    },
  ];
}

/** v1's overflow gate: the import estimate plus the current context must fit the model window. */
function assertImportFits(
  messageTokens: number,
  currentTokenCount: number,
  maxContextTokens: number,
): void {
  const totalTokenCount = currentTokenCount + messageTokens;
  if (maxContextTokens > 0 && totalTokenCount > maxContextTokens) {
    throw new KimiError(
      ErrorCodes.CONTEXT_OVERFLOW,
      'Imported content is too large for the current model context ' +
        `(~${String(messageTokens)} import tokens + ~${String(currentTokenCount)} existing ` +
        `= ~${String(totalTokenCount)} total > ${String(maxContextTokens)} token limit). ` +
        'Please import a smaller file or session.',
      {
        details: {
          reason: 'import_context_overflow',
          importTokenCount: messageTokens,
          currentTokenCount,
          totalTokenCount,
          maxContextTokens,
        },
      },
    );
  }
}

/**
 * The experimental flag registry the engine used to own. The native harness
 * serves the same metadata over `getExperimentalFeatures`; precedence per
 * flag is env > `[experimental]` config > master env > the flag's default.
 */
interface NativeExperimentalFlag {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly env: string;
  readonly defaultEnabled: boolean;
  readonly surface: string;
}

const NATIVE_EXPERIMENTAL_FLAGS: readonly NativeExperimentalFlag[] = [
  {
    id: 'tool_select',
    title: 'Tool select (progressive tool disclosure)',
    description:
      'Keep MCP tool schemas out of the immutable top-level tools[]; the model loads them on demand via the select_tools tool. Only takes effect on models whose capability catalog declares dynamically loaded tools.',
    env: 'KIMI_CODE_EXPERIMENTAL_TOOL_SELECT',
    defaultEnabled: true,
    surface: 'core',
  },
  {
    id: 'secondary-model',
    title: 'Secondary model for subagents',
    description:
      'Let newly spawned subagents use a separately configured secondary model by default, with an explicit primary-model override for quality-sensitive tasks.',
    env: 'KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL',
    defaultEnabled: true,
    surface: 'core',
  },
];

/**
 * Whether one experimental flag is enabled for this config — the registry's
 * precedence (env > `[experimental]` > master env > default). Engine-param
 * resolvers read this instead of duplicating the flag logic.
 */
export function isExperimentalFlagEnabled(config: KimiConfig, flagId: string): boolean {
  return (
    resolveExperimentalFeatures(config).find((flag) => flag.id === flagId)?.enabled === true
  );
}

function resolveExperimentalFeatures(config: KimiConfig): readonly ExperimentalFeatureState[] {
  const masterEnv = process.env['KIMI_CODE_EXPERIMENTAL_FLAG'];
  return NATIVE_EXPERIMENTAL_FLAGS.map((flag) => {
    const envValue = process.env[flag.env];
    const configValue = config.experimental?.[flag.id];
    let enabled = flag.defaultEnabled;
    let source: ExperimentalFlagSource = 'default';
    if (envValue !== undefined) {
      enabled = envValue !== '0' && envValue.toLowerCase() !== 'false';
      source = 'env';
    } else if (typeof configValue === 'boolean') {
      enabled = configValue;
      source = 'config';
    } else if (masterEnv !== undefined && masterEnv !== '0' && masterEnv.toLowerCase() !== 'false') {
      // A master switch of 0/false means "no force-enable"; flags keep their
      // own defaults rather than being disabled wholesale.
      enabled = true;
      source = 'master-env';
    }
    return {
      id: flag.id,
      title: flag.title,
      description: flag.description,
      env: flag.env,
      defaultEnabled: flag.defaultEnabled,
      enabled,
      source,
      surface: flag.surface,
      ...(configValue !== undefined ? { configValue } : {}),
    };
  });
}

/** A stored mcp.json entry as read from disk (the transport tag is optional). */
interface StoredMcpServerConfig {
  transport?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: 'oauth';
  bearerTokenEnvVar?: string;
  enabled?: boolean;
  name?: string;
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
  /** Prompt-derived easy title marker (v2 `titleKind: 'replaceable'`). */
  titleKind: 'default' | 'replaceable' | 'custom' | 'generated';
  lastPrompt: string | undefined;
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
  model: string | undefined;
  thinkingEffort: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  swarmMode: boolean;
  towerMode: boolean;
  maxContextTokens: number;
  contextTokens: number;
  usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number };
  goal: NativeGoalState | null;
  /** The active plan document handle (plan mode); content lives in the plan file. */
  plan: { id: string; content: string; path: string } | undefined;
  /** Source session id when this session was forked. */
  forkedFrom: string | undefined;
  activeAgentId?: string;
  handle?: EngineSessionHandle;
}

/**
 * The Rust `TaskRunner` entry wire (`storage/task_runner.rs:entry_wire`) —
 * snake_case-free already, the v2 task-domain shape.
 */
interface EngineTaskWireEntry {
  taskId: string;
  description: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  stopReason?: string;
  output?: string;
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
  lastPrompt?: string | undefined;
  custom: Record<string, unknown>;
  additionalDirs: string[];
  model?: string | undefined;
  thinkingEffort?: string | undefined;
  permissionMode?: PermissionMode | undefined;
  planMode?: boolean | undefined;
  plan?: { id: string; content: string; path: string } | undefined;
  goal?: NativeGoalState | null | undefined;
  forkedFrom?: string | undefined;
  contextTokens?: number | undefined;
}

const DEFAULT_INIT_PROMPT = `You are a software engineering expert with many years of programming experience. Please explore the current project directory to understand the project's architecture and main details.

Task requirements:
1. Analyze the project structure and identify key configuration files (such as pyproject.toml, package.json, Cargo.toml, etc.).
2. Understand the project's technology stack, build process and runtime architecture.
3. Identify how the code is organized and main module divisions.
4. Discover project-specific development conventions, testing strategies, and deployment processes.

After the exploration, do a thorough summary of your findings and write it to the \`AGENTS.md\` file in the project root, replacing the file's previous content. If the file already exists, read it first and carry forward whatever is still accurate — the result should be one coherent, up-to-date file, not an append.

For your information, \`AGENTS.md\` is a file intended to be read by AI coding agents. Expect the reader of this file to know nothing about the project.

You should compose this file according to the actual project content. Do not make any assumptions or generalizations. Ensure the information is accurate and useful. You must use the natural language that is mainly used in the project's comments and documentation.

Popular sections that people usually write in \`AGENTS.md\` are:

- Project overview
- Build and test commands
- Code style guidelines
- Testing instructions
- Security considerations`;

function resolveMcpServersForEngine(servers: Record<string, StoredMcpServerConfig>): Array<{
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}> {
  const result: Array<{
    name: string;
    transport: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }> = [];

  for (const [name, srv] of Object.entries(servers)) {
    if ((srv as { enabled?: boolean }).enabled === false) continue;
    if (srv.transport === 'stdio' && srv.command) {
      result.push({
        name,
        transport: 'stdio',
        command: srv.command,
        ...(srv.args ? { args: srv.args } : {}),
        ...(srv.env ? { env: srv.env } : {}),
      });
    } else if ((srv.transport === 'http' || srv.transport === 'sse') && srv.url) {
      result.push({
        name,
        transport: 'sse',
        url: srv.url,
        ...(srv.headers ? { headers: srv.headers } : {}),
      });
    }
  }
  return result;
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
  /** Sessions whose in-flight compaction was cancelled from the host. */
  private readonly compactionCancels = new Set<string>();

  constructor(options: SDKRpcClientNativeOptions = {}) {
    super();
    // The engine seeds its client identity / request headers from the host
    // identity, so a harness without one fails at construction like the v2
    // client did (the v1 client tolerated its absence).
    this.identity = assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({ homeDir: this.homeDir, configPath: options.configPath });
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
    this.sessionBaseDir = posixPath(join(this.homeDir, 'sessions'));
    if (!existsSync(this.sessionBaseDir)) {
      mkdirSync(this.sessionBaseDir, { recursive: true });
    }
    void getRootLogger().configure(
      resolveLoggingConfig({ homeDir: this.homeDir, env: process.env }),
    );
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
    const workDir = normalizeRequiredWorkDir('createSession', input.workDir);
    const sessionId = input.id ? input.id : `session_${randomUUID()}`;
    const sessionDir = posixPath(join(this.sessionBaseDir, sessionId));
    const now = Date.now();

    if (
      this.liveSessions.has(sessionId) ||
      this.loadMeta(join(this.sessionBaseDir, sessionId)) !== undefined
    ) {
      throw new KimiError(
        ErrorCodes.SESSION_ALREADY_EXISTS,
        `Session "${sessionId}" already exists`,
      );
    }

    const config = loadRuntimeConfigLenient(this.configPath);

    const meta: NativeSessionMeta = {
      id: sessionId,
      workDir,
      sessionDir,
      createdAt: now,
      updatedAt: now,
      title: 'New Session',
      isCustomTitle: false,
      titleKind: 'default',
      lastPrompt: undefined,
      busy: false,
      messageCount: 0,
      custom: input.metadata !== undefined ? { ...input.metadata } : {},
      additionalDirs: [],
      ...initialRuntimeState(config, input.model ?? config.defaultModel),
      plan: undefined,
      forkedFrom: undefined,
    };
    if (input.thinking !== undefined) meta.thinkingEffort = input.thinking;
    if (input.permission !== undefined) meta.permissionMode = input.permission;
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
      // v1 returns the caller's metadata verbatim on create (not the merged
      // custom map a later listing would report).
      metadata: input.metadata,
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
    const config = loadRuntimeConfigLenient(this.configPath);
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
        // Session turns run as `turn-<n>` (session/mod.rs); a foreground
        // subagent turn is `subturn-<rand>` (subagent/manager.rs run_one) and
        // belongs to the active side channel (btw), which the main session
        // event attribution must not claim.
        const eventAgentId =
          typeof parsed.turn_id === 'string' && parsed.turn_id.startsWith('subturn-')
            ? (meta.activeAgentId ?? 'main')
            : 'main';
        if (parsed.type === 'llm.delta') {
          if (parsed.part?.type === 'text' && typeof parsed.part.text === 'string') {
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'assistant.delta',
              turnId: meta.currentTurnId,
              delta: parsed.part.text,
            });
          } else if (
            (parsed.part?.type === 'think' || parsed.part?.type === 'thinking') &&
            typeof (parsed.part.think ?? parsed.part.thinking ?? parsed.part.text) === 'string'
          ) {
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'thinking.delta',
              turnId: meta.currentTurnId,
              delta: String(parsed.part.think ?? parsed.part.thinking ?? parsed.part.text),
            });
          }
        } else if (parsed.type === 'tool.native') {
          // One id for the started/result pair (M3): two independent
          // randomUUID() calls orphaned the result whenever the engine sent no
          // tool_call_id, leaving the TUI tool card stuck in "running".
          const toolCallId = String(parsed.tool_call_id ?? randomUUID());
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
            type: 'tool.call.started',
            turnId: meta.currentTurnId,
            toolCallId,
            name: String(parsed.tool_name ?? 'tool'),
            args: parsed.arguments ?? {},
          });
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
            type: 'tool.result',
            turnId: meta.currentTurnId,
            toolCallId,
            output: String(parsed.content ?? ''),
            isError: Boolean(parsed.is_error),
          });
        } else if (parsed.type === 'tool.native.progress') {
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
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
        const eventAgentId = meta.activeAgentId ?? 'main';
        if (parsed.type === 'turn.started') {
          meta.currentTurnId =
            typeof parsed.turn_id === 'number' ? parsed.turn_id : Number(parsed.turn_id) || 0;
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
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
            agentId: eventAgentId,
            type: 'turn.ended',
            turnId: meta.currentTurnId,
            reason: toTurnEndReason(parsed.reason ?? parsed.status),
          });
          meta.activeAgentId = undefined;
        }
        // Unknown turn events are dropped (see emitEvent).
      },
    };

    // The `[secondary_model]` pool rides the session params as JSON; a
    // malformed section throws here, so the session fails at startup naming
    // the offending alias.
    const secondaryModel = resolveSecondaryModelPool(
      config,
      isExperimentalFlagEnabled(config, 'secondary-model'),
    );
    const policySnapshot = buildPolicySnapshot(config, workDir);
    // The session's live permission / plan mode overrides the config-derived
    // snapshot default: setPermission / setPlanMode mutate meta, and a rebuild
    // (or the plan guard's stateRead) must reflect the current mode.
    policySnapshot.mode = meta.planMode ? 'plan' : meta.permissionMode;
    const githubCreds = resolveGithubCredentials(config);
    const mcpConfig = this.loadGlobalMcpConfig();
    const mcpServers = resolveMcpServersForEngine(mcpConfig);
    const subagentTimeoutMs = resolveSubagentTimeoutMs(config);
    const swarmTimeoutMs = resolveSwarmTimeoutMs(config);
    const maxAttempts = resolveMaxAttemptsPerStep(config);
    const webSearch = resolveWebSearchService(config);
    const webFetch = resolveWebFetchService(config);
    const authToken =
      nativeLlm?.authProvider === undefined
        ? undefined
        : (request: string) => {
            let parsed: { provider: string; force: boolean };
            try {
              parsed = JSON.parse(request) as { provider: string; force: boolean };
            } catch (error) {
              throw new KimiError(
                ErrorCodes.REQUEST_INVALID,
                `malformed auth token request from the engine: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            const tokenProvider = this.auth.resolveOAuthTokenProvider(parsed.provider);
            return tokenProvider.getAccessToken({ force: parsed.force === true });
          };

    const params = {
      turnId: sessionId,
      sessionId,
      callerAgentId: 'main',
      rustSelfContained: config.agent?.rustSelfContained === true,
      systemPrompt: 'You are Kimi Code, an intelligent AI coding assistant.',
      // The engine requires a modelName string even for a model-less session;
      // the SDK surface keeps `undefined` for the unbound state.
      modelName: nativeLlm?.model ?? meta.model ?? 'default',
      messages: [],
      tools: [],
      workspaceRoot: workDir,
      nativeTools: config.agent?.nativeTools !== false,
      shellPath,
      policySnapshotJson: JSON.stringify(policySnapshot),
      secondaryModelJson:
        secondaryModel === undefined ? undefined : JSON.stringify(secondaryModel),
      // Host-resolved config knobs (env > config, see native-llm-resolver).
      // `?? undefined` (never null): napi Option fields reject null.
      subagentTimeoutMs: subagentTimeoutMs ?? undefined,
      swarmTimeoutMs: swarmTimeoutMs ?? undefined,
      maxAttempts: maxAttempts ?? undefined,
      webSearch: webSearch ?? undefined,
      webFetch: webFetch ?? undefined,
      ...(githubCreds.githubToken ? { githubToken: githubCreds.githubToken } : {}),
      ...(githubCreds.githubBaseUrl ? { githubBaseUrl: githubCreds.githubBaseUrl } : {}),
      ...(nativeLlm ? { nativeLlm } : {}),
      ...(mcpServers.length > 0 ? { mcpServers } : {}),
    };

    return EngineSessionHandle.create(params, { ...callbacks, authToken });
  }

  override async resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    const sessionId = input.id;
    let meta = this.liveSessions.get(sessionId);
    if (meta === undefined) {
      const now = Date.now();
      const sessionDir = posixPath(join(this.sessionBaseDir, sessionId));
      // Rehydrate the session's own bookkeeping from disk so a rename / metadata
      // update / add-dir made earlier in this home survives the resume, then
      // rebuild the engine handle and replay the persisted history so turns
      // continue with their context.
      const persisted = this.loadMeta(sessionDir);
      const config = loadRuntimeConfigLenient(this.configPath);
      const defaults = initialRuntimeState(config, persisted?.model ?? config.defaultModel);
      const created: NativeSessionMeta = {
        id: sessionId,
        workDir: persisted?.workDir ?? normalizeRequiredWorkDir('resumeSession', process.cwd()),
        sessionDir,
        createdAt: persisted?.createdAt ?? now,
        updatedAt: persisted?.updatedAt ?? now,
        title: persisted?.title ?? 'Resumed Session',
        isCustomTitle: persisted?.isCustomTitle ?? false,
        titleKind: persisted?.isCustomTitle === true ? 'custom' : 'default',
        lastPrompt: persisted?.lastPrompt,
        busy: false,
        messageCount: 0,
        currentTurnId: 0,
        custom: persisted?.custom ?? {},
        additionalDirs: persisted?.additionalDirs ?? [],
        model: persisted?.model ?? config.defaultModel,
        thinkingEffort: persisted?.thinkingEffort ?? defaults.thinkingEffort,
        permissionMode: persisted?.permissionMode ?? defaults.permissionMode,
        planMode: persisted?.planMode ?? false,
        swarmMode: false,
        towerMode: false,
        maxContextTokens:
          (config.defaultModel ? config.models?.[config.defaultModel]?.maxContextSize : undefined) ??
          0,
        contextTokens: persisted?.contextTokens ?? 0,
        usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
        goal: persisted?.goal ?? null,
        plan: persisted?.plan,
        forkedFrom: persisted?.forkedFrom,
      };
      meta = created;
      this.liveSessions.set(sessionId, created);
      created.handle = await this.buildHandle(created);
      const history = this.readPersistedHistory(created);
      if (history.length > 0) {
        await created.handle.setHistory(history);
        created.messageCount = history.length;
      }
    }
    return this.resumedSessionSummary(meta);
  }

  /** The `ResumedSessionSummary` of a session, including the per-agent main snapshot. */
  private async resumedSessionSummary(meta: NativeSessionMeta): Promise<ResumedSessionSummary> {
    const history = meta.handle
      ? await meta.handle.getHistory().catch(() => [])
      : this.readPersistedHistory(meta);
    const context = this.contextFromHistory(meta, history);
    return {
      id: meta.id,
      workDir: meta.workDir,
      sessionDir: meta.sessionDir,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      metadata: { ...meta.custom } as JsonObject,
      additionalDirs: [...meta.additionalDirs],
      lastPrompt: meta.lastPrompt,
      sessionMetadata: {
        createdAt: new Date(meta.createdAt).toISOString(),
        updatedAt: new Date(meta.updatedAt).toISOString(),
        title: meta.title,
        isCustomTitle: meta.isCustomTitle,
        agents: {},
        custom: { ...meta.custom } as JsonObject,
      },
      agents: {
        main: {
          type: 'main',
          config: {
            cwd: meta.workDir,
            modelAlias: meta.model,
            modelCapabilities: {
              image_in: false,
              video_in: false,
              audio_in: false,
              thinking: false,
              tool_use: true,
              max_context_tokens: meta.maxContextTokens,
            },
            thinkingEffort: meta.thinkingEffort,
            systemPrompt: '',
          },
          context,
          replay: history.map((message, index) => ({
            type: 'message' as const,
            time: meta.createdAt + index,
            message: context.history[index]!,
          })),
          permission: { mode: meta.permissionMode },
          plan: meta.plan
            ? { id: meta.plan.id, content: meta.plan.content, path: meta.plan.path }
            : null,
          swarmMode: meta.swarmMode,
          usage: {
            inputOther: meta.usage.inputOther,
            output: meta.usage.output,
            inputCacheRead: meta.usage.inputCacheRead,
            inputCacheCreation: meta.usage.inputCacheCreation,
          },
          tools: [],
          background: [],
        },
      },
    };
  }

  override async renameSession(input: RenameSessionInput): Promise<void> {
    const title = input.title.trim();
    if (title.length === 0) {
      throw new KimiError(ErrorCodes.SESSION_TITLE_EMPTY, 'Session title cannot be empty');
    }
    const meta = this.liveSessions.get(input.id);
    if (meta !== undefined) {
      meta.title = title;
      meta.isCustomTitle = true;
      meta.titleKind = 'custom';
      meta.updatedAt = Date.now();
      this.persistMeta(meta);
      return;
    }
    // A closed session is renamed at the store level: load its persisted
    // bookkeeping, update the title, and write it back.
    const sessionDir = join(this.sessionBaseDir, input.id);
    const persisted = this.loadMeta(sessionDir);
    if (persisted === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `unknown session "${input.id}"`, {
        details: { sessionId: input.id },
      });
    }
    persisted.title = title;
    persisted.isCustomTitle = true;
    persisted.updatedAt = Date.now();
    this.writePersistedMeta(sessionDir, persisted);
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

  override async listSessions(
    input: ListSessionsOptions = {},
  ): Promise<readonly SessionSummary[]> {
    const workDir =
      input.workDir === undefined ? undefined : normalizeRequiredWorkDir('listSessions', input.workDir);
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
                sessionDir: posixPath(join(this.sessionBaseDir, meta.id)),
                title: meta.title,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
                lastPrompt: meta.lastPrompt,
                metadata: { ...meta.custom } as JsonObject,
                additionalDirs: [...meta.additionalDirs],
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
        lastPrompt: meta.lastPrompt,
        metadata: { ...meta.custom } as JsonObject,
        additionalDirs: [...meta.additionalDirs],
      });
    }
    const all = Array.from(sessionsMap.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1),
    );
    return all.filter((session) => {
      if (input.sessionId !== undefined && session.id !== input.sessionId) return false;
      if (workDir !== undefined && session.workDir !== workDir) return false;
      return true;
    });
  }

  override async listSessionsPage(
    input: ListSessionsOptions = {},
  ): Promise<SessionSummaryPage> {
    // Keyset pagination over the same ordering `listSessions` serves: `before`
    // is the last id of the previous page and the next page holds the entries
    // strictly older than it. An unknown cursor answers an empty terminal page.
    const items = await this.listSessions(input);
    const limit = input.limit;
    if (limit === undefined && input.before === undefined) {
      return { items };
    }
    const startIndex =
      input.before === undefined ? 0 : items.findIndex((item) => item.id === input.before) + 1;
    if (startIndex <= 0 && input.before !== undefined) {
      return { items: [] };
    }
    const window = limit === undefined ? items.slice(startIndex) : items.slice(startIndex, startIndex + limit);
    const exhausted = startIndex + window.length >= items.length;
    return {
      items: window,
      ...(exhausted || window.length === 0 ? {} : { nextCursor: window.at(-1)?.id }),
    };
  }

  override async deleteSession(input: SessionIdRpcInput): Promise<void> {
    const meta = this.liveSessions.get(input.sessionId);
    if (meta === undefined && this.loadMeta(join(this.sessionBaseDir, input.sessionId)) === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `unknown session "${input.sessionId}"`, {
        details: { sessionId: input.sessionId },
      });
    }
    if (meta?.handle) {
      await meta.handle.dispose().catch(() => {});
    }
    this.liveSessions.delete(input.sessionId);
    try {
      rmSync(join(this.sessionBaseDir, input.sessionId), { recursive: true, force: true });
    } catch {
      // best-effort: the live session is already gone
    }
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
    const meta = this.requireSession(input.sessionId);
    if (!meta.handle) {
      // Never silently drop user input: an unknown/closed session is an error,
      // not a no-op that resolves while the TUI shows nothing.
      throw new KimiError(
        ErrorCodes.SESSION_NOT_FOUND,
        `cannot prompt unknown or closed session "${input.sessionId}"`,
      );
    }
    const prompt = this.toSessionPrompt(input.input);
    const agentId = this.interactiveAgentId;
    meta.activeAgentId = agentId;
    // Side-channel (btw) turns run outside the session's turn queue on the
    // subagent instance, so the session-level busy flag and prompt metadata
    // stay untouched (v2 btw semantics).
    if (agentId !== 'main') {
      try {
        await this.runSideChannelTurn(meta, agentId, prompt.content);
      } finally {
        if (meta.activeAgentId === agentId) meta.activeAgentId = undefined;
      }
      return;
    }
    meta.busy = true;
    meta.updatedAt = Date.now();
    // v1/v2 updated the prompt-derived title/lastPrompt before the turn
    // launched; the turn itself fails asynchronously (a model-less turn
    // rejects the turn, not the submission). Subagents (like btw) leave the
    // session-level metadata alone.
    if (!input.skipPromptMetadata) {
      this.applyPromptMetadata(meta, promptMetadataTextFromPrompt(input.input));
    }
    try {
      const turnId = await meta.handle.enqueueTurn(prompt, 'newTurn');
      void meta.handle
        .turnOutcome(turnId)
        .then(
          (outcome) => this.settleTurn(meta, outcome),
          () => this.settleTurn(meta, undefined),
        );
    } catch (error) {
      meta.busy = false;
      throw error;
    }
  }

  /**
   * Run one btw side-channel turn on the engine's subagent instance and frame
   * it with turn.started / turn.ended events: the engine's foreground
   * subagent path emits only the streaming deltas (the session pump owns the
   * turn lifecycle events for queue turns), so the SDK supplies the framing
   * the btw panel consumes. Like the main path, a failed turn surfaces
   * through a `turn.ended` failure event instead of rejecting the submission.
   */
  private async runSideChannelTurn(
    meta: NativeSessionMeta,
    agentId: string,
    text: string,
  ): Promise<void> {
    if (!meta.handle) return;
    this.receiveEvent({
      sessionId: meta.id,
      agentId,
      turnId: meta.currentTurnId,
      type: 'turn.started',
      origin: { kind: 'user' },
      prompt: text,
    });
    let reason: TurnEndReason = 'completed';
    try {
      const outcome = await meta.handle.btwPrompt(agentId, text);
      // `EndTurn` / `Aborted` / `MaxTokens` (Rust Debug) → protocol reason.
      reason = toTurnEndReason(outcome.stopReason.replaceAll(/([a-z])([A-Z])/g, '$1_$2'));
    } catch {
      reason = 'failed';
    }
    this.receiveEvent({
      sessionId: meta.id,
      agentId,
      turnId: meta.currentTurnId,
      type: 'turn.ended',
      reason,
    });
  }

  override async cancel(input: SessionIdRpcInput): Promise<void> {
    const meta = this.liveSessions.get(input.sessionId);
    if (!meta?.handle) return;
    // The interactive-agent scope decides which turn the cancel targets: a
    // side-channel (btw) turn is not in the session's turn queue, so its
    // abort goes to the engine's registered parent-cancel for that agent.
    const agentId = this.interactiveAgentId;
    if (agentId !== 'main') {
      await meta.handle.btwCancel(agentId);
      return;
    }
    await meta.handle.cancelTurn();
  }

  override async steer(input: SessionPromptRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    if (!meta.handle) {
      throw new KimiError(
        ErrorCodes.SESSION_NOT_FOUND,
        `cannot steer unknown or closed session "${input.sessionId}"`,
      );
    }
    meta.updatedAt = Date.now();

    const prompt = this.toSessionPrompt(input.input);
    this.applyPromptMetadata(meta, promptMetadataTextFromPrompt(input.input));
    const turnId = await meta.handle.enqueueTurn(prompt, 'activeOrNewTurn');
    if (!meta.busy) {
      meta.busy = true;
      void meta.handle
        .turnOutcome(turnId)
        .then(
          (outcome) => this.settleTurn(meta, outcome),
          () => this.settleTurn(meta, undefined),
        );
    }
  }

  /**
   * Settle a submitted turn asynchronously: clear the busy flag, fold the
   * outcome into the usage counters, and persist the post-turn history. Turn
   * failures surface through the `turn.ended` event stream, not the
   * submission promise (v1/v2 semantics).
   */
  private settleTurn(meta: NativeSessionMeta, outcome: SessionTurnOutcome | undefined): void {
    meta.busy = false;
    meta.updatedAt = Date.now();
    if (outcome?.result) {
      this.recordTurnOutcome(meta, outcome);
    }
    void this.persistHistory(meta);
  }

  override async getUsage(input: SessionIdRpcInput): Promise<SessionUsage> {
    const meta = this.requireSession(input.sessionId);
    const { inputOther, output, inputCacheRead, inputCacheCreation } = meta.usage;
    // v2's usage view is empty until the first turn records tokens.
    if (inputOther === 0 && output === 0 && inputCacheRead === 0 && inputCacheCreation === 0) {
      return {};
    }
    return { total: { inputOther, output, inputCacheRead, inputCacheCreation } };
  }

  override async getStatus(input: SessionIdRpcInput): Promise<SessionStatus> {
    const meta = this.requireSession(input.sessionId);
    // Deliberately unclamped, same as v2: >100% is the documented overflow
    // signal on this path.
    const contextUsage = meta.maxContextTokens > 0 ? meta.contextTokens / meta.maxContextTokens : 0;
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
    this.persistMeta(meta);
    await this.persistHistory(meta);
  }

  override async setPlanMode(input: SetSessionPlanModeRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    // The engine's plan guard reads this live through the stateRead bridge, so
    // flipping it here takes effect on the next guarded tool call — no handle
    // rebuild, and an in-flight turn sees the new mode at its next guard check.
    const wasPlanMode = meta.planMode;
    meta.planMode = input.enabled;
    if (input.enabled && (!wasPlanMode || meta.plan === undefined)) {
      // Entering plan mode materializes a fresh plan document handle and
      // prepares the plans directory; the plan file itself is only written
      // when content is set (repeated toggles never leave plan files behind).
      const id = `plan_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const plansDir = join(meta.sessionDir, 'agents', 'main', 'plans');
      try {
        mkdirSync(plansDir, { recursive: true });
      } catch {
        // best-effort: the document handle still reports the prepared path
      }
      meta.plan = {
        id,
        content: '',
        path: posixPath(join(plansDir, `${id}.md`)),
      };
    }
    meta.updatedAt = Date.now();
    this.persistMeta(meta);
    this.emitStatusUpdated(meta);
  }

  override async getPlan(_input: SessionIdRpcInput): Promise<SessionPlan> {
    const meta = this.requireSession(_input.sessionId);
    if (meta.plan === undefined) return null;
    // The plan document's content lives in the plan file; read it so a
    // host-written plan (or a fork copy) reports its actual content.
    let content = meta.plan.content;
    try {
      content = readFileSync(meta.plan.path, 'utf-8');
    } catch {
      // no plan file yet — keep the in-memory content
    }
    return { id: meta.plan.id, content, path: meta.plan.path };
  }

  override async clearPlan(input: SessionIdRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    meta.planMode = false;
    // Clearing keeps the document handle but resets its content (v1's
    // `clearPlan` emptied the active plan file).
    if (meta.plan !== undefined) {
      meta.plan = { ...meta.plan, content: '' };
      try {
        mkdirSync(dirname(meta.plan.path), { recursive: true });
        writeFileSync(meta.plan.path, '', 'utf8');
      } catch {
        // best-effort: the document handle still reports empty content
      }
    }
    meta.updatedAt = Date.now();
    this.persistMeta(meta);
    this.emitStatusUpdated(meta);
  }

  override async importContext(input: ImportContextRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    if (!meta.handle) {
      throw new KimiError(
        ErrorCodes.SESSION_NOT_FOUND,
        `cannot import context into session "${input.sessionId}" without a live engine handle`,
      );
    }
    const parts = buildImportContextParts(input.content, input.source);
    // v1's overflow gate: the import estimate plus the current context must
    // fit the model window (unknown window = 0 skips the check).
    const importTokens = estimateTokensForMessages([
      { role: 'user', content: [...parts], toolCalls: [] },
    ]);
    assertImportFits(importTokens, meta.contextTokens, meta.maxContextTokens);
    await meta.handle.extendHistory([this.toSessionPromptFromParts(parts)]);
    // v1 adopted the post-import estimate as its reported token count.
    meta.contextTokens += importTokens;
    meta.messageCount += 1;
    meta.updatedAt = Date.now();
    this.persistMeta(meta);
    await this.persistHistory(meta);
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
    this.emitStatusUpdated(meta);
    return { model: meta.model };
  }

  override async setThinking(input: SetSessionThinkingRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    meta.thinkingEffort = input.effort;
    await this.rebuildHandle(meta);
    this.emitStatusUpdated(meta);
  }

  override async setPermission(input: SetSessionPermissionRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    meta.permissionMode = input.mode;
    // The permission mode lives in the policy snapshot the engine's
    // PermissionEngine was built from, so changing it rebuilds the handle.
    await this.rebuildHandle(meta);
    this.emitStatusUpdated(meta);
  }

  override async setTowerMode(input: SetSessionTowerModeRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    // The tower tools run engine-side natively (tools/tower), gated on the
    // `main` caller and the `.tower/` workspace state — not on this flag. The
    // flag records the coordinator mode for the host (steering semantics +
    // status display); the requested base is validated engine-side when the
    // agent runs TowerInit.
    meta.towerMode = input.enabled;
    meta.updatedAt = Date.now();
    this.emitStatusUpdated(meta);
  }

  override async setSwarmMode(input: SetSessionSwarmModeRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    meta.swarmMode = input.enabled;
    await this.rebuildHandle(meta);
    this.emitStatusUpdated(meta);
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
    this.persistMeta(meta);
    await this.persistHistory(meta);
  }

  override async forkSession(input: ForkSessionInput): Promise<SessionSummary> {
    const source = this.requireSession(input.id);
    if (source.busy) {
      throw new KimiError(
        ErrorCodes.SESSION_FORK_ACTIVE_TURN,
        `cannot fork session "${input.id}" while a turn is active`,
      );
    }
    const history = source.handle ? await source.handle.getHistory().catch(() => []) : [];
    if (input.turnIndex !== undefined) {
      // v1's fork rules: an index beyond the recorded user turns rejects with
      // request.invalid and leaves no fork behind.
      const availableTurns = history.filter((message) => message.role === 'user').length;
      if (input.turnIndex >= availableTurns) {
        throw new KimiError(ErrorCodes.REQUEST_INVALID, 'Fork turn index is out of range', {
          details: { turnIndex: input.turnIndex, availableTurns },
        });
      }
    }
    const forkId = input.forkId ?? `session_${randomUUID()}`;
    await this.createSession({ id: forkId, workDir: source.workDir });
    const forkMeta = this.requireSession(forkId);
    if (forkMeta.handle && history.length > 0) {
      const retained =
        input.turnIndex === undefined ? history : history.slice(0, retainThroughTurn(history, input.turnIndex));
      await forkMeta.handle.setHistory(retained);
      forkMeta.messageCount = retained.length;
    }
    if (input.title) {
      forkMeta.title = input.title;
      forkMeta.isCustomTitle = true;
      forkMeta.titleKind = 'custom';
    }
    const inheritedCustom = { ...source.custom };
    delete inheritedCustom['goal'];
    forkMeta.custom = { ...inheritedCustom, ...input.metadata };
    delete forkMeta.custom['goal'];
    // The fork inherits the source's runtime binding and plan document but
    // never its goal state (v1 dropped goal state at fork).
    forkMeta.model = source.model;
    forkMeta.thinkingEffort = source.thinkingEffort;
    forkMeta.permissionMode = source.permissionMode;
    forkMeta.planMode = source.planMode;
    if (source.plan !== undefined) {
      const forkPlanPath = posixPath(
        join(forkMeta.sessionDir, 'agents', 'main', 'plans', `${source.plan.id}.md`),
      );
      let content = source.plan.content;
      try {
        content = readFileSync(source.plan.path, 'utf-8');
      } catch {
        // no source plan file — carry the in-memory content
      }
      try {
        mkdirSync(dirname(forkPlanPath), { recursive: true });
        writeFileSync(forkPlanPath, content, 'utf8');
      } catch {
        // best-effort: the fork still reports the copied document
      }
      forkMeta.plan = { id: source.plan.id, content, path: forkPlanPath };
    }
    forkMeta.forkedFrom = source.id;
    forkMeta.updatedAt = Date.now();
    this.persistMeta(forkMeta);
    await this.persistHistory(forkMeta);
    return {
      id: forkId,
      workDir: forkMeta.workDir,
      sessionDir: forkMeta.sessionDir,
      title: forkMeta.title,
      createdAt: forkMeta.createdAt,
      updatedAt: forkMeta.updatedAt,
      metadata: input.metadata,
    };
  }

  override async exportSession(input: ExportSessionInput): Promise<ExportSessionResult> {
    const meta = this.requireSession(input.id);
    const sessionDir = meta.sessionDir;
    const zipPath = posixPath(
      input.outputPath ? resolve(input.outputPath) : join(this.sessionBaseDir, `${input.id}.zip`),
    );
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
      // Walk the session tree so nested artifacts (agents/, subagents/, …)
      // export under their relative posix paths like the engine's exporter.
      const walk = (dir: string, prefix: string): void => {
        let files;
        try {
          files = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const file of files) {
          const relative = prefix === '' ? file.name : `${prefix}/${file.name}`;
          if (file.isDirectory()) {
            walk(join(dir, file.name), relative);
          } else if (file.isFile() && relative !== 'export-manifest.json') {
            zipFile.addFile(join(dir, file.name), relative);
            entries.push(relative);
          }
        }
      };
      walk(sessionDir, '');
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
    // The runtime view is a lenient load: schema-invalid entries stay in the
    // document (validation defers to model resolution), so a broken alias
    // degrades the harness instead of blocking startup. `reload` re-reads the
    // file, which this loader already does on every call. Like v2, the
    // effective view has no v1-style `raw` passthrough — the raw document
    // lives in the file itself.
    const { raw: _raw, ...config } = loadRuntimeConfigLenient(this.configPath);
    void _raw;
    return config;
  }

  override async setConfig(patch: KimiConfigPatch): Promise<KimiConfig> {
    const current = readConfigFile(this.configPath);
    // Deep-merge per domain (v2 semantics): the previous top-level shallow
    // spread clobbered whole sections — a `{ models: { oneAlias } }` patch wiped
    // every other alias, `{ thinking: { enabled } }` dropped effort/budget, a
    // single provider edit lost its baseUrl/customHeaders, and any key present
    // but undefined in the patch cleared the stored value.
    const merged: Record<string, unknown> = {
      ...(current as Record<string, unknown>),
      raw: current.raw ? cloneRecord(current.raw) : undefined,
    };
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
    if (!handle) {
      throw new KimiError(
        ErrorCodes.COMPACTION_UNABLE,
        'No engine handle available for compaction',
      );
    }
    const historyLen = await handle.historyLen();
    if (historyLen === 0) {
      throw new KimiError(ErrorCodes.COMPACTION_UNABLE, 'No messages to compact');
    }
    if (historyLen <= 1) {
      throw new KimiError(ErrorCodes.COMPACTION_UNABLE, 'History too short to compact');
    }
    const acquired = await handle.tryAcquireQuiescence();
    if (!acquired) {
      throw new KimiError(ErrorCodes.COMPACTION_FAILED, 'Session is busy');
    }
    this.compactionCancels.delete(meta.id);
    this.receiveEvent({
      type: 'compaction.started',
      sessionId: meta.id,
      agentId: 'main',
      trigger: 'manual',
      instruction: input.instruction,
    });
    try {
      // Engine-side: the session's own model writes the summary of the deep
      // prefix (honoring `instruction`) and the smallest safe tail stays
      // verbatim — no host-side placeholder message.
      const report = await handle.compact(input.instruction);
      if (!report.changed) {
        throw new KimiError(ErrorCodes.COMPACTION_UNABLE, 'History too short to compact');
      }
      meta.messageCount = report.messageCount;
      this.persistMeta(meta);
      await this.persistHistory(meta);
      this.receiveEvent({
        type: 'compaction.completed',
        sessionId: meta.id,
        agentId: 'main',
        result: {
          summary: report.summary ?? '',
          compactedCount: report.compactedCount ?? 0,
          tokensBefore: report.tokensBefore,
          tokensAfter: report.tokensAfter,
        },
      });
    } catch (error) {
      // The transcript's compaction block only closes on a terminal event, so
      // every failure after `started` must emit one — a user-triggered cancel
      // resolves silently, any other failure still throws with the real reason.
      const cancelled = this.compactionCancels.delete(meta.id);
      this.receiveEvent({
        type: 'compaction.cancelled',
        sessionId: meta.id,
        agentId: 'main',
      });
      if (cancelled) return;
      if (error instanceof KimiError) throw error;
      throw new KimiError(
        ErrorCodes.COMPACTION_FAILED,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await handle.releaseQuiescence();
    }
  }

  override async cancelCompaction(input: SessionIdRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    // True only when the engine had a compaction in flight; remembering it
    // lets `compact` translate the engine's cancellation error into a
    // `compaction.cancelled` event instead of a failure.
    if ((await meta.handle?.cancelCompaction()) === true) {
      this.compactionCancels.add(meta.id);
    }
  }

  override async generateAgentsMd(input: SessionIdRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    if (!meta.model) {
      throw new KimiError(ErrorCodes.SESSION_INIT_FAILED, 'Main agent has no model bound');
    }
    if (!meta.handle) {
      throw new KimiError(ErrorCodes.SESSION_INIT_FAILED, 'Main agent has no live engine handle');
    }
    // The /init run is a session-level operation pinned to the main agent: it
    // launches its own turn (a subagent system trigger on the engine), does
    // not touch the prompt-derived metadata, and awaits the run so a failed
    // launch surfaces as session.init_failed.
    const turnId = await meta.handle.enqueueTurn(
      { role: 'user', content: DEFAULT_INIT_PROMPT },
      'newTurn',
    );
    try {
      await meta.handle.turnOutcome(turnId);
    } catch (error) {
      throw new KimiError(ErrorCodes.SESSION_INIT_FAILED, 'Session init failed', {
        cause: error,
      });
    } finally {
      meta.busy = false;
      await this.persistHistory(meta);
    }
  }

  override async promptWithSkills(input: SessionPromptWithSkillsRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    const parts = [...input.input];
    for (const skill of input.skills) {
      const rendered = this.renderSkillPrompt(meta, skill.name, skill.args);
      if (rendered === undefined) continue;
      parts.push({ type: 'text', text: rendered });
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
    try {
      const { nativeBashSpawn, nativeBashWait } = await import('@moonshot-ai/kimi-agent/native');
      const shell = probeShellPath() ?? 'bash';
      let stdout = '';
      let stderr = '';
      const { id } = nativeBashSpawn(
        {
          argv: [shell, '-c', input.command],
          cwd: meta.workDir,
        },
        (_err, ev) => {
          if (!ev) return;
          if (ev.kind === 'stdout' && ev.data) stdout += ev.data;
          if (ev.kind === 'stderr' && ev.data) stderr += ev.data;
        },
      );
      const exit = await nativeBashWait(id);
      return {
        stdout,
        stderr,
        isError: exit.exitCode !== 0 || Boolean(exit.error),
        backgrounded: false,
      };
    } catch {
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
  }

  override async getContext(input: SessionIdRpcInput): Promise<AgentContextData> {
    const meta = this.requireSession(input.sessionId);
    const history = meta.handle ? await meta.handle.getHistory() : [];
    return this.contextFromHistory(meta, history);
  }

  override async startBtw(input: SessionIdRpcInput): Promise<string> {
    const meta = this.requireSession(input.sessionId);
    if (!meta.handle) {
      throw new KimiError(
        ErrorCodes.SESSION_NOT_FOUND,
        `cannot start a btw side channel on unknown or closed session "${input.sessionId}"`,
      );
    }
    return meta.handle.startBtw();
  }

  /**
   * Deterministic title derivation over the live engine history (v2
   * `ISessionTitleService`): the engine applies the first_turn / user_prompts
   * rule to the session's cross-turn history. A generated title lands as
   * `titleKind: 'generated'`; without `force` an existing generated or
   * host-custom title is returned as-is. `source=digest` needs the managed
   * chat_title channel and rejects engine-side.
   */
  override async generateSessionTitle(
    input: GenerateSessionTitleInput,
  ): Promise<string | undefined> {
    const meta = this.requireSession(input.id);
    if (!meta.handle) {
      throw new KimiError(
        ErrorCodes.SESSION_NOT_FOUND,
        `cannot generate a title for unknown or closed session "${input.id}"`,
      );
    }
    // `digest` needs the managed chat_title channel and rejects engine-side;
    // fail fast with a named error instead of a native round-trip.
    if (
      input.source !== undefined &&
      input.source !== 'first_turn' &&
      input.source !== 'user_prompts'
    ) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `unsupported title source "${input.source}": expected 'first_turn' or 'user_prompts'`,
      );
    }
    if (!input.force && (meta.titleKind === 'generated' || meta.titleKind === 'custom')) {
      return meta.title;
    }
    const title = await meta.handle.generateTitle(input.source);
    if (title === null) return undefined;
    meta.title = title;
    meta.titleKind = 'generated';
    meta.isCustomTitle = false;
    meta.updatedAt = Date.now();
    this.persistMeta(meta);
    return title;
  }

  override async getCronTasks(input: SessionIdRpcInput): Promise<GetCronTasksResult> {
    this.requireSession(input.sessionId);
    return { tasks: [] };
  }

  override async listWorkspaceSkills(workDir: string): Promise<readonly SkillSummary[]> {
    const root = normalizeRequiredWorkDir('listWorkspaceSkills', workDir);
    const skills: SkillSummary[] = [];
    const seen = new Set<string>();
    const dirsToScan = [
      join(root, '.agents', 'skills'),
      join(root, '.kimi-code', 'skills'),
      join(this.homeDir, 'skills'),
      ...this.skillDirs,
    ];
    for (const dir of dirsToScan) {
      const scanRoot = posixPath(dir);
      if (!existsSync(scanRoot)) continue;
      try {
        const entries = readdirSync(scanRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillMd = posixPath(join(scanRoot, entry.name, 'SKILL.md'));
            if (existsSync(skillMd) && !seen.has(entry.name)) {
              seen.add(entry.name);
              skills.push({
                name: entry.name,
                ...this.readSkillSummary(skillMd),
                path: skillMd,
                source: scanRoot.startsWith(root) ? 'project' : 'user',
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

  /** The frontmatter-derived skill summary fields (description, invocation gate). */
  private readSkillSummary(skillMd: string): { description: string; disableModelInvocation?: boolean } {
    try {
      const content = readFileSync(skillMd, 'utf8');
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
      const meta = frontmatter?.[1] ?? '';
      const descriptionMatch = meta.match(/description:\s*(.+)/i);
      const disableMatch = meta.match(/disable_model_invocation:\s*(.+)/i);
      const disableModelInvocation =
        disableMatch?.[1] !== undefined ? disableMatch[1].trim() === 'true' : undefined;
      return {
        description:
          descriptionMatch?.[1]?.trim() || `Skill: ${posixPath(skillMd).split('/').at(-2)}`,
        ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
      };
    } catch {
      return { description: 'Skill: ' + posixPath(skillMd).split('/').at(-2) };
    }
  }

  override async listSkills(input: SessionIdRpcInput): Promise<readonly SkillSummary[]> {
    const meta = this.requireSession(input.sessionId);
    return this.listWorkspaceSkills(meta.workDir);
  }

  override async activateSkill(input: ActivateSkillRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    const name = input.name.trim();
    if (name.length === 0) {
      throw new KimiError(ErrorCodes.SKILL_NAME_EMPTY, 'Skill name cannot be empty');
    }
    const args = input.args?.trim();
    const rendered = this.renderSkillPrompt(meta, name, args);
    if (rendered === undefined) {
      throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${name}" was not found`);
    }
    const skillDir = posixPath(join(meta.workDir, '.kimi-code', 'skills', name));
    const skillSource = existsSync(skillDir) ? 'project' : 'user';
    // v1/v2 published the activation event before the turn launched, so the
    // event stream orders it ahead of turn.started.
    this.receiveEvent({
      sessionId: meta.id,
      agentId: 'main',
      type: 'skill.activated',
      activationId: `skill_${randomUUID()}`,
      skillName: name,
      ...(args !== undefined && args.length > 0 ? { skillArgs: args } : {}),
      trigger: 'user-slash',
      skillSource,
    });
    // The activation updates the prompt-derived metadata like a prompt whose
    // text is the slash command itself.
    this.applyPromptMetadata(meta, promptMetadataTextFromText(`/${name}${args ? ` ${args}` : ''}`));
    return this.prompt({
      sessionId: meta.id,
      input: [{ type: 'text', text: rendered }],
      skipPromptMetadata: true,
    });
  }

  /**
   * Render the skill-activation prompt the engine served for a user-slash
   * activation: the instruction line plus the byte-identical `<skill-loaded>`
   * wrapper over the skill body, with the ARGUMENTS trailer when args exist.
   */
  private renderSkillPrompt(
    meta: NativeSessionMeta,
    name: string,
    args: string | undefined,
  ): string | undefined {
    const skillDir = join(meta.workDir, '.kimi-code', 'skills', name);
    const skillMd = join(skillDir, 'SKILL.md');
    if (!existsSync(skillMd)) return undefined;
    let body: string;
    try {
      const raw = readFileSync(skillMd, 'utf8');
      // Strip the frontmatter: the model sees the body, the host the metadata.
      const withoutFrontmatter = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
      body = withoutFrontmatter.trimEnd();
    } catch {
      return undefined;
    }
    const trimmedArgs = args?.trim();
    const lines = [
      `User activated the skill "${name}". Follow the loaded skill instructions.`,
      '',
      `<skill-loaded name="${name}" trigger="user-slash" source="project" dir="${posixPath(skillDir)}"${trimmedArgs ? ` args="${trimmedArgs}"` : ''}>`,
      body,
      '',
      ...(trimmedArgs ? ['ARGUMENTS: ' + trimmedArgs] : []),
      '</skill-loaded>',
    ];
    return lines.join('\n');
  }

  /** Tolerant read for the engine pipeline: a malformed file contributes no servers. */
  private loadGlobalMcpConfig(): Record<string, StoredMcpServerConfig> {
    const mcpPath = join(this.homeDir, 'mcp.json');
    if (!existsSync(mcpPath)) return {};
    try {
      const raw = JSON.parse(readFileSync(mcpPath, 'utf8'));
      return (
        raw && typeof raw === 'object' && 'mcpServers' in raw ? raw.mcpServers : raw
      ) as Record<string, StoredMcpServerConfig>;
    } catch {
      return {};
    }
  }

  /**
   * Strict read for the CRUD paths: a malformed mcp.json must reject the
   * mutation instead of being silently overwritten (the file's bytes stay
   * untouched so the user can fix it).
   */
  private readGlobalMcpDocument(): { mcpServers: Record<string, StoredMcpServerConfig> } & Record<
    string,
    unknown
  > {
    const mcpPath = join(this.homeDir, 'mcp.json');
    if (!existsSync(mcpPath)) return { mcpServers: {} };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(mcpPath, 'utf8'));
    } catch (error) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Invalid mcp.json in ${this.homeDir}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!isPlainObject(raw)) {
      throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid mcp.json in ${this.homeDir}`);
    }
    const servers = raw['mcpServers'];
    return {
      ...raw,
      mcpServers: isPlainObject(servers) ? (servers as Record<string, StoredMcpServerConfig>) : {},
    };
  }

  private saveGlobalMcpDocument(
    document: { mcpServers: Record<string, StoredMcpServerConfig> } & Record<string, unknown>,
  ): void {
    const mcpPath = join(this.homeDir, 'mcp.json');
    writeFileSync(mcpPath, JSON.stringify(document, null, 2), 'utf8');
  }

  /** Flatten one stored entry into the managed view (transport derived). */
  private toManagedServerInfo(name: string, config: StoredMcpServerConfig): McpManagedServerInfo {
    const transport = config.transport ?? (config.command !== undefined ? 'stdio' : 'http');
    return {
      ...config,
      transport,
      name,
      source: 'global' as const,
      origin: posixPath(join(this.homeDir, 'mcp.json')),
      mutable: true,
    } as McpManagedServerInfo;
  }

  override async listGlobalMcpServers(
    _options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    const servers = this.loadGlobalMcpConfig();
    return Object.entries(servers).map(([name, config]) => this.toManagedServerInfo(name, config));
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
    return this.toManagedServerInfo(name, config);
  }

  override async addGlobalMcpServer(
    server: McpServerConfig,
    options: { readonly cwd?: string } = {},
  ): Promise<readonly McpManagedServerInfo[]> {
    const document = this.readGlobalMcpDocument();
    const name = server.name ?? `server_${randomUUID()}`;
    // The name is the entry key; the stored config never repeats it.
    const { name: _stripped, ...stored } = server as McpServerConfig & { name?: string };
    void _stripped;
    document.mcpServers[name] = stored;
    this.saveGlobalMcpDocument(document);
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
    const document = this.readGlobalMcpDocument();
    delete document.mcpServers[name];
    this.saveGlobalMcpDocument(document);
    return this.listGlobalMcpServers(options);
  }

  override async listGlobalMcpServerAuthStatuses(
    options: { readonly cwd?: string; readonly verify?: boolean } = {},
  ): Promise<readonly GlobalMcpServerAuthStatus[]> {
    const servers = this.loadGlobalMcpConfig();
    const statuses: GlobalMcpServerAuthStatus[] = [];
    for (const [name, config] of Object.entries(servers)) {
      statuses.push({
        name,
        authStatus: await this.resolveMcpServerAuthStatus(name, config, options.verify),
      });
    }
    return statuses;
  }

  /**
   * The engine's auth-posture classification for one user-global server:
   * stdio/bearer/header entries are statically classified, OAuth-candidate
   * entries consult the stored token state and (when verifying) probe the
   * endpoint with a real connection.
   */
  private async resolveMcpServerAuthStatus(
    name: string,
    server: StoredMcpServerConfig,
    verify: boolean | undefined,
  ): Promise<GlobalMcpServerAuthStatus['authStatus']> {
    if (server.enabled === false) return 'not-applicable';
    if (server.transport === 'stdio' || (server.transport === undefined && server.command)) {
      return 'not-applicable';
    }
    if (server.bearerTokenEnvVar !== undefined) return 'bearer-token';
    if (server.headers !== undefined && server.auth !== 'oauth') return 'not-applicable';
    if (server.transport !== 'http' && server.auth !== 'oauth') return 'not-applicable';
    const tokens = this.readMcpOAuthTokens(name, server.url ?? '');
    const offline = (): GlobalMcpServerAuthStatus['authStatus'] => {
      if (tokens.hasTokens) {
        return !tokens.expired || tokens.hasRefreshToken
          ? 'oauth-authorized'
          : 'oauth-expired';
      }
      return server.auth === 'oauth' ? 'oauth-required' : 'not-applicable';
    };
    if (verify !== true) {
      if (verify === false || tokens.hasTokens || server.auth === 'oauth') return offline();
    }
    const probe = await this.probeRemoteMcpServer(server, tokens.accessToken ?? undefined);
    if (probe.status === 'connected') {
      return tokens.hasTokens ? 'oauth-authorized' : 'not-applicable';
    }
    if (probe.status === 'needs-auth') {
      return tokens.hasTokens ? 'oauth-expired' : 'oauth-required';
    }
    return offline();
  }

  /** The stored MCP OAuth token state for one server (`<home>/credentials/mcp`). */
  private readMcpOAuthTokens(
    name: string,
    url: string,
  ): {
    hasTokens: boolean;
    expired: boolean;
    hasRefreshToken: boolean;
    accessToken: string | undefined;
  } {
    try {
      const key = mcpOAuthStoreKey(name, url);
      const raw = readFileSync(
        join(this.homeDir, 'credentials', 'mcp', `${key}-tokens.json`),
        'utf8',
      );
      const parsed = JSON.parse(raw) as {
        access_token?: string;
        refresh_token?: string;
        expires_at?: string;
      };
      const hasTokens = typeof parsed.access_token === 'string' && parsed.access_token.length > 0;
      const expiresAt = parsed.expires_at !== undefined ? Date.parse(parsed.expires_at) : NaN;
      return {
        hasTokens,
        expired: Number.isFinite(expiresAt) && expiresAt <= Date.now(),
        hasRefreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0,
        accessToken: hasTokens ? parsed.access_token : undefined,
      };
    } catch {
      return { hasTokens: false, expired: false, hasRefreshToken: false, accessToken: undefined };
    }
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
    name: string,
    _options: { readonly cwd?: string } = {},
  ): Promise<McpTestResult> {
    const servers = this.loadGlobalMcpConfig();
    const config = servers[name];
    if (!config) {
      throw new KimiError(ErrorCodes.MCP_SERVER_NOT_FOUND, `MCP server "${name}" not found`);
    }
    return this.testGlobalMcpServerConfig(config as McpServerConfig);
  }

  override async testGlobalMcpServerConfig(
    server: McpServerConfig,
    _options: { readonly cwd?: string } = {},
  ): Promise<McpTestResult> {
    const stored = server as StoredMcpServerConfig;
    if (stored.transport === 'http' || stored.transport === 'sse') {
      return this.probeRemoteMcpServer(stored);
    }
    return this.probeStdioMcpServer(stored);
  }

  /** Connect to a stdio MCP server and list its tools (the standalone check). */
  private async probeStdioMcpServer(server: StoredMcpServerConfig): Promise<McpTestResult> {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: server.command ?? '',
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    });
    const client = new Client({ name: 'kimi-code-mcp-check', version: '0.0.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const lines = [
        'Connected to MCP server.',
        `Available tools: ${String(tools.tools.length)}`,
        ...tools.tools.map((tool) => `- ${tool.name}${tool.description ? `: ${tool.description}` : ''}`),
      ];
      return { success: true, output: lines.join('\n') };
    } catch (error) {
      return {
        success: false,
        output: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /**
   * Probe a remote MCP endpoint far enough to classify its auth posture: a
   * 200 initialize answer connects, a 401 challenge means needs-auth, and
   * anything else is an unreachable server.
   */
  private async probeRemoteMcpServer(
    server: StoredMcpServerConfig,
    bearerToken?: string,
  ): Promise<McpTestResult & { status: 'connected' | 'needs-auth' | 'unreachable' }> {
    const url = server.url ?? '';
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(bearerToken !== undefined ? { authorization: `Bearer ${bearerToken}` } : {}),
          ...server.headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'kimi-code-mcp-check', version: '0.0.0' },
          },
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 401 || response.status === 403) {
        return { success: false, output: 'authorization required', status: 'needs-auth' };
      }
      if (!response.ok) {
        return {
          success: false,
          output: `MCP server responded with HTTP ${String(response.status)}`,
          status: 'unreachable',
        };
      }
      return { success: true, output: 'Connected to MCP server.', status: 'connected' };
    } catch (error) {
      return {
        success: false,
        output: error instanceof Error ? error.message : String(error),
        status: 'unreachable',
      };
    }
  }

  override async beginGlobalMcpServerAuth(
    name: string,
    _options: { readonly cwd?: string } = {},
  ): Promise<BeginGlobalMcpServerAuthResult> {
    const servers = this.loadGlobalMcpConfig();
    const config = servers[name];
    if (
      config &&
      (config.transport === 'stdio' || (config.transport === undefined && config.command))
    ) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `MCP server "${name}" uses stdio transport and does not support OAuth authorization`,
      );
    }
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
      name: source,
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
      name: id,
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

  /**
   * The engine pipeline's task runner (Rust `TaskRunner`, attached to the
   * process-wide subagent manager at build time) is the backing store:
   * entries are the engine's background subagent runs (`kind: 'agent'`,
   * v2 task-domain wire: taskId / description / status / startedAt /
   * endedAt / stopReason).
   */
  override async listBackgroundTasks(
    input: SessionIdRpcInput & { activeOnly?: boolean; limit?: number },
  ): Promise<readonly BackgroundTaskInfo[]> {
    this.requireSession(input.sessionId);
    const { backgroundTaskList } = await import('@moonshot-ai/kimi-agent/native');
    let raw: unknown;
    try {
      raw = JSON.parse(backgroundTaskList());
    } catch (error) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `malformed background task list from the engine: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(raw)) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        'malformed background task list from the engine',
      );
    }
    // The engine owns the entry shape; validate just enough that a bad
    // payload fails here with a named error instead of poisoning consumers
    // downstream (status stays a cast — the v2 domain owns its vocabulary).
    let tasks: BackgroundTaskInfo[] = (raw as readonly EngineTaskWireEntry[]).map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        throw new KimiError(
          ErrorCodes.REQUEST_INVALID,
          'malformed background task entry from the engine',
        );
      }
      return {
        kind: 'agent',
        taskId: String(entry.taskId ?? ''),
        description: String(entry.description ?? ''),
        status: entry.status as BackgroundTaskInfo['status'],
        startedAt: Number(entry.startedAt ?? 0),
        endedAt: entry.endedAt ?? null,
        ...(entry.stopReason !== undefined ? { stopReason: entry.stopReason } : {}),
      };
    });
    if (input.activeOnly) {
      tasks = tasks.filter((task) => task.status === 'running');
    }
    if (input.limit !== undefined && input.limit > 0 && tasks.length > input.limit) {
      tasks = tasks.slice(tasks.length - input.limit);
    }
    return tasks;
  }

  override async getBackgroundTaskOutput(
    input: SessionIdRpcInput & { taskId: string; tail?: number },
  ): Promise<string> {
    this.requireSession(input.sessionId);
    const { backgroundTaskOutput } = await import('@moonshot-ai/kimi-agent/native');
    const output = backgroundTaskOutput(input.taskId) ?? '';
    // `tail` caps to trailing characters (the `getBackgroundTaskOutput`
    // contract); the engine returns the full snapshot.
    if (input.tail === undefined || input.tail < 0) return output;
    return input.tail === 0 ? '' : output.slice(-input.tail);
  }

  override async stopBackgroundTask(
    input: SessionIdRpcInput & { taskId: string; reason?: string },
  ): Promise<void> {
    this.requireSession(input.sessionId);
    const { backgroundTaskStop } = await import('@moonshot-ai/kimi-agent/native');
    await backgroundTaskStop(input.taskId, input.reason);
  }

  override async detachBackgroundTask(
    input: SessionIdRpcInput & { taskId: string },
  ): Promise<BackgroundTaskInfo | undefined> {
    // The engine task runner is process-global: its tasks already outlive the
    // session handle, so there is no separate detach transition to record.
    // The session check keeps the guard consistent with list/get/stop.
    this.requireSession(input.sessionId);
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
    return resolveExperimentalFeatures(loadRuntimeConfigLenient(this.configPath));
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
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `unknown session "${sessionId}"`, {
        details: { sessionId },
      });
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
    await this.persistHistory(meta);
  }

  private persistMeta(meta: NativeSessionMeta): void {
    const persisted: PersistedSessionMeta = {
      id: meta.id,
      workDir: meta.workDir,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      title: meta.title,
      isCustomTitle: meta.isCustomTitle,
      ...(meta.lastPrompt !== undefined ? { lastPrompt: meta.lastPrompt } : {}),
      custom: meta.custom,
      additionalDirs: meta.additionalDirs,
      model: meta.model,
      thinkingEffort: meta.thinkingEffort,
      permissionMode: meta.permissionMode,
      planMode: meta.planMode,
      plan: meta.plan,
      goal: meta.goal,
      forkedFrom: meta.forkedFrom,
      contextTokens: meta.contextTokens,
    };
    this.writePersistedMeta(meta.sessionDir, persisted);
  }

  private writePersistedMeta(sessionDir: string, persisted: PersistedSessionMeta): void {
    try {
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(
        join(sessionDir, 'session-meta.json'),
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

  /** Map a prompt submission onto the engine's serialized LLM message. */
  private toSessionPrompt(input: SessionPromptRpcInput['input']): SessionPrompt {
    if (typeof input === 'string') {
      return { role: 'user', content: input };
    }
    return this.toSessionPromptFromParts(input);
  }

  private toSessionPromptFromParts(parts: readonly PromptPart[]): SessionPrompt {
    const text = parts
      .filter((part): part is Extract<PromptPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    const blocks = parts.map((part) => {
      if (part.type === 'text') {
        return { type: 'text', text: part.text };
      }
      if (part.type === 'image_url') {
        return { type: 'image_url', url: part.imageUrl.url };
      }
      if (part.type === 'video_url') {
        return { type: 'video_url', url: part.videoUrl.url };
      }
      return part;
    });
    return {
      role: 'user',
      content: text,
      blocks,
      // Multi-part messages carry their parts structurally so the context
      // projection (and the model) see them as separate blocks.
      ...(parts.length > 1 ? { blocksJson: JSON.stringify(parts) } : {}),
    } as SessionPrompt;
  }

  /**
   * Apply the prompt-derived metadata update (v2 `applyPromptMetadataUpdate`):
   * lastPrompt always, and the title only while it is still the untitled
   * default and not host-customized. Emits `session.meta.updated`.
   */
  private applyPromptMetadata(meta: NativeSessionMeta, text: string | undefined): void {
    if (text === undefined) return;
    const patch: { lastPrompt: string; title?: string } = { lastPrompt: text };
    if (!meta.isCustomTitle && isUntitledTitle(meta.title)) {
      patch.title = text.slice(0, MAX_TITLE_LENGTH);
      meta.title = patch.title;
      meta.titleKind = 'replaceable';
    }
    meta.lastPrompt = text;
    meta.updatedAt = Date.now();
    this.persistMeta(meta);
    this.receiveEvent({
      sessionId: meta.id,
      agentId: 'main',
      type: 'session.meta.updated',
      title: patch.title,
      patch: {
        title: patch.title,
        ...(patch.title !== undefined ? { isCustomTitle: false } : {}),
        lastPrompt: text,
      },
    });
  }

  /** The `agent.status.updated` snapshot emitted after a runtime-state change. */
  private emitStatusUpdated(meta: NativeSessionMeta): void {
    this.receiveEvent({
      sessionId: meta.id,
      agentId: 'main',
      type: 'agent.status.updated',
      model: meta.model,
      thinkingEffort: meta.thinkingEffort,
      permission: meta.permissionMode,
      planMode: meta.planMode,
      swarmMode: meta.swarmMode,
      towerMode: meta.towerMode,
      contextTokens: meta.contextTokens,
      maxContextTokens: meta.maxContextTokens,
      contextUsage:
        meta.maxContextTokens > 0 ? meta.contextTokens / meta.maxContextTokens : 0,
    });
  }

  /** Map the engine history onto the SDK context shape (origins included). */
  private contextFromHistory(
    meta: NativeSessionMeta,
    history: readonly SessionPrompt[],
  ): AgentContextData {
    return {
      history: history.map((message, index) => ({
        id: `msg_${index}`,
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: this.contextMessageContent(message),
        toolCalls: [],
        origin: { kind: 'user' },
      })),
      tokenCount: meta.contextTokens ?? 0,
    };
  }

  private contextMessageContent(
    message: SessionPrompt,
  ): ReadonlyArray<{ type: 'text'; text: string }> {
    const directBlocks = (message as { blocks?: unknown }).blocks;
    if (Array.isArray(directBlocks) && directBlocks.length > 0) {
      return directBlocks
        .filter(
          (block): block is { type: 'text'; text: string } =>
            isPlainObject(block) && block['type'] === 'text' && typeof block['text'] === 'string',
        )
        .map((block) => ({ type: 'text' as const, text: block.text }));
    }
    if (message.blocksJson !== undefined) {
      try {
        const blocks = JSON.parse(message.blocksJson) as unknown;
        if (Array.isArray(blocks) && blocks.length > 0) {
          return blocks
            .filter(
              (block): block is { type: 'text'; text: string } =>
                isPlainObject(block) && block['type'] === 'text' && typeof block['text'] === 'string',
            )
            .map((block) => ({ type: 'text' as const, text: block.text }));
        }
      } catch {
        // fall through to the plain content
      }
    }
    return [{ type: 'text', text: message.content }];
  }

  /**
   * Persist the live engine history to `<sessionDir>/history.jsonl` so a
   * resume can replay it into a fresh handle (the transcript persistence the
   * native harness owns).
   */
  private async persistHistory(meta: NativeSessionMeta): Promise<void> {
    if (!meta.handle) return;
    try {
      const history = await meta.handle.getHistory();
      mkdirSync(meta.sessionDir, { recursive: true });
      writeFileSync(
        join(meta.sessionDir, 'history.jsonl'),
        history.map((message) => JSON.stringify(message)).join('\n') + (history.length > 0 ? '\n' : ''),
        'utf8',
      );
    } catch {
      // best-effort durability: a history write failure must not break the turn
    }
  }

  private readPersistedHistory(meta: NativeSessionMeta): SessionPrompt[] {
    try {
      const raw = readFileSync(join(meta.sessionDir, 'history.jsonl'), 'utf-8');
      return raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as SessionPrompt);
    } catch {
      return [];
    }
  }

  async ensureConfigFile(): Promise<void> {
    await ensureConfigFileScaffold(this.configPath);
  }

  async close(): Promise<void> {
    for (const meta of this.liveSessions.values()) {
      if (meta.handle) {
        await meta.handle.dispose().catch(() => {});
      }
    }
    this.liveSessions.clear();
    await flushDiagnosticLogs();
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
    // The in-process core resolves its owner-scoped [image] limits from its
    // own config file (env var > config > built-in default).
    imageLimits:
      options.imageLimits ??
      new ImageLimits(process.env, {
        maxEdgePx: loadRuntimeConfigLenient(rpc.configPath).image?.maxEdgePx,
        readByteBudget: loadRuntimeConfigLenient(rpc.configPath).image?.readByteBudget,
      }),
    sessionStartedProperties: options.sessionStartedProperties,
  });
}
