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

import type {
  AgentContextData,
  AgentMeta,
  AgentType,
  JsonObject,
  PromptOrigin,
  ResumedAgentState,
  SuggestFilesInput,
  SuggestFilesItem,
  SuggestFilesResult,
  ToolCall,
} from '#/types';
import {
  EngineSessionHandle,
  type SessionCallbacks,
  type SessionPrompt,
  type SessionTurnOutcome,
} from '@moonshot-ai/kimi-agent/session-handle';
import type { OAuthRefreshOutcome } from '@moonshot-ai/kimi-code-oauth';
import {
  assertKimiHostIdentity,
  createKimiDefaultHeaders,
  parseKimiCodeCustomHeaders,
} from '@moonshot-ai/kimi-code-oauth';
import { estimateTokensForMessages } from '@moonshot-ai/kosong/tokens';
import type { KimiErrorCode, TurnEndReason } from '@moonshot-ai/protocol';
import { kimiErrorCodeSchema, mcpOAuthStoreKey } from '@moonshot-ai/protocol';
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
  type ActivatePluginCommandRpcInput,
  type ActivateSkillRpcInput,
  type ImportContextRpcInput,
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
  resolveNativeLlmForAlias,
  probeShellPath,
  buildPolicySnapshot,
  resolveSecondaryModelPool,
  resolveGithubCredentials,
  resolveSubagentTimeoutMs,
  resolveSwarmTimeoutMs,
  resolveMaxAttemptsPerStep,
  resolveMaxStepsPerTurn,
  resolveWebSearchService,
  resolveWebFetchService,
  resolveImageReadByteBudget,
  resolveImageMaxEdgePx,
  resolveModelCapabilities,
  resolveModelContextWindow,
  resolveBackgroundLimits,
  resolvePrintBackground,
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
 * The engine reports error codes as free-form strings; the protocol union is
 * closed, so an unrecognized code degrades to `internal` rather than dropping
 * the message that came with it.
 */
function toKimiErrorCode(raw: unknown): KimiErrorCode {
  const parsed = kimiErrorCodeSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'internal';
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
    maxContextTokens: resolveModelContextWindow(config, config.defaultModel),
    contextTokens: 0,
    usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
    goal: null,
    currentTurnId: 0,
  };
}

/**
 * Apply a session's live thinking override to the config-resolved native LLM.
 * setThinking mutates meta and rebuilds the handle, so the rebuilt pipeline
 * must carry the session's choice, not the config default. The thinking-budget
 * re-derivation mirrors native-llm-resolver's.
 *
 * The model is deliberately NOT overridden here: `meta.model` is a `[models]`
 * alias (`ollama/deepseek-v4.1-flash`), while `llm.model` is the wire model
 * that alias resolves to (`deepseek-v4.1-flash`). buildHandle already resolves
 * the LLM from `meta.model`, so copying the alias over `llm.model` sent the
 * alias to the provider — every alias whose wire model differs from its own
 * name came back as "model not found".
 */
function applySessionLlmOverrides(
  llm: JsNativeLlmConfig,
  meta: { thinkingEffort: string },
): JsNativeLlmConfig {
  const out: JsNativeLlmConfig = { ...llm };
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
 * The `liveShellCommands` key for one `!` shell command. `undefined` when the
 * caller passed no `commandId` — without one there is nothing to cancel by, so
 * the handle is not published.
 */
function shellCommandKey(sessionId: string, commandId: string | undefined): string | undefined {
  return commandId === undefined ? undefined : `${sessionId}\u0000${commandId}`;
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

/**
 * Expand a plugin command body against its arguments (v2
 * `expandCommandArguments`): `$ARGUMENTS` is replaced in place, and a body
 * without the placeholder gets the args appended as an `ARGUMENTS:` trailer so
 * they are never dropped.
 */
function expandCommandArguments(body: string, args: string): string {
  const replaced = body.replaceAll('$ARGUMENTS', args);
  if (!body.includes('$ARGUMENTS') && args.length > 0) {
    return `${replaced}\n\nARGUMENTS: ${args}`;
  }
  return replaced;
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
    id: 'notify_user',
    title: 'Updates panel (NotifyUser tool events)',
    description:
      'Show an experimental Updates panel with paginated progress messages from the main agent and subagents via the NotifyUser tool.',
    env: 'KIMI_CODE_EXPERIMENTAL_NOTIFY_USER',
    defaultEnabled: false,
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
  /** Keep this server's tools out of the top-level list; load them via `select_tools`. */
  deferred?: boolean;
}

export interface SDKRpcClientNativeOptions {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  /**
   * Data directory of the app-scope engine store (`<dir>/sessions.db`), the
   * SQLite database the plugin registry lives in. Defaults to
   * `<homeDir>/agent`, which is where the CLI hosts the native server
   * (`rust-server-runner` passes `--data-dir <home>/agent`); a host that runs
   * the server against a different `--data-dir` sets this so the CLI and the
   * server read one install state instead of two that silently disagree.
   */
  readonly engineDataDir?: string | undefined;
  readonly identity?: KimiHostIdentity | undefined;
  readonly auth?: KimiAuthFacade | undefined;
  readonly onOAuthRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
  readonly telemetry?: TelemetryClient | undefined;
  readonly uiMode?: string | undefined;
  readonly sessionStartedProperties?: TelemetryProperties | undefined;
  readonly imageLimits?: ImageLimits | undefined;
  readonly skillDirs?: readonly string[] | undefined;
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
  agents?: Record<string, AgentMeta>;
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
  agents?: Record<string, AgentMeta> | undefined;
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

/**
 * The directory holding `marketplace.json`, so the engine can resolve a
 * relative catalog `source` to a real plugin root. `KIMI_CODE_PLUGIN_MARKETPLACE_DIR`
 * pins it (tests, and installs that ship the catalog elsewhere); otherwise a
 * repo checkout is found by walking up from the cwd and from this module. A
 * packaged install has neither, so this answers `undefined` and the engine
 * falls back to its own cwd-relative lookup.
 */
function resolvePluginMarketplaceDir(): string | undefined {
  const override = process.env['KIMI_CODE_PLUGIN_MARKETPLACE_DIR'];
  if (override !== undefined && override !== '') return override;
  const candidates = [
    join(process.cwd(), 'plugins'),
    resolve(import.meta.dirname, '../../../../plugins'),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'marketplace.json'))) return dir;
  }
  return undefined;
}

function resolveMcpServersForEngine(servers: Record<string, StoredMcpServerConfig>): Array<{
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  deferred?: boolean;
}> {
  const result: Array<{
    name: string;
    transport: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    deferred?: boolean;
  }> = [];

  for (const [name, srv] of Object.entries(servers)) {
    if ((srv as { enabled?: boolean }).enabled === false) continue;
    // v2 `McpServerConfigSchema` infers the transport when the entry omits it
    // (`mcpCore/config-schema.ts`): a `command` means stdio, a `url` means
    // http. Requiring the field explicitly dropped every server written in the
    // standard MCP shape — `{"mcpServers":{"x":{"command":"…","args":[…]}}}` —
    // silently, so the session started with no MCP servers and nothing said so.
    const transport =
      srv.transport ?? (typeof srv.command === 'string' ? 'stdio' : typeof srv.url === 'string' ? 'http' : undefined);
    if (transport === 'stdio' && srv.command) {
      result.push({
        name,
        transport: 'stdio',
        command: srv.command,
        ...(srv.args ? { args: srv.args } : {}),
        ...(srv.env ? { env: srv.env } : {}),
        ...(srv.deferred === true ? { deferred: true } : {}),
      });
    } else if ((transport === 'http' || transport === 'sse') && srv.url) {
      result.push({
        name,
        transport: 'sse',
        url: srv.url,
        ...(srv.headers ? { headers: srv.headers } : {}),
        ...(srv.deferred === true ? { deferred: true } : {}),
      });
    }
  }
  return result;
}

export class SDKRpcClientNative extends SDKRpcClientBase {
  readonly homeDir: string;
  readonly configPath: string;
  /** Data dir of the app-scope engine store (`<dir>/sessions.db`). */
  readonly engineDataDir: string;
  readonly identity: KimiHostIdentity | undefined;
  readonly telemetry: TelemetryClient;
  readonly auth: KimiAuthFacade;
  readonly skillDirs: readonly string[];

  private readonly liveSessions = new Map<string, NativeSessionMeta>();
  private readonly sessionBaseDir: string;
  /** Set once `initPluginStore` has opened the engine's plugin registry. */
  private pluginStoreReady = false;
  /** Sessions whose in-flight compaction was cancelled from the host. */
  private readonly compactionCancels = new Set<string>();
  /**
   * Managed bash handles for live `!` shell commands, keyed by
   * `shellCommandKey(sessionId, commandId)`. `runShellCommand` publishes the
   * handle here so `cancelShellCommand` can kill the process tree it spawned.
   */
  private readonly liveShellCommands = new Map<string, number>();

  constructor(options: SDKRpcClientNativeOptions = {}) {
    super();
    // The engine seeds its client identity / request headers from the host
    // identity, so a harness without one fails at construction like the v2
    // client did (the v1 client tolerated its absence).
    this.identity = assertKimiHostIdentity(options.identity);
    this.homeDir = resolveKimiHome(options.homeDir);
    this.configPath = resolveConfigPath({ homeDir: this.homeDir, configPath: options.configPath });
    this.engineDataDir = options.engineDataDir ?? join(this.homeDir, 'agent');
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
          // `await` probes `then` on whatever it is handed, and this proxy
          // answers every property with a throwing function — so the probe
          // itself threw and every unimplemented call reported `"then"`
          // instead of the method the caller asked for. Answering `then` with
          // `undefined` keeps the proxy a non-thenable, and the real property
          // access below is what throws.
          if (prop === 'then') return undefined;
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
    const defaultHeaders = {
      ...parseKimiCodeCustomHeaders(),
      ...(this.identity
        ? createKimiDefaultHeaders({ homeDir: this.homeDir, ...this.identity })
        : {}),
    };
    const modelAlias = meta.model ?? config.defaultModel;
    const resolvedLlm = modelAlias
      ? resolveNativeLlmForAlias(config, modelAlias, undefined, defaultHeaders)
      : resolveNativeLlm(config, defaultHeaders);
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
        //
        // Wire shape: the return value is a serde-deserialized
        // `ToolExecuteResponse` (`kimi-agent/src/rpc/types.rs`), whose required
        // fields are `content` + `is_error` — NOT the `{output, isError}` pair
        // the rest of the SDK uses. Emitting the wrong keys made every host
        // fallback die as `execute_tool parse: missing field \`content\``,
        // replacing the intended message with an opaque serde error.
        let parsed: { tool_call_id?: string; tool_name?: string; arguments?: unknown };
        try {
          parsed = JSON.parse(req);
        } catch {
          return JSON.stringify({ content: 'malformed tool execute request', is_error: true });
        }
        const toolName = parsed.tool_name ?? 'unknown';
        return JSON.stringify({
          content: `tool "${toolName}" is host-owned and not yet wired on the native harness`,
          is_error: true,
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
        } else if (parsed.type === 'subagent.spawned') {
          if (typeof parsed.subagent_id === 'string') {
            meta.agents = meta.agents ?? {
              main: { homedir: meta.workDir, type: 'main', parentAgentId: null },
            };
            meta.agents[parsed.subagent_id] = {
              homedir: meta.workDir,
              type: 'sub',
              parentAgentId: 'main',
            };
            this.persistMeta(meta);
          }
        } else if (parsed.type === 'warning') {
          // Engine-side turn warnings (media budget, MCP startup, …). Without
          // this arm they were dropped on the floor: the engine emitted them
          // and no consumer ever saw one.
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
            type: 'warning',
            message: String(parsed.message ?? ''),
            ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
          });
        } else if (parsed.type === 'error') {
          // A turn that failed outright (session/mod.rs emits this beside the
          // failed `turn.ended`, mirroring v2's AgentErrorEvent). The code is
          // engine-supplied and validated against the protocol union by the
          // consumer, so an unknown one degrades to `internal` rather than
          // dropping the message.
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
            type: 'error',
            code: toKimiErrorCode(parsed.code),
            message: String(parsed.message ?? ''),
            retryable: parsed.retryable === true,
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
        //
        // The plan id and path ride along: `EnterPlanMode` renders its
        // workflow message from them, and without them the model is told to
        // wait for a plan file the host has already prepared.
        const parsed = JSON.parse(req) as { domain?: string };
        if (parsed.domain === 'plan') {
          return JSON.stringify({
            value: { active: meta.planMode, id: meta.plan?.id, path: meta.plan?.path },
          });
        }
        throw new Error('host does not support state bridge');
      },
      stateWrite: async (req: string) => {
        // The plan domain is host-owned, so the engine's EnterPlanMode /
        // ExitPlanMode write through this bridge and the host is what owns the
        // plan document and the `agent.status.updated` the UI switches on.
        // Without this arm the write fell through to the engine's local store
        // while the read came from here: EnterPlanMode reported success (and
        // wrote a plan file under the engine's own state dir), then
        // ExitPlanMode read `active: false` and refused to run.
        const parsed = JSON.parse(req) as { domain?: string; value?: { active?: boolean } };
        if (parsed.domain !== 'plan') {
          throw new Error('host does not support state bridge');
        }
        await this.setPlanMode({ sessionId, enabled: parsed.value?.active === true });
        const current = this.requireSession(sessionId);
        return JSON.stringify({
          ok: true,
          value: {
            active: current.planMode,
            id: current.plan?.id,
            path: current.plan?.path,
          },
        });
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
        const rawTurnId = parsed.turnId ?? parsed.turn_id;
        const turnId =
          typeof rawTurnId === 'number'
            ? rawTurnId
            : typeof rawTurnId === 'string'
              ? Number.parseInt(rawTurnId, 10) || 0
              : 0;
        if (parsed.type === 'turn.started') {
          meta.currentTurnId = turnId;
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
            type: 'turn.started',
            turnId,
            // origin is required on TurnStartedEvent; native turns are always
            // user-prompted (skill / plugin / task origins are host-driven and
            // do not run through this engine callback).
            origin: { kind: 'user' },
            prompt: String(parsed.prompt ?? ''),
          });
        } else if (parsed.type === 'turn.ended') {
          const endedTurnId =
            parsed.turnId !== undefined || parsed.turn_id !== undefined
              ? turnId
              : meta.currentTurnId;
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
            type: 'turn.ended',
            turnId: endedTurnId,
            reason: toTurnEndReason(parsed.reason ?? parsed.status),
            ...(parsed.error ? { error: parsed.error } : {}),
            ...(parsed.durationMs ?? parsed.duration_ms
              ? { durationMs: parsed.durationMs ?? parsed.duration_ms }
              : {}),
          });
          meta.activeAgentId = undefined;
        }
        // Unknown turn events are dropped (see emitEvent).
      },
    };

    // The `[secondary_model]` pool is always on (0.42.0 promoted the
    // experiment). It rides the session params as JSON; a malformed section
    // throws here, so the session fails at startup naming the offending alias.
    const secondaryModel = resolveSecondaryModelPool(config, true, process.env, defaultHeaders);
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
    const maxSteps = resolveMaxStepsPerTurn(config);
    const webSearch = resolveWebSearchService(config);
    const webFetch = resolveWebFetchService(config);
    const imageReadByteBudget = resolveImageReadByteBudget(config);
    const imageMaxEdgePx = resolveImageMaxEdgePx(config);
    const modelCapabilities = resolveModelCapabilities(config, meta.model);
    // Progressive tool disclosure (v2 `toolSelectService.enabled()`): the
    // flag alone is not enough — the advertised table is only shaped when the
    // model also declares `dynamically_loaded_tools`, but the flag is what
    // the engine's gate reads.
    const toolSelect = isExperimentalFlagEnabled(config, 'tool_select');
    const background = resolveBackgroundLimits(config);
    // Print mode (`kimi -p`): the host resolves only which `[background]`
    // values apply — the engine owns the settle behavior.
    const printBackground = resolvePrintBackground(config);
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
      // `/add-dir` roots. The engine serves paths under them natively; without
      // this they fall outside `workspace_root` and the only fallback — the
      // host `execute_tool` seam — has no tool runtime to serve them.
      // `?? undefined` (never null): napi Option fields reject null.
      additionalDirs: meta.additionalDirs.length > 0 ? [...meta.additionalDirs] : undefined,
      shellPath,
      policySnapshotJson: JSON.stringify(policySnapshot),
      secondaryModelJson:
        secondaryModel === undefined ? undefined : JSON.stringify(secondaryModel),
      // Host-resolved config knobs (env > config, see native-llm-resolver).
      // `?? undefined` (never null): napi Option fields reject null.
      subagentTimeoutMs: subagentTimeoutMs ?? undefined,
      swarmTimeoutMs: swarmTimeoutMs ?? undefined,
      maxAttempts: maxAttempts ?? undefined,
      maxSteps: maxSteps ?? undefined,
      webSearch: webSearch ?? undefined,
      webFetch: webFetch ?? undefined,
      imageReadByteBudget: imageReadByteBudget ?? undefined,
      imageMaxEdgePx: imageMaxEdgePx ?? undefined,
      modelCapabilities: modelCapabilities ?? undefined,
      toolSelect,
      // `[background]` knobs: the engine applies them to its own task runner
      // and Bash tool, so the file behaves the same on every entry point.
      killGracePeriodMs: background?.killGracePeriodMs,
      maxRunningTasks: background?.maxRunningTasks,
      bashAutoBackgroundOnTimeout: background?.bashAutoBackgroundOnTimeout,
      bashTaskTimeoutS: background?.bashTaskTimeoutS,
      // Print-mode settle policy (`kimi -p`): the engine holds the turn
      // receipt while the task runner drains.
      printBackgroundMode: printBackground.mode,
      printWaitCeilingS: printBackground.ceilingS,
      printMaxTurns: printBackground.maxTurns,
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
        maxContextTokens: resolveModelContextWindow(config, config.defaultModel),
        contextTokens: persisted?.contextTokens ?? 0,
        usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
        goal: persisted?.goal ?? null,
        plan: persisted?.plan,
        forkedFrom: persisted?.forkedFrom,
        agents: persisted?.agents,
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
    return this.resumedSessionSummary(meta, input);
  }

  /** The `ResumedSessionSummary` of a session, including the per-agent main snapshot and any subagents. */
  private async resumedSessionSummary(
    meta: NativeSessionMeta,
    input?: ResumeSessionInput,
  ): Promise<ResumedSessionSummary> {
    let history = meta.handle
      ? await meta.handle.getHistory().catch(() => [])
      : [];
    if (history.length === 0) {
      history = this.readPersistedHistory(meta);
    }
    const context = this.contextFromHistory(meta, history);

    const sessionAgentsRoster: Record<string, AgentMeta> = {
      main: { homedir: meta.workDir, type: 'main' as const, parentAgentId: null },
      ...meta.agents,
    };

    const discoveredSubagents = new Map<
      string,
      {
        type: AgentType;
        prompt: string;
        summary: string;
        startedAt: number;
      }
    >();

    const calls = new Map<
      string,
      { name: string; prompt: string; startedAt: number }
    >();

    for (let i = 0; i < history.length; i++) {
      const msg = history[i]!;
      const raw = msg as unknown as Record<string, unknown>;
      const time = meta.createdAt + i;
      const rawCalls = (raw['tool_calls'] ?? raw['toolCalls']) as unknown[] | undefined;
      if (Array.isArray(rawCalls)) {
        for (const c of rawCalls) {
          const call = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
          const name = typeof call['name'] === 'string' ? call['name'] : '';
          const id = typeof call['id'] === 'string' ? call['id'] : '';
          if (name === 'Agent' || name === 'AgentSwarm') {
            let prompt = '';
            try {
              const rawArgs = call['arguments'];
              const args =
                typeof rawArgs === 'string'
                  ? (JSON.parse(rawArgs) as Record<string, unknown>)
                  : (rawArgs as Record<string, unknown>);
              if (args && typeof args === 'object') {
                prompt = typeof args['prompt'] === 'string' ? args['prompt'] : '';
              }
            } catch {}
            calls.set(id, { name, prompt, startedAt: time });
          }
        }
      }

      const rawCallId = raw['tool_call_id'] ?? raw['toolCallId'];
      const toolCallId = typeof rawCallId === 'string' ? rawCallId : '';
      if (toolCallId && calls.has(toolCallId)) {
        const callInfo = calls.get(toolCallId)!;
        const content = typeof msg.content === 'string' ? msg.content : '';
        const agentIdMatch = /(?:^|\n)agent_id:\s*([^\s]+)\s*(?=\n|$)/.exec(content);
        if (agentIdMatch) {
          const childAgentId = agentIdMatch[1]!;
          const summaryMatch = /(?:^|\n)\[summary\]\n([\s\S]*)$/.exec(content);
          const summary = summaryMatch ? summaryMatch[1]! : '';

          sessionAgentsRoster[childAgentId] = {
            homedir: meta.workDir,
            type: 'sub',
            parentAgentId: 'main',
          };
          discoveredSubagents.set(childAgentId, {
            type: 'sub',
            prompt: callInfo.prompt,
            summary,
            startedAt: callInfo.startedAt,
          });
        }
      }
    }

    const resumedAgents: Record<string, ResumedAgentState> = {
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
    };

    if (input?.includeSubagents === true) {
      for (const [childAgentId, sub] of discoveredSubagents) {
        resumedAgents[childAgentId] = {
          type: sub.type,
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
          context: {
            history: [
              {
                id: `${childAgentId}_prompt`,
                role: 'user',
                content: [{ type: 'text', text: sub.prompt }],
                origin: { kind: 'user' },
              },
              {
                id: `${childAgentId}_reply`,
                role: 'assistant',
                content: [{ type: 'text', text: sub.summary }],
              },
            ],
            tokenCount: 0,
          },
          replay: [
            {
              type: 'message',
              time: sub.startedAt,
              message: {
                id: `${childAgentId}_prompt`,
                role: 'user',
                content: [{ type: 'text', text: sub.prompt }],
                origin: { kind: 'user' },
              },
            },
            {
              type: 'message',
              time: sub.startedAt + 1,
              message: {
                id: `${childAgentId}_reply`,
                role: 'assistant',
                content: [{ type: 'text', text: sub.summary }],
              },
            },
          ],
          permission: { mode: meta.permissionMode },
          plan: null,
          swarmMode: false,
          usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
          tools: [],
          background: [],
        };
      }
    }

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
        workDir: meta.workDir,
        agents: sessionAgentsRoster,
        custom: { ...meta.custom } as JsonObject,
      },
      agents: resumedAgents,
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
      // The extra roots are baked into the engine handle at build time — the
      // native toolset's sandbox is constructed from `meta.additionalDirs` —
      // so a newly authorized directory only takes effect after a rebuild.
      // Same contract as setModel / setPermission: carry the history over, and
      // drop the root again when the rebuild fails.
      const previous = meta.additionalDirs;
      meta.additionalDirs = [...previous, input.path];
      try {
        await this.rebuildHandle(meta);
      } catch (error) {
        meta.additionalDirs = previous;
        throw error;
      }
      // `rebuildHandle` already stamped `meta.updatedAt`.
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
      await this.persistHistory(meta).catch(() => {});
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
      // v2 #3764: a client-supplied displayText feeds the title/lastPrompt
      // metadata instead of the raw input text.
      this.applyPromptMetadata(
        meta,
        input.clientMetadata?.displayText ?? promptMetadataTextFromPrompt(input.input),
      );
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
    // v2 #3764: displayText metadata wins for the last-prompt metadata.
    this.applyPromptMetadata(
      meta,
      input.clientMetadata?.displayText ?? promptMetadataTextFromPrompt(input.input),
    );
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
    // The native LLM (model / thinking budget) is baked into the engine handle
    // at build time, so a model change rebuilds it, carrying the history over.
    await this.applyRebuiltSetting(meta, 'model', input.model);
    this.emitStatusUpdated(meta);
    // Reached only when the rebuild succeeded, so the handle runs `input.model`.
    return { model: input.model };
  }

  override async setThinking(input: SetSessionThinkingRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    await this.applyRebuiltSetting(meta, 'thinkingEffort', input.effort);
    this.emitStatusUpdated(meta);
  }

  override async setPermission(input: SetSessionPermissionRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    // The permission mode lives in the policy snapshot the engine's
    // PermissionEngine was built from, so changing it rebuilds the handle.
    await this.applyRebuiltSetting(meta, 'permissionMode', input.mode);
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
    await this.applyRebuiltSetting(meta, 'swarmMode', input.enabled);
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
    const meta = this.requireSession(input.sessionId);
    if (meta.handle === undefined) return [];
    // The engine's own degradations — MCP servers it could not connect, and
    // servers waiting on the user's authorization. This used to answer `[]`
    // unconditionally, so a user whose MCP tools were missing got no reason.
    const warnings = await meta.handle.warnings();
    return warnings as readonly { code: string; message: string; severity: 'warning' }[];
  }

  override async getTodos(input: SessionIdRpcInput): Promise<readonly SessionTodoItem[]> {
    const meta = this.requireSession(input.sessionId);
    // The engine owns the todo state, and it lives under the workspace's
    // engine-state directory — whose name is a digest of the canonicalized
    // workspace path, so the host asks the engine for it rather than guessing.
    // The previous guess read `<sessionDir>/todo.json`, which nothing ever
    // writes, so this always answered `[]` and `/undo` could not restore the
    // panel it had just cleared.
    const { nativeReadEngineState } = await import('@moonshot-ai/kimi-agent/native');
    const raw = nativeReadEngineState(meta.workDir, 'todo');
    if (raw === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry: { title?: string; status?: string }) => ({
      title: String(entry.title ?? ''),
      status:
        entry.status === 'done' || entry.status === 'completed'
          ? 'done'
          : entry.status === 'in_progress'
            ? 'in_progress'
            : 'pending',
    }));
  }

  override async cancelShellCommand(input: {
    sessionId: string;
    commandId: string;
  }): Promise<void> {
    this.requireSession(input.sessionId);
    const key = shellCommandKey(input.sessionId, input.commandId);
    const id = key === undefined ? undefined : this.liveShellCommands.get(key);
    // Nothing to kill means the command already finished (or never started) —
    // not an error, and not a claim that something was cancelled.
    if (id === undefined) return;
    const { nativeBashKill } = await import('@moonshot-ai/kimi-agent/native');
    nativeBashKill(id);
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
      // Publish the handle so `cancelShellCommand` can reach the process this
      // call spawned. Without it the cancel had nothing to kill and reported
      // success while the command kept running.
      const key = shellCommandKey(input.sessionId, input.commandId);
      if (key !== undefined) this.liveShellCommands.set(key, id);
      try {
        const exit = await nativeBashWait(id);
        return {
          stdout,
          stderr,
          isError: exit.exitCode !== 0 || Boolean(exit.error),
          backgrounded: false,
        };
      } finally {
        if (key !== undefined) this.liveShellCommands.delete(key);
      }
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
    const agentId = await meta.handle.startBtw();
    meta.agents = meta.agents ?? {
      main: { homedir: meta.workDir, type: 'main', parentAgentId: null },
    };
    meta.agents[agentId] = {
      homedir: meta.workDir,
      type: 'sub',
      parentAgentId: 'main',
    };
    this.persistMeta(meta);
    return agentId;
  }

  /**
   * Title generation over the live engine history: the engine applies the
   * first_turn / user_prompts rule to the session's cross-turn history, or
   * asks the managed platform through the `chat_title` tool when `source` is
   * `digest`. A generated title lands as `titleKind: 'generated'`; without
   * `force` an existing generated or host-custom title is returned as-is.
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
    if (
      input.source !== undefined &&
      input.source !== 'first_turn' &&
      input.source !== 'user_prompts' &&
      input.source !== 'digest'
    ) {
      // The three checks above exhaust the declared union, so this branch is
      // only reachable from an untyped caller; `String` keeps the message
      // honest without widening the parameter.
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `unsupported title source "${String(input.source)}": expected 'first_turn', 'user_prompts' or 'digest'`,
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
    // text is the slash command itself — with a client-supplied displayText
    // winning over the raw slash text (v2 #3764).
    this.applyPromptMetadata(
      meta,
      input.clientMetadata?.displayText ??
        promptMetadataTextFromText(`/${name}${args ? ` ${args}` : ''}`),
    );
    // A turn already running steers the activation into it (v2 #3832: the
    // steered activation gets a transcript frame via the same event); a
    // fresh `newTurn` enqueue here would queue a second turn behind a busy
    // session instead of joining the running one.
    if (meta.busy) {
      return this.steer({
        sessionId: meta.id,
        input: [{ type: 'text', text: rendered }],
      });
    }
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

  override async listMcpServers(input: SessionIdRpcInput): Promise<readonly McpServerInfo[]> {
    const meta = this.requireSession(input.sessionId);
    if (meta.handle === undefined) return [];
    // The engine connected these from `params.mcp_servers`; the host used to
    // answer `[]` unconditionally, so a configured server was invisible to
    // `/mcp` and to the VS Code MCP panel.
    const entries = await meta.handle.mcpServers();
    // The engine serialises its own `McpServerEntry` (`tool_count`, `tools` as
    // `{name, description}`); the public shape is camelCase, so passing the raw
    // entry through left `/mcp` reporting "0 tools" for every connected server.
    return entries.map((entry) => {
      const raw = entry as Record<string, unknown>;
      const tools = Array.isArray(raw['tools']) ? (raw['tools'] as readonly unknown[]) : undefined;
      return {
        ...raw,
        name: String(raw['name']),
        transport: String(raw['transport']),
        status: raw['status'] as McpServerInfo['status'],
        toolCount: typeof raw['tool_count'] === 'number' ? raw['tool_count'] : (tools?.length ?? 0),
        tools,
      } as McpServerInfo;
    });
  }

  override async suggestFiles(
    workDir: string,
    input: SuggestFilesInput,
  ): Promise<SuggestFilesResult | undefined> {
    // The engine's own search (`server::fs_routes::search_files`), reached
    // through the addon so the host and the HTTP server rank identically. The
    // wire spells the highlight frame `match_positions`; the public shape is
    // camelCase.
    const { fsSuggest } = await import('@moonshot-ai/kimi-agent/native');
    const raw = JSON.parse(fsSuggest(workDir, input.query, input.limit ?? 50)) as {
      items: readonly {
        path: string;
        name: string;
        kind: string;
        match_positions?: readonly number[];
      }[];
      truncated: boolean;
    };
    return {
      items: raw.items.map((item) => ({
        path: item.path,
        name: item.name,
        kind: item.kind as SuggestFilesItem['kind'],
        matchPositions: item.match_positions ?? [],
      })),
      truncated: raw.truncated,
    };
  }

  override async listWorkspaceMcpServers(_workDir: string): Promise<readonly McpServerInfo[]> {
    // No session exists yet, so nothing is connected and the engine holds no
    // registry to read. Report what a session would start, from the same
    // `mcp.json` the engine is handed at creation (`resolveMcpServersForEngine`).
    // Status is `pending`: the engine connects these when it builds a session
    // pipeline, so claiming `connected` here would be a lie.
    return resolveMcpServersForEngine(this.loadGlobalMcpConfig()).map((server) => ({
      name: server.name,
      transport: server.transport,
      status: 'pending' as const,
      toolCount: 0,
    }));
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
    // `pending`, not `connected`: this only records the configuration. The
    // engine connects servers when it builds a session pipeline from
    // `params.mcp_servers`, so nothing is connected yet — reporting
    // `connected` with `toolCount: 0` claimed a live server that did not
    // exist.
    return {
      name,
      transport: input.server.transport,
      status: 'pending',
      toolCount: 0,
    };
  }

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

  override async completeMcpServerAuth(): Promise<void> {}
  override async cancelMcpServerAuth(): Promise<void> {}

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

  /**
   * Nothing to wait for: the engine drains the session's background tasks
   * inside the turn, while the turn slot is still held, and only then resolves
   * the `prompt()` receipt. By the time a host could call this, the drain has
   * already happened — the engine's own comment says holding the receipt is
   * what keeps the host free of a settle loop.
   */
  override async waitForBackgroundTasksOnPrint(_input: SessionIdRpcInput): Promise<void> {}

  /**
   * `'finish'` is the answer, not a placeholder. The engine runs the whole
   * print-background lifecycle inside the turn — drain, then the goal / cron /
   * task follow-up turns for `steer` mode — so a completed main turn means the
   * run is done and the host has nothing to keep alive.
   */
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

  /**
   * Open the engine's plugin registry against the SQLite store the app-scope
   * engine uses (`<engineDataDir>/sessions.db`), so the CLI and the hosted
   * server read one install state. Idempotent; every plugin method below calls
   * it first.
   */
  private async ensurePluginStore(): Promise<void> {
    if (this.pluginStoreReady) return;
    const { initPluginStore } = await import('@moonshot-ai/kimi-agent/native');
    initPluginStore(this.engineDataDir, resolvePluginMarketplaceDir());
    this.pluginStoreReady = true;
  }

  override async listPlugins(): Promise<readonly PluginSummary[]> {
    await this.ensurePluginStore();
    const { pluginList } = await import('@moonshot-ai/kimi-agent/native');
    return JSON.parse(pluginList()) as readonly PluginSummary[];
  }

  override async installPlugin(source: string): Promise<PluginSummary> {
    await this.ensurePluginStore();
    const { pluginInstall } = await import('@moonshot-ai/kimi-agent/native');
    // The catalog keys installs by id, but a caller may hand over the catalog
    // `source` (the TUI resolves a path or URL before calling); the engine
    // matches either.
    const raw = pluginInstall(source.trim());
    if (raw === null || raw === undefined) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `Unknown plugin "${source}" — it is not in the marketplace catalog.`,
      );
    }
    return JSON.parse(raw) as PluginSummary;
  }

  override async getPluginInfo(id: string): Promise<PluginInfo> {
    await this.ensurePluginStore();
    const { pluginInfo } = await import('@moonshot-ai/kimi-agent/native');
    const raw = pluginInfo(id);
    if (raw === null || raw === undefined) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, `Plugin "${id}" is not installed.`);
    }
    return JSON.parse(raw) as PluginInfo;
  }

  override async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    await this.ensurePluginStore();
    const { pluginSetEnabled } = await import('@moonshot-ai/kimi-agent/native');
    if (!pluginSetEnabled(id, enabled)) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `Plugin "${id}" is neither installed nor in the marketplace catalog.`,
      );
    }
  }

  override async setPluginMcpServerEnabled(
    id: string,
    server: string,
    enabled: boolean,
  ): Promise<void> {
    await this.ensurePluginStore();
    const { pluginSetMcpServerEnabled } = await import('@moonshot-ai/kimi-agent/native');
    if (!pluginSetMcpServerEnabled(id, server, enabled)) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `Plugin "${id}" does not declare an MCP server named "${server}".`,
      );
    }
  }

  override async removePlugin(id: string): Promise<void> {
    await this.ensurePluginStore();
    const { pluginRemove } = await import('@moonshot-ai/kimi-agent/native');
    if (!pluginRemove(id)) {
      throw new KimiError(ErrorCodes.REQUEST_INVALID, `Plugin "${id}" is not installed.`);
    }
  }

  override async reloadPlugins(): Promise<ReloadSummary> {
    await this.ensurePluginStore();
    const { pluginReload } = await import('@moonshot-ai/kimi-agent/native');
    return JSON.parse(pluginReload()) as ReloadSummary;
  }

  override async listPluginCommands(): Promise<readonly PluginCommandDef[]> {
    // Plugin commands are app-global: the engine reads them from the installed
    // plugins' manifests, not from a session.
    return this.listPluginCommandsGlobal();
  }

  override async listPluginCommandsGlobal(): Promise<readonly PluginCommandDef[]> {
    await this.ensurePluginStore();
    const { pluginCommands } = await import('@moonshot-ai/kimi-agent/native');
    return JSON.parse(pluginCommands()) as readonly PluginCommandDef[];
  }

  /**
   * Expand a plugin command's body into the prompt it submits. Mirrors the v2
   * `expandCommandArguments` contract: `$ARGUMENTS` is substituted in place,
   * and a body without the placeholder gets the args appended as an
   * `ARGUMENTS:` trailer rather than losing them.
   */
  override async activatePluginCommand(input: ActivatePluginCommandRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    const defs = await this.listPluginCommandsGlobal();
    const def = defs.find(
      (command) => command.pluginId === input.pluginId && command.name === input.commandName,
    );
    if (def === undefined) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `Plugin command "${input.pluginId}:${input.commandName}" was not found`,
      );
    }
    const body = def.body ?? def.prompt ?? '';
    const commandArgs = input.args ?? '';
    const expanded = expandCommandArguments(body, commandArgs);
    const activationId = `plugin_${randomUUID()}`;
    this.receiveEvent({
      sessionId: meta.id,
      agentId: 'main',
      type: 'plugin_command.activated',
      activationId,
      pluginId: input.pluginId,
      commandName: input.commandName,
      commandArgs,
      trigger: 'user-slash',
    });
    this.applyPromptMetadata(
      meta,
      promptMetadataTextFromText(
        commandArgs.length === 0
          ? `/${input.pluginId}:${input.commandName}`
          : `/${input.pluginId}:${input.commandName} ${commandArgs}`,
      ),
    );
    return this.prompt({
      sessionId: meta.id,
      input: [{ type: 'text', text: expanded }],
      skipPromptMetadata: true,
    });
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
   *
   * The new handle is built *before* the old one is disposed. The engine keys
   * its registry by a process-local id (`session-<n>`), so the two never
   * collide — and a build that throws leaves the session on its previous
   * handle. Disposing first left `meta.handle` undefined, and every later
   * prompt then reported `session.not_found` ("cannot prompt unknown or closed
   * session") for a session that was still live and still listed.
   */
  private async rebuildHandle(meta: NativeSessionMeta): Promise<void> {
    const previous = meta.handle;
    const history = previous ? await previous.getHistory().catch(() => []) : [];
    const handle = await this.buildHandle(meta);
    try {
      if (history.length > 0) {
        await handle.setHistory(history);
      }
    } catch (error) {
      // The replacement never took over; drop it rather than leaking a live
      // engine session the host can no longer address.
      await handle.dispose().catch(() => {});
      throw error;
    }
    meta.handle = handle;
    meta.updatedAt = Date.now();
    await this.persistHistory(meta);
    await previous?.dispose().catch(() => {});
  }

  /**
   * Apply a setting that is baked into the engine handle at build time, and
   * roll the field back when the rebuild fails. Without the rollback a failed
   * `setModel` left `meta.model` naming a model the engine never switched to,
   * so the TUI reported a change that had not happened.
   */
  private async applyRebuiltSetting<K extends keyof NativeSessionMeta>(
    meta: NativeSessionMeta,
    key: K,
    value: NativeSessionMeta[K],
  ): Promise<void> {
    const previous = meta[key];
    meta[key] = value;
    try {
      await this.rebuildHandle(meta);
    } catch (error) {
      meta[key] = previous;
      throw error;
    }
  }

  private persistMeta(meta: NativeSessionMeta): void {
    const persisted: PersistedSessionMeta = {
      id: meta.id,
      workDir: meta.workDir,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      title: meta.title,
      isCustomTitle: meta.isCustomTitle,
      lastPrompt: meta.lastPrompt,
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
      agents: meta.agents,
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
      history: history.map((message, index) => {
        const raw = message as unknown as Record<string, unknown>;
        const rawRole = typeof raw['role'] === 'string' ? raw['role'] : 'user';
        const role: 'user' | 'assistant' | 'system' | 'tool' =
          rawRole === 'assistant' || rawRole === 'tool' || rawRole === 'system'
            ? rawRole
            : 'user';

        let toolCalls: ToolCall[] | undefined;
        const rawToolCalls = raw['tool_calls'] ?? raw['toolCalls'];
        if (Array.isArray(rawToolCalls)) {
          toolCalls = rawToolCalls.map((tc: unknown) => {
            const call = (tc && typeof tc === 'object' ? tc : {}) as Record<string, unknown>;
            const rawArgs = call['arguments'];
            const args =
              typeof rawArgs === 'string'
                ? rawArgs
                : rawArgs !== undefined && rawArgs !== null
                  ? JSON.stringify(rawArgs)
                  : null;
            return {
              type: 'function' as const,
              id: typeof call['id'] === 'string' ? call['id'] : '',
              name: typeof call['name'] === 'string' ? call['name'] : '',
              arguments: args,
            };
          });
        } else if (typeof raw['toolCallsJson'] === 'string') {
          try {
            const parsed = JSON.parse(raw['toolCallsJson']) as unknown;
            if (Array.isArray(parsed)) {
              toolCalls = parsed.map((tc: unknown) => {
                const call = (tc && typeof tc === 'object' ? tc : {}) as Record<string, unknown>;
                const rawArgs = call['arguments'];
                const args =
                  typeof rawArgs === 'string'
                    ? rawArgs
                    : rawArgs !== undefined && rawArgs !== null
                      ? JSON.stringify(rawArgs)
                      : null;
                return {
                  type: 'function' as const,
                  id: typeof call['id'] === 'string' ? call['id'] : '',
                  name: typeof call['name'] === 'string' ? call['name'] : '',
                  arguments: args,
                };
              });
            }
          } catch {}
        }

        const toolCallId =
          typeof raw['tool_call_id'] === 'string'
            ? raw['tool_call_id']
            : typeof raw['toolCallId'] === 'string'
              ? raw['toolCallId']
              : undefined;

        const isError = Boolean(raw['is_error'] ?? raw['isError']);

        const rawOrigin = raw['origin'] as PromptOrigin | undefined;
        const origin: PromptOrigin = rawOrigin ?? { kind: 'user' };

        return {
          id: `msg_${index}`,
          role,
          content: this.contextMessageContent(message),
          toolCalls: toolCalls ?? (role === 'assistant' ? [] : undefined),
          toolCallId,
          isError: isError || undefined,
          origin,
        };
      }),
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
    return [{ type: 'text', text: message.content ?? '' }];
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
    if (this.pluginStoreReady) {
      // Release the SQLite handle: Windows keeps a lock on an open database,
      // which blocks removing the data directory.
      const { closePluginStore } = await import('@moonshot-ai/kimi-agent/native');
      closePluginStore();
      this.pluginStoreReady = false;
    }
    await flushDiagnosticLogs();
  }
}

export function createKimiHarnessNative(options: SDKRpcClientNativeOptions): KimiHarness {
  const rpc = new SDKRpcClientNative(options);  return new KimiHarness(rpc, {
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
