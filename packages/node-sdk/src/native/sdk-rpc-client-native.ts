import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import {
  BUILTIN_NORMIFY_PLUGIN_ID,
  materializeBuiltinPlugins,
  setBuiltinPluginOptOut,
} from './builtin-normify';

import {
  BUILTIN_AGENT_PROFILE_NAMES,
  discoverAgentFiles,
  type AgentFileDefinition,
  type DiscoveredAgentFiles,
} from '#/agent-file';

import type {
  AgentContextData,
  AgentMeta,
  AgentType,
  BundledSkillActivation,
  ClientPromptMetadata,
  ImportCustomRegistryOptions,
  ImportCustomRegistryResult,
  JsonObject,
  PromptOrigin,
  PromptOriginMetadataEntry,
  ResumedAgentState,
  SkillActivationOrigin,
  SkillSource,
  SuggestFilesInput,
  SuggestFilesItem,
  SuggestFilesResult,
  SwarmModeTrigger,
  ToolCall,
} from '#/types';
import {
  EngineSessionHandle,
  type SessionCallbacks,
  type SessionPrompt,
  type SessionTurnOutcome,
} from '@moonshot-ai/kimi-agent/session-handle';
import type {
  CustomRegistryProviderEntry,
  CustomRegistrySource,
  ManagedKimiConfigShape,
  OAuthRefreshOutcome,
} from '@moonshot-ai/kimi-code-oauth';
import {
  applyCustomRegistryEntries,
  assertKimiHostIdentity,
  createKimiDefaultHeaders,
  credentialEnvHints,
  CustomRegistryApiError,
  fetchCustomRegistry,
  parseKimiCodeCustomHeaders,
} from '@moonshot-ai/kimi-code-oauth';
import { estimateTokensForMessages } from '@moonshot-ai/kosong/tokens';
import { effectiveModelAlias } from '#/model-alias';
import type {
  CronJobOrigin,
  GoalSnapshot as ProtocolGoalSnapshot,
  KimiErrorCode,
  TaskInfo,
  TokenUsage,
  TurnEndReason,
} from '@moonshot-ai/protocol';
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
import { RegistryImportError } from '#/catalog';
import { ensureConfigFile as ensureConfigFileScaffold } from '#/config-helpers';
import { resolveConfigPath, resolveKimiHome } from '#/config-local/path';
import { parseBooleanEnv } from '#/config-local/resolve';
import type { QuestionItem, ToolInputDisplay } from '#/events';
import { ImageLimits } from '#/image-limits';
import { KimiHarness } from '#/kimi-harness';
import { ErrorCodes, KimiError } from '#/error-protocol';
import {
  flushDiagnosticLogs,
  getRootLogger,
  log,
  resolveLoggingConfig,
  type SessionLogHandle,
} from '#/logging';
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
import { appendAdditionalDir, readAdditionalDirs, resolveAdditionalDirs } from '#/project-local-config';
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
  WorkspaceTrustMcpServerInfo,
  ExperimentalFlagSource,
} from '#/types';

import {
  resolveNativeLlm,
  resolveNativeLlmForAlias,
  lookupModelAlias,
  probeShellPath,
  buildPolicySnapshot,
  resolveSecondaryModelPool,
  resolveMultiLlmProviders,
  resolveGithubCredentials,
  resolveSubagentTimeoutMs,
  resolveSwarmTimeoutMs,
  resolveMaxAttemptsPerStep,
  resolveCompactionMaxAttempts,
  resolveMaxStepsPerTurn,
  resolveWebSearchService,
  resolveWebFetchService,
  resolveBingApiService,
  resolveImageReadByteBudget,
  resolveImageMaxEdgePx,
  resolveModelCapabilities,
  resolveModelContextWindow,
  resolveBackgroundLimits,
  resolvePrintBackground,
  providerTypeForAlias,
  type JsNativeLlmConfig,
} from './native-llm-resolver';

/**
 * Map the engine's snake_case usage payload onto the protocol's camelCase
 * {@link TokenUsage}. Returns `undefined` when the engine reported none.
 */
function toTokenUsage(raw: unknown): TokenUsage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const num = (key: string): number => (typeof usage[key] === 'number' ? usage[key] : 0);
  return {
    inputOther: num('input_tokens'),
    output: num('output_tokens'),
    inputCacheRead: num('input_cache_read'),
    inputCacheCreation: num('input_cache_creation'),
  };
}

/**
 * Normalize an engine turn id to the numeric id the protocol events carry.
 *
 * The engine mints turn ids in two string shapes — `turn-<n>` on the event lane
 * (`EngineEvent::TurnStarted`) and `subturn-<rand>` on the subagent lane
 * (`subagent/manager.rs`) — and as a plain number on the turn-lifecycle lane
 * (`turn_events::TurnEvent`, `turn_id: u64`). `Number.parseInt` only reads a
 * *leading* run of digits, so `turn-3` parsed to `NaN` and `NaN || 0` mapped
 * every such turn onto 0 — the value `meta.currentTurnId` also starts at, so
 * the collapse was invisible.
 *
 * Take the *trailing* digits instead, which is the normalization the transcript
 * fold already applies to the same ids (`server/transcript/project.rs`:
 * `turn_key` keeps the digits after the last non-digit and re-keys them as
 * `t<number>`, so `turn-3`, `t3` and `subturn-3` are all one turn). Keeping only
 * the number is what makes the prefix irrelevant here: `subturn-7` is turn 7,
 * not a second namespace.
 *
 * An id with no trailing digits, or no id at all, degrades to the documented
 * fallback `0` — the same "no turn known" value `meta.currentTurnId` starts at,
 * and a defined one rather than `NaN`. Never returns `NaN`.
 */
export function normalizeEngineTurnId(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (typeof raw !== 'string') return 0;
  const digits = /(\d+)$/.exec(raw)?.[1];
  if (digits === undefined) return 0;
  const parsed = Number.parseInt(digits, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

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
    swarmModeTrigger: 'manual' as const,
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
 * The api key a previous import from `url` parked on its providers' `source`
 * blob. The URL is the stable identity of "the same registry" — the key
 * commonly rotates between imports — so a re-import that omits `--api-key`
 * reuses this one instead of failing the fetch.
 */
function registryKeyFromExisting(
  providers: Record<string, unknown>,
  url: string,
): string | undefined {
  for (const provider of Object.values(providers)) {
    if (!isPlainObject(provider)) continue;
    const source = provider['source'];
    if (isPlainObject(source) && source['kind'] === 'apiJson' && source['url'] === url) {
      const key = source['apiKey'];
      if (typeof key === 'string' && key.length > 0) return key;
    }
  }
  return undefined;
}

function truncateUpstreamMessage(error: unknown, limit = 300): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** `undefined` clears the key rather than persisting an explicit null. */
function assignOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
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

/**
 * v2 keys a workspace trust record by the canonical root
 * (`trustRecord.trustKey`), so one directory matches however the caller spelled
 * it. Comparing the raw strings instead made a trusted workspace read as
 * untrusted — silently dropping the roots its `local.toml` asks for — whenever
 * the two spellings differed in separators or drive case.
 *
 * The key is the *real* path, not a normalized string: a symlink or junction
 * spelled one way today and another tomorrow names the same directory, and a
 * junction retargeted later would otherwise keep the trust its old target had.
 * `realpathSync.native` also collapses Windows' 8.3 short names, which are a
 * different string for the same directory.
 *
 * A path that cannot be resolved falls back to its absolute normalized form:
 * a workspace deleted after being trusted still has to match its stored entry
 * (and a missing path is never a *different* directory we would trust instead).
 */
function workspaceTrustKey(root: string): string {
  const absolute = resolve(root);
  let real: string;
  try {
    real = realpathSync.native(absolute);
  } catch {
    real = absolute;
  }
  const canonical = posixPath(real).replace(/\/+$/, '');
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * Whether an id is safe to use as one path segment under the sessions root.
 * Session ids are `session_<uuid>` or client-chosen names that become
 * directory names, so anything that could escape the root — or be silently
 * rewritten by the platform — is rejected before the first `join`:
 *
 * - separators and control characters are direct mangling vectors;
 * - `:` carries Windows meaning: `C:foo` is drive-relative (isAbsolute says
 *   no, the OS still honors the drive) and `foo:bar` names an NTFS
 *   alternate data stream instead of a directory;
 * - Win32 strips trailing dots and spaces per path component, so `.. `
 *   resolves back to `..` and `evil.` aliases `evil` — hence the all-dots
 *   and trailing-dot/space checks that exact `.`/`..` matching misses;
 * - absolute roots (`C:\x`, `\\server`, `/x`) are not segments at all.
 *
 * Deliberately a blacklist, not a `[A-Za-z0-9._-]` whitelist: ids are
 * persisted directory names, and an existing session with a non-ASCII id
 * must stay resumable, renamable, and deletable.
 */
function isSinglePathSegment(id: string): boolean {
  if (id.length === 0) return false;
  if (id.includes('/') || id.includes('\\')) return false;
  if (id.includes(':')) return false;
  // Code-point scan rather than a regex literal: `no-control-regex` flags
  // `[\u0000-\u001f]` patterns, and this loop reads as the intent.
  for (const ch of id) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  if (/^\.+$/.test(id)) return false;
  if (id.endsWith('.') || id.endsWith(' ')) return false;
  return !isAbsolute(id);
}

/**
 * Reject an id that would escape the sessions root once joined into a path.
 * Every RPC that turns a client-supplied session id into a path segment —
 * create, resume, rename, delete, export — funnels through here: the id
 * becomes a directory that is read, written, zipped, or recursively removed,
 * so a separator, a `..` segment, or an absolute root must fail before any
 * filesystem call rather than after it.
 */
function assertSessionIdSegment(id: string): void {
  if (!isSinglePathSegment(id)) {
    throw new KimiError(ErrorCodes.SESSION_ID_INVALID, `invalid session id "${id}"`, {
      details: { sessionId: id },
    });
  }
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

/**
 * One prompt-metadata record per submitted entry (prompt, steer, or skill
 * activation, v2 #3764), appended by {@link SDKRpcClientNative.applyPromptMetadata}
 * in submission order. `displayText` is the raw client string; `text` is what
 * the entry contributed to the session metadata — the sanitized `displayText`
 * when the caller supplied one, else the sanitized content-derived text
 * (`undefined` when that sanitizes to empty).
 */
/**
 * One `/skill:` activation as the engine resolved it: the rendered prompt plus
 * the provenance v2's `SkillActivationOrigin` carries, which the host was
 * previously inventing from a path guess (`source="project"` for every skill,
 * whether it was a builtin or an `extra_skill_dirs` entry).
 */
interface ResolvedSkillPrompt {
  readonly text: string;
  /** The catalog's name for it — not necessarily the requested one. */
  readonly name: string;
  readonly path?: string;
  readonly source?: SkillSource;
  readonly skillType?: string;
}

/** The `SkillSource` vocabulary the engine's scan emits. */
const SKILL_SOURCES: ReadonlySet<string> = new Set<SkillSource>([
  'project',
  'user',
  'extra',
  'builtin',
]);

/**
 * The wire shape of a prompt origin's `clientMetadata`: v2 carries an **array**
 * of per-submission entries, each with a `display_text`
 * (`contextMemory/types.ts:20`, consumed by `promptMetadataTextFromContentParts`).
 * The host's own `ClientPromptMetadata` is a single object with `displayText`,
 * and every consumer of the folded value — `transcript`'s
 * `projectTranscriptUserOrigin` and its `TranscriptUserOrigin` /
 * `schema.ts` types — is already written against the array. Emitting the object
 * therefore dropped every origin's metadata on the floor, silently.
 */
function originClientMetadata(
  clientMetadata: ClientPromptMetadata | undefined,
): PromptOriginMetadataEntry[] | undefined {
  const displayText = clientMetadata?.displayText;
  return typeof displayText === 'string' && displayText.length > 0
    ? [{ display_text: displayText }]
    : undefined;
}

interface NativePromptMetadataRecord {
  readonly text: string | undefined;
  readonly hasDisplayText: boolean;
  readonly displayText?: string;
}

/**
 * The #3764 displayText set judgment behind upstream's undo-label
 * (`undoService.reconcileLastPrompt`) and fork-title
 * (`forkTurnSlice.promptMetadataFromTurnRecord`) derivations: a derivation
 * may use the client displayTexts only when EVERY prompt entry provides one —
 * a single entry without `displayText` falls the whole derivation back to the
 * existing text-derived metadata, never a per-entry mix.
 *
 * The native SDK has no undo-label or fork-title decision points yet
 * (`undoHistory` truncates history without relabeling, `forkSession` takes its
 * title from the caller, `generateSessionTitle` delegates to the engine's own
 * title source), so this exported helper is the wiring seam for those
 * derivations: pass the session's `NativeSessionMeta.promptMetadata` records
 * in submission order and use the returned sanitized join. `undefined` has two
 * distinct causes, mirroring upstream (v2 `promptMetadataText.ts` +
 * `applyPromptMetadataUpdate`): a record without `displayText` (or an empty
 * set) falls the derivation back to the existing text-derived metadata, while
 * an all-`displayText` set whose sanitized join is empty (reachable with e.g.
 * every entry `displayText: ''`) means upstream applies NO metadata update at
 * all — a consumer must not fall back to text derivation there. The two are
 * told apart with `records.every((record) => record.hasDisplayText)` on the
 * records the caller already holds. Exported for that consumer and for tests;
 * `applyPromptMetadata` produces the records.
 */
export function displayTextForUndoOrForkLabel(
  records: readonly NativePromptMetadataRecord[],
): string | undefined {
  if (records.length === 0 || records.some((record) => !record.hasDisplayText)) {
    return undefined;
  }
  return promptMetadataTextFromText(
    records
      .map((record) => record.displayText)
      .filter((text): text is string => text !== undefined)
      .join('\n'),
  );
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
  {
    id: 'tower',
    title: 'Tower mode',
    description:
      'Enable tower mode: coordinate multiple agents on a shared objective, toggled with the /tower command.',
    // Must stay identical to the engine's `TOWER_ENV_SWITCH`
    // (`packages/kimi-agent/src/tools/tower/paths.rs`): the host flag and the
    // engine's advertised tool table read the same switch.
    env: 'KIMI_CODE_EXPERIMENTAL_TOWER',
    defaultEnabled: false,
    surface: 'both',
  },
  {
    id: 'xunfei_coding_plan',
    title: 'Astron (Xunfei coding plan)',
    description:
      'Show the Astron provider settings in /settings and enable the Astron login flow. The astron entry under [providers] stays functional regardless of this flag.',
    env: 'KIMI_CODE_EXPERIMENTAL_XUNFEI_CODING_PLAN',
    defaultEnabled: false,
    surface: 'both',
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
  /**
   * Per-entry prompt-metadata records in submission order (#3764), one per
   * prompt / steer / skill activation that carried metadata. Feeds the
   * displayText set judgment for undo-label / fork-title derivations
   * (`displayTextForUndoOrForkLabel`). In-memory only: the derivations it
   * serves run live, and the durable lastPrompt/title stay on
   * {@link PersistedSessionMeta}.
   */
  promptMetadata: NativePromptMetadataRecord[];
  /** User-layer session metadata (v2 `session.custom`), merged by updateSessionMetadata. */
  custom: Record<string, unknown>;
  /**
   * Workspace-level additional directories added via addAdditionalDir, or passed
   * by the host at create/resume. These are the caller's own choices, so they
   * are persisted with the session.
   */
  additionalDirs: string[];
  /**
   * Roots the *project* asked for through `workspace.additional_dir`, resolved
   * while the workspace is trusted (v2 `WorkspaceDirsService`'s `fileDirs`, as
   * opposed to its `ephemeralDirs`).
   *
   * Deliberately never persisted: the project's file is re-read on every
   * create/resume/rebuild, so revoking trust withdraws these roots instead of
   * leaving a session that still carries what the file said while it was
   * trusted. Keeping the two lists apart is also what keeps an untrusted
   * checkout from smuggling its file's roots in as "caller-requested" ones.
   */
  projectAdditionalDirs: string[];
  /**
   * Headless session (`kimi -p`): rides the policy snapshot to the engine,
   * which skips its `DangerousCommandAsk` policy for the session's turns.
   */
  nonInteractive: boolean;
  // Runtime agent state (re-derived from config on resume, not persisted): the
  // getters (getStatus / getUsage) read these; the setters that would change
  // them mid-session need an engine-handle rebuild and land with persistence.
  model: string | undefined;
  thinkingEffort: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  swarmMode: boolean;
  /**
   * Why the host opened swarm mode. `task` and `tool` swarms close themselves
   * at turn end, so the engine needs the distinction to decide whether the
   * turn's end is a mode change; `manual` survives it. Defaults to `manual`,
   * the only trigger v2's profile route uses.
   */
  swarmModeTrigger: SwarmModeTrigger;
  towerMode: boolean;
  maxContextTokens: number;
  contextTokens: number;
  usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number };
  goal: NativeGoalState | null;
  /** The active plan document handle (plan mode); content lives in the plan file. */
  plan: { id: string; content: string; path: string } | undefined;
  /** Source session id when this session was forked. */
  forkedFrom: string | undefined;
    /** Main-agent profile bound at create (`--agent`); undefined = engine default. */
  agentProfile?: string;
  /** Raw `--agent-file` paths; re-read on every handle build. */
  agentFiles?: readonly string[];
  activeAgentId?: string;
  handle?: EngineSessionHandle;
  /**
   * This session's own log sink. Attached when the session becomes live and
   * closed when it stops being live, so `<sessionDir>/logs/kimi-code.log`
   * exists for exactly as long as the session does.
   */
  logHandle?: SessionLogHandle;
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
  /** Headless session (upstream `nonInteractive`): skips the engine's dangerous-command ask policy. */
  nonInteractive?: boolean | undefined;
  /** Main-agent profile bound at first create (`--agent`); restored on resume. */
  agentProfile?: string | undefined;
  /** Raw `--agent-file` paths; re-read on every handle build. */
  agentFiles?: readonly string[] | undefined;
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

/**
 * The host executable when it can host plugin node entries itself, i.e. only
 * under the packaged single-file binary (`bun build --compile`, marked by the
 * bundled `__KIMI_BUN_ASSETS__` asset map). Source (`bun src/main.ts`) and
 * `node dist/main.mjs` runs answer `undefined`: there the declared
 * `command: "node"` spawns as-is, and a Node runtime is available by
 * construction (node-dist) or in every dev checkout (bun).
 */
function pluginNodeRunnerPath(): string | undefined {
  const view = globalThis as { Bun?: unknown; __KIMI_BUN_ASSETS__?: unknown };
  if (view.Bun === undefined || view.__KIMI_BUN_ASSETS__ === undefined) return undefined;
  return process.execPath;
}

/**
 * The manifest `agents` field of an installed plugin: one `./` directory or a
 * list of them (`docs/en/customization/plugins.md:282`). The engine's
 * `kimi.plugin.json` reader does not carry that key, so the manifest is read
 * here; an absent or unusable field falls back to the plugin root's `agents/`
 * directory, which is the documented auto-discovery.
 */
function manifestAgentPaths(info: PluginInfo): readonly string[] {
  const manifestPath =
    typeof info.manifestPath === 'string' && info.manifestPath.length > 0
      ? info.manifestPath
      : typeof info.root === 'string'
        ? join(info.root, 'kimi.plugin.json')
        : undefined;
  if (manifestPath === undefined) return [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return ['agents'];
  }
  const agents = (manifest as { agents?: unknown } | null)?.agents;
  const entries = typeof agents === 'string' ? [agents] : Array.isArray(agents) ? agents : [];
  const paths = entries.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
  return paths.length > 0 ? paths : ['agents'];
}

/**
 * Narrow an SDK trigger to the three the engine's swarm mode knows.
 *
 * The engine distinguishes `task` and `tool` (both close themselves at turn
 * end) from `manual` (which does not), so the distinction has to survive the
 * crossing. The SDK's type is wider than the engine's; `auto` and `system`
 * have no engine counterpart and mean the same thing to it as `manual` — the
 * mode stays open until the user leaves it.
 */
function engineSwarmTrigger(trigger: SwarmModeTrigger): 'manual' | 'task' | 'tool' {
  return trigger === 'task' || trigger === 'tool' ? trigger : 'manual';
}

/** One subagent recovered from a tool result during a resume. */
export interface DiscoveredSubagent {
  readonly agentId: string;
  readonly summary: string;
}

/**
 * Recover the subagents a finished `Agent` / `AgentSwarm` call left behind, by
 * reading the tool result the transcript kept.
 *
 * Two result shapes, and they do not overlap:
 *
 * - `Agent` → `formatForegroundAgentSuccess`, a plain-text envelope
 *   (`agent_id: …` / `[summary]`). Exactly one subagent.
 * - `AgentSwarm` → `renderSwarmResults`, an `<agent_swarm_result>` XML block
 *   whose members are `<subagent agent_id="…" …>body</subagent>`. **N**
 *   subagents, and the ids are `agent_id="…"` with an equals sign — the
 *   single-agent `agent_id:` pattern never matches, which is why a resumed
 *   swarm used to come back with no members at all and got redrawn as plain
 *   subagent cards.
 *
 * The `outcome` attribute is read but not filtered on: a failed or aborted
 * member is still a member the user was shown, and dropping it would leave a
 * hole in the restored conversation. The body is the member's own result text,
 * which is the same text the live swarm card showed.
 */
export function discoverSubagentsFromToolResult(content: string): DiscoveredSubagent[] {
  if (content.includes('<agent_swarm_result>')) {
    return parseSwarmResultMembers(content);
  }
  const agentIdMatch = /(?:^|\n)agent_id:\s*([^\s]+)\s*(?=\n|$)/.exec(content);
  if (!agentIdMatch) return [];
  const summaryMatch = /(?:^|\n)\[summary\]\n([\s\S]*)$/.exec(content);
  return [{ agentId: agentIdMatch[1]!, summary: summaryMatch ? summaryMatch[1]! : '' }];
}

function parseSwarmResultMembers(content: string): DiscoveredSubagent[] {
  const members: DiscoveredSubagent[] = [];
  const tag = /<subagent\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(content)) !== null) {
    const closeIndex = content.indexOf('</subagent>', tag.lastIndex);
    if (closeIndex < 0) break;
    const attrs = match[1] ?? '';
    const idMatch = /\bagent_id="([^"]*)"/.exec(attrs);
    if (idMatch && idMatch[1]) {
      members.push({
        agentId: idMatch[1],
        summary: content.slice(tag.lastIndex, closeIndex),
      });
    }
    tag.lastIndex = closeIndex + '</subagent>'.length;
  }
  return members;
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

  /**
   * Bind the session's log sink. Idempotent per meta, so a create followed by
   * a resume of the same id cannot raise the sink's reference count twice and
   * then leak it on the first close.
   */
  private attachSessionLog(meta: NativeSessionMeta): void {
    if (meta.logHandle !== undefined) return;
    meta.logHandle = getRootLogger().attachSession({
      sessionId: meta.id,
      sessionDir: meta.sessionDir,
    });
  }

  /** Release it; a failure to flush must not stop the session from closing. */
  private async detachSessionLog(meta: NativeSessionMeta): Promise<void> {
    const handle = meta.logHandle;
    meta.logHandle = undefined;
    if (handle === undefined) return;
    await handle.close().catch(() => {});
  }
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
    // A client-chosen id becomes the session directory name; reject anything
    // that is not a single path segment before it reaches join().
    if (input.id !== undefined) assertSessionIdSegment(input.id);
    // NOTE: ensurePluginStore is deliberately NOT called here. Opening the
    // registry takes a SQLite handle on `<engineDataDir>/sessions.db` that
    // Windows keeps locked until closePluginStore — a headless `kimi -p` run
    // that never touches the plugin surface must not leave the data dir
    // locked for its whole lifetime (the recorded upstream decision). The
    // race — a session created before any plugin API ran, missing plugin
    // MCP servers — is closed at the interactive host layer instead
    // (`kimi-tui.ts` sequences refreshPluginCommands before its session
    // prewarm), where the registry is opened on every launch regardless.
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
    const { explicit, project } = await this.resolveSessionAdditionalDirs(
      workDir,
      input.additionalDirs ?? [],
    );

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
      promptMetadata: [],
      custom: input.metadata !== undefined ? { ...input.metadata } : {},
      additionalDirs: explicit,
      projectAdditionalDirs: project,
      nonInteractive: input.nonInteractive === true,
      ...initialRuntimeState(config, input.model ?? config.defaultModel),
      plan: undefined,
      forkedFrom: undefined,
      agentProfile: input.agentProfile,
      agentFiles: input.agentFiles?.length ? [...input.agentFiles] : undefined,
    };
    if (input.thinking !== undefined) meta.thinkingEffort = input.thinking;
    if (input.permission !== undefined) meta.permissionMode = input.permission;
    this.liveSessions.set(sessionId, meta);
    this.attachSessionLog(meta);

    try {
      // An unresolvable `--agent` must fail loudly at creation: silently
      // starting the default agent looks like the flag was honoured.
      await this.assertAgentProfileResolves(meta);
      meta.handle = await this.buildHandle(meta);
    } catch (error) {
      // Do not leave a handle-less session advertised as live.
      this.liveSessions.delete(sessionId);
      await this.detachSessionLog(meta);
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
    // Re-read the project's roots on every build: the sandbox is constructed
    // from them here, so trusting or revoking the workspace takes effect on the
    // next handle build rather than needing a new session.
    await this.refreshProjectRoots(meta);
    const authorizedRoots = this.authorizedRoots(meta);
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
    // `[agent].multi_llm`: the concurrent-provider race. A non-empty list
    // outranks `nativeLlm` in the engine's LLM selection, so a configured race
    // is what the session runs. Throws `config.invalid` on an alias that cannot
    // resolve rather than silently racing fewer providers.
    const multiLlmProviders = resolveMultiLlmProviders(config, defaultHeaders);

    // 1-based LLM step counter for the current turn, reset by `turn.started`
    // in `turnEvent` below. The turn loop emits exactly one `llm.step.begin`
    // and one `llm.step.end` per step, both naming the turn and the step; the
    // host still counts on its own so the numbering stays contiguous if an
    // engine-side boundary is ever dropped.
    let stepSeq = 0;

    // Background tasks seen this handle. `event.task.completed` carries only
    // the id and status, so the create-time facts are remembered to fill the
    // terminal `background.task.terminated` info.
    const backgroundTasks = new Map<
      string,
      { description: string; kind: 'agent' | 'process'; startedAt: number; subagentType?: string }
    >();

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
        // Agent attribution, most reliable source first.
        //
        // The engine stamps `agent_id` on every event a subagent's turn emits
        // (see `ToolFilterCallbacks::emit_event` in
        // `kimi-agent/src/subagent/manager.rs`); the main agent's events carry
        // `"main"`. That stamp is authoritative.
        //
        // The `subturn-` prefix test below is a legacy fallback for events
        // that predate the stamp. It cannot stand in for it: it only ever
        // matches the turn-level `llm.delta` stream, and the subagent id it
        // resolves to is `meta.activeAgentId` — the *side channel's* currently
        // active agent, which is not the agent that emitted the event. With
        // `AgentSwarm` running several subagents at once they all share it, so
        // every subagent event was attributed to the same id; and tool events
        // (`tool.native`) do not carry a `subturn-` turn id at all, so they
        // fell through to `'main'` outright — a subagent's tool call was
        // announced as the main agent's and landed in the main transcript,
        // truncating the main agent's own reasoning. Prefer the stamp.
        const eventAgentId =
          typeof parsed.agent_id === 'string'
            ? parsed.agent_id
            : typeof parsed.turn_id === 'string' && parsed.turn_id.startsWith('subturn-')
              ? (meta.activeAgentId ?? 'main')
              : 'main';
        if (process.env['KIMI_DEBUG_AGENT_ID'] === '1') {
          console.error(
            `[agent-id] type=${String(parsed.type)} raw_agent_id=${JSON.stringify(parsed.agent_id)} turn_id=${JSON.stringify(parsed.turn_id)} -> ${eventAgentId}`,
          );
        }
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
          } else if (parsed.part?.type === 'tool_call' && typeof parsed.part.id === 'string') {
            // Tool-call argument fragments stream as `tool_call` parts
            // (`llm/wire.rs::StreamDelta::to_part`); without this arm the TUI
            // never saw the arguments being built.
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'tool.call.delta',
              turnId: meta.currentTurnId,
              toolCallId: parsed.part.id,
              ...(typeof parsed.part.arguments === 'string'
                ? { argumentsPart: parsed.part.arguments }
                : {}),
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
        } else if (parsed.type === 'llm.step.begin') {
          // Turn-loop step boundary (`run_turn`). The transport used to emit one
          // per chat *request*, which also counted compaction summarizer calls
          // and retry attempts — a `turn.step.started` with nothing to close it
          // and an ordinal that skipped ahead. Only the loop can name a step,
          // so only the loop's boundary reaches the host now. The protocol step
          // events drive the TUI's step counter and streaming phase; without
          // this arm the step display stayed at 0 for the whole turn.
          stepSeq += 1;
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
            type: 'turn.step.started',
            turnId: meta.currentTurnId,
            step: stepSeq,
          });
        } else if (parsed.type === 'llm.step.end') {
          // Two emitters send `llm.step.end`. The transport (llm/http.rs)
          // hands the host the assistant text plus `latency_ms` and names no
          // turn or step — it is what folds the message. The turn loop's
          // emission is the one that addresses a step, and carries the same
          // usage plus the v2 `ModelRequestTiming` breakdown that
          // `turn.step.completed` is specified to carry. Mapping both gave
          // every step a second `turn.step.completed` with the same turnId,
          // step and usage, so the TUI counted the same token usage twice
          // and a `filtered` finish was announced twice. Only the addressed
          // one maps; the transport's stays the engine's own message fold.
          if (parsed.turn_id !== undefined || parsed.step !== undefined) {
            const usage = toTokenUsage(parsed.usage);
            const timing = parsed.timing as
              | {
                  firstTokenLatencyMs?: number;
                  requestBuildMs?: number;
                  serverFirstTokenMs?: number;
                  streamDurationMs?: number;
                }
              | null
              | undefined;
            const numberFrom = (value: unknown): number | undefined =>
              typeof value === 'number' ? value : undefined;
            const firstTokenLatencyMs = numberFrom(timing?.firstTokenLatencyMs);
            const streamDurationMs = numberFrom(timing?.streamDurationMs);
            const requestBuildMs = numberFrom(timing?.requestBuildMs);
            const serverFirstTokenMs = numberFrom(timing?.serverFirstTokenMs);
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'turn.step.completed',
              turnId: meta.currentTurnId,
              step: stepSeq,
              ...(usage !== undefined ? { usage } : {}),
              ...(typeof parsed.finish_reason === 'string'
                ? { finishReason: parsed.finish_reason }
                : {}),
              ...(firstTokenLatencyMs !== undefined
                ? { llmFirstTokenLatencyMs: firstTokenLatencyMs }
                : {}),
              ...(streamDurationMs !== undefined ? { llmStreamDurationMs: streamDurationMs } : {}),
              ...(requestBuildMs !== undefined ? { llmRequestBuildMs: requestBuildMs } : {}),
              ...(serverFirstTokenMs !== undefined
                ? { llmServerFirstTokenMs: serverFirstTokenMs }
                : {}),
            });
          }
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
            // Forward the spawn itself too: the TUI creates the subagent card
            // from it, and the meta write above is host bookkeeping only.
            // `swarm_index` is what distinguishes a swarm member from a plain
            // child (v2 `coreEventMap.ts:1110-1117` reads it to pick the
            // `member` role), and the engine emits it — dropping it here is
            // what made every swarm member render as an ordinary subagent.
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'subagent.spawned',
              subagentId: parsed.subagent_id,
              subagentName: String(parsed.subagent_name ?? ''),
              parentToolCallId: String(parsed.parent_tool_call_id ?? ''),
              runInBackground: parsed.run_in_background === true,
              ...(typeof parsed.swarm_index === 'number'
                ? { swarmIndex: parsed.swarm_index }
                : {}),
              ...(typeof parsed.description === 'string'
                ? { description: parsed.description }
                : {}),
            });
          }
        } else if (parsed.type === 'subagent.started') {
          if (typeof parsed.subagent_id === 'string') {
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'subagent.started',
              subagentId: parsed.subagent_id,
            });
          }
        } else if (parsed.type === 'subagent.suspended') {
          // A swarm member the engine requeued after a provider rate limit. It
          // is neither running nor failed, so without this arm the TUI's
          // swarm progress row keeps showing it as running until the retry
          // lands (or never).
          if (typeof parsed.subagent_id === 'string') {
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'subagent.suspended',
              subagentId: parsed.subagent_id,
              reason: String(parsed.reason ?? ''),
              ...(typeof parsed.parent_tool_call_id === 'string'
                ? { parentToolCallId: parsed.parent_tool_call_id }
                : {}),
            });
          }
        } else if (parsed.type === 'swarm_mode.enter' || parsed.type === 'swarm_mode.exit') {
          // The engine owns the mode and announces both edges. Fold it into
          // `meta` so the next handle rebuild re-sends the mode the engine
          // actually has: an auto-exited `task` swarm must not be resurrected by
          // a stale `swarmMode: true`.
          const active = parsed.type === 'swarm_mode.enter';
          if (meta.swarmMode !== active) {
            meta.swarmMode = active;
            this.persistMeta(meta);
          }
        } else if (parsed.type === 'agent.status.updated') {
          // The engine's edge-triggered mode notifications (`swarmMode`
          // without the other status fields). Fold the mode and forward the
          // event so the TUI can clear its indicator and render the "ended"
          // marker for a `task` swarm; a mode the host only tracks itself
          // never reports its own end.
          if (typeof parsed.swarmMode === 'boolean' && meta.swarmMode !== parsed.swarmMode) {
            meta.swarmMode = parsed.swarmMode;
            if (!parsed.swarmMode) meta.swarmModeTrigger = 'manual';
            this.persistMeta(meta);
          }
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
            type: 'agent.status.updated',
            ...(typeof parsed.swarmMode === 'boolean' ? { swarmMode: parsed.swarmMode } : {}),
          });
        } else if (parsed.type === 'subagent.completed') {
          if (typeof parsed.subagent_id === 'string') {
            const usage = toTokenUsage(parsed.usage);
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'subagent.completed',
              subagentId: parsed.subagent_id,
              resultSummary: String(parsed.result_summary ?? ''),
              ...(usage !== undefined ? { usage } : {}),
            });
          }
        } else if (parsed.type === 'subagent.failed') {
          if (typeof parsed.subagent_id === 'string') {
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'subagent.failed',
              subagentId: parsed.subagent_id,
              error: String(parsed.error ?? ''),
            });
          }
        } else if (parsed.type === 'subagent.cancelled') {
          if (typeof parsed.subagent_id === 'string') {
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'subagent.cancelled',
              subagentId: parsed.subagent_id,
            });
          }
        } else if (parsed.type === 'event.task.created') {
          // The engine's per-pipeline task runner reports its lifecycle here
          // (the napi pipeline wires its sink to the host callbacks). The TUI
          // consumes the protocol `background.task.*` spelling, so map it: the
          // engine's `subagent` kind is the protocol's `agent`, everything else
          // (bash / tool) is a `process`.
          const task = parsed.task as Record<string, unknown> | undefined;
          if (task !== undefined && typeof task['id'] === 'string') {
            const kind = task['kind'] === 'subagent' ? 'agent' : 'process';
            const startedAt =
              (typeof task['started_at'] === 'string'
                ? Date.parse(task['started_at'])
                : Number.NaN) || Date.now();
            const description =
              typeof task['description'] === 'string' ? task['description'] : '';
            const subagentType =
              typeof task['subagent_type'] === 'string' ? task['subagent_type'] : undefined;
            backgroundTasks.set(task['id'], {
              description,
              kind,
              startedAt,
              ...(subagentType !== undefined ? { subagentType } : {}),
            });
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'background.task.started',
              // The Rust runner does not own the process, so it carries no
              // `command` / `pid`; no consumer of this event reads them (the
              // task browser pulls `listBackgroundTasks` for the full row).
              info: {
                taskId: task['id'],
                description,
                status: 'running',
                kind,
                startedAt,
                endedAt: null,
                detached: true,
                ...(subagentType !== undefined ? { subagentType } : {}),
                // Agent tasks use the agent id as their task id
                // (`subagent/manager.rs` spawns with `id`), so this is the id
                // the TUI's detach path matches on.
                ...(kind === 'agent' ? { agentId: task['id'] } : {}),
              } as unknown as TaskInfo,
            });
          }
        } else if (parsed.type === 'event.task.completed') {
          const taskId = typeof parsed.task_id === 'string' ? parsed.task_id : undefined;
          if (taskId !== undefined) {
            const prior = backgroundTasks.get(taskId);
            backgroundTasks.delete(taskId);
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'background.task.terminated',
              info: {
                taskId,
                description: prior?.description ?? '',
                status: parsed.status as TaskInfo['status'],
                kind: prior?.kind ?? 'process',
                startedAt: prior?.startedAt ?? Date.now(),
                endedAt: Date.now(),
                detached: true,
                ...(prior?.subagentType !== undefined
                  ? { subagentType: prior.subagentType }
                  : {}),
                ...(prior?.kind === 'agent' ? { agentId: taskId } : {}),
              } as unknown as TaskInfo,
            });
          }
        } else if (parsed.type === 'compaction.started') {
          // The turn loop's automatic compaction (v2 `compaction.started`).
          // The host adds the session id; the manual `/compact` path emits its
          // own events directly, so there is no double emit.
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
            type: 'compaction.started',
            trigger: parsed.trigger === 'manual' ? 'manual' : 'auto',
            ...(typeof parsed.instruction === 'string'
              ? { instruction: parsed.instruction }
              : {}),
          });
        } else if (parsed.type === 'compaction.completed') {
          const result = parsed.result as Record<string, unknown> | undefined;
          if (result !== undefined) {
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'compaction.completed',
              result: {
                summary: typeof result['summary'] === 'string' ? result['summary'] : '',
                compactedCount: Number(result['compactedCount'] ?? 0),
                tokensBefore: Number(result['tokensBefore'] ?? 0),
                tokensAfter: Number(result['tokensAfter'] ?? 0),
              },
            });
          }
        } else if (parsed.type === 'compaction.cancelled') {
          this.receiveEvent({ sessionId, agentId: eventAgentId, type: 'compaction.cancelled' });
        } else if (parsed.type === 'hook.result') {
          // The hook guard's stdout + verdict, surfaced so the transcript can
          // show what the user's hook said (v2 `hook.result`).
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
            type: 'hook.result',
            turnId: meta.currentTurnId,
            hookEvent: String(parsed.hookEvent ?? ''),
            content: String(parsed.content ?? ''),
            ...(parsed.blocked === true ? { blocked: true } : {}),
          });
        } else if (parsed.type === 'cron.fired') {
          // The session-owned cron dispatcher: a due job publishes this (for
          // the TUI's cron card) and enqueues its own `<cron-fire>` turn.
          const origin = parsed.origin as Record<string, unknown> | undefined;
          if (origin !== undefined) {
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'cron.fired',
              origin: origin as unknown as CronJobOrigin,
              prompt: String(parsed.prompt ?? ''),
            });
          }
        } else if (parsed.type === 'mcp.server.status') {
          // The MCP manager starts its connects in the background, so a server
          // that is still `pending` when the session is created only ever
          // reaches the UI through this transition (v2 `McpServerStatus`,
          // agent-core-v2 `agent/mcp/mcpService.ts:168-180`). The TUI resolves
          // its startup status spinner from it.
          const server = parsed.server as Record<string, unknown> | undefined;
          if (server !== undefined && typeof server['name'] === 'string') {
            const rawTransport = server['transport'];
            const transport =
              rawTransport === 'http' || rawTransport === 'sse' ? rawTransport : 'stdio';
            this.receiveEvent({
              sessionId,
              agentId: eventAgentId,
              type: 'mcp.server.status',
              server: {
                name: server['name'],
                transport,
                status: server['status'] as
                  | 'pending'
                  | 'connected'
                  | 'failed'
                  | 'disabled'
                  | 'needs-auth'
                  | 'removed',
                toolCount: typeof server['toolCount'] === 'number' ? server['toolCount'] : 0,
                ...(typeof server['error'] === 'string' ? { error: server['error'] } : {}),
              },
            });
          }
        } else if (parsed.type === 'skill.activated') {
          // The engine's native Skill tool records model-tool activations (v2
          // `SkillTool.execution`): forward the same fields the host-side
          // user-slash activation sends.
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
            type: 'skill.activated',
            activationId: String(parsed.activationId ?? ''),
            skillName: String(parsed.skillName ?? ''),
            ...(typeof parsed.skillArgs === 'string' && parsed.skillArgs.length > 0
              ? { skillArgs: parsed.skillArgs }
              : {}),
            trigger: parsed.trigger === 'nested-skill' ? 'nested-skill' : 'model-tool',
            ...(typeof parsed.skillPath === 'string' ? { skillPath: parsed.skillPath } : {}),
            ...(typeof parsed.skillSource === 'string'
              ? { skillSource: parsed.skillSource }
              : {}),
          });
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
      telemetry: (eventJson: string) => {
        // The engine's turn telemetry (M1c): `turn_started` / `turn_ended` /
        // `turn_interrupted`, the host-injected context below merged with the
        // engine-observed outcome (reason / duration_ms / steps / trace_id).
        // v2's loopService emits the same events through its telemetry
        // service; forwarding them under the engine's event name keeps that
        // contract. The payload's `event` field is the name, the rest are the
        // properties.
        let parsed: unknown;
        try {
          parsed = JSON.parse(eventJson);
        } catch {
          return;
        }
        if (typeof parsed !== 'object' || parsed === null) return;
        const { event: name, ...rest } = parsed as Record<string, unknown>;
        if (typeof name !== 'string' || name.length === 0) return;
        // Only primitives ride the wire (the telemetry client drops the rest
        // anyway); the engine's payload is all strings and numbers.
        const properties: Record<string, boolean | number | string | undefined | null> = {};
        for (const [key, value] of Object.entries(rest)) {
            if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
                properties[key] = value;
            }
        }
        this.telemetry.track(name, properties);
      },
      checkPermission: async (req: string) => {
        try {
          const parsed = JSON.parse(req) as {
            tool_call_id?: string;
            tool_name?: string;
            action?: string;
            display?: ToolInputDisplay;
            reason?: string;
          };
          const res = await this.requestApproval({
            sessionId,
            agentId: 'main',
            toolCallId: parsed.tool_call_id ?? randomUUID(),
            action: parsed.action ?? 'execute',
            toolName: parsed.tool_name ?? 'unknown',
            display: parsed.display ?? { kind: 'command', command: parsed.tool_name ?? 'action' },
            // The engine's policy-specific explanation, already localized. Passed
            // through so the prompt can say why it is asking rather than only
            // naming the tool; omitted when the engine has nothing to add.
            ...(typeof parsed.reason === 'string' && parsed.reason.length > 0
              ? { reason: parsed.reason }
              : {}),
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
        const turnId = normalizeEngineTurnId(rawTurnId);
        if (parsed.type === 'turn.started') {
          meta.currentTurnId = turnId;
          // New turn: restart the synthesized LLM step counter.
          stepSeq = 0;
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
            type: 'turn.started',
            turnId,
            // The engine echoes the turn request's origin (v2 `PromptOrigin`
            // JSON): a user-slash skill activation carries the
            // `skill_activation` variant (v2 #3832), everything else `user`.
            // Forwarding it — rather than assuming `user` — is what lets an
            // origin-aware consumer (the survey gate, the transcript fold)
            // tell an activation turn from a typed one.
            origin: (parsed.origin as PromptOrigin | undefined) ?? { kind: 'user' },
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
            // v2 #3907: the survey payload ties a rating to the exact turn via
            // this id (engine-minted `turn-<id>`).
            ...(parsed.trace_id ? { traceId: parsed.trace_id } : {}),
          });
          meta.activeAgentId = undefined;
        } else if (parsed.type === 'turn.cancel') {
          // v2 `TurnCancel`. A turn cancelled while still queued never starts,
          // so it emits **no** `turn.ended` — this is the only terminal signal
          // a client ever gets for it. Dropping it here (the old behaviour)
          // left the busy indicator and the composer stuck forever.
          const target =
            parsed.target === 'active' || parsed.target === 'queued'
              ? (parsed.target as 'active' | 'queued')
              : undefined;
          const reason =
            parsed.reason === 'user_cancelled' || parsed.reason === 'aborted'
              ? (parsed.reason as 'user_cancelled' | 'aborted')
              : undefined;
          this.receiveEvent({
            sessionId,
            agentId: eventAgentId,
            type: 'turn.cancel',
            ...(parsed.turnId !== undefined || parsed.turn_id !== undefined
              ? { turnId }
              : {}),
            ...(target !== undefined ? { target } : {}),
            ...(reason !== undefined ? { reason } : {}),
          });
        }
        // Unknown turn events are dropped (see emitEvent).
      },
    };

    // The `[secondary_model]` pool is always on (0.42.0 promoted the
    // experiment). It rides the session params as JSON; a malformed section
    // throws here, so the session fails at startup naming the offending alias.
    const secondaryModel = resolveSecondaryModelPool(config, true, process.env, defaultHeaders);
    const policySnapshot = buildPolicySnapshot(config, workDir);
    // The session's live permission mode overrides the config-derived snapshot
    // default: setPermission mutates meta, and a rebuild must reflect the
    // current mode. Plan mode is deliberately NOT folded in — it is not a
    // permission mode. v2's `PermissionMode` is `manual | yolo | auto`
    // (`agent/permissionPolicy/types.ts`) and `plan` is not even in the config
    // schema (`DefaultPermissionModeSchema`), because plan mode is a tool guard
    // of its own: `AgentPlanService.guardToolExecution` vetoes the writes that
    // are not the plan file. The engine runs that guard too, against the live
    // plan state (the plan-mode reminder says it outright: "Bash follows the
    // normal permission mode and rules"). Sending `plan` as a permission mode
    // made the engine degrade to its manual default, so a yolo session in plan
    // mode asked for every Bash command — a plan-mode toggle or any handle
    // rebuild (setThinking / setModel / additionalDirs) turned yolo off.
    policySnapshot.mode = meta.permissionMode;
    // A headless session (upstream `nonInteractive`) drops the engine's
    // dangerous-command ask policy — there is no human to answer it.
    if (meta.nonInteractive) {
      policySnapshot.non_interactive = true;
    }
    const githubCreds = resolveGithubCredentials(config);
    const mcpConfig = this.loadGlobalMcpConfig();
    const mcpServers = resolveMcpServersForEngine(mcpConfig);
    const subagentTimeoutMs = resolveSubagentTimeoutMs(config);
    const swarmTimeoutMs = resolveSwarmTimeoutMs(config);
    const maxAttempts = resolveMaxAttemptsPerStep(config);
    const compactionMaxAttempts = resolveCompactionMaxAttempts(config);
    const maxSteps = resolveMaxStepsPerTurn(config);
    const webSearch = resolveWebSearchService(config);
    const webFetch = resolveWebFetchService(config);
    const bingApi = resolveBingApiService(config);
    const imageReadByteBudget = resolveImageReadByteBudget(config);
    const imageMaxEdgePx = resolveImageMaxEdgePx(config);
    const modelCapabilities = resolveModelCapabilities(config, meta.model);
    // Progressive tool disclosure (v2 `toolSelectService.enabled()`): the
    // flag alone is not enough — the advertised table is only shaped when the
    // model also declares `dynamically_loaded_tools`, but the flag is what
    // the engine's gate reads.
    const toolSelect = isExperimentalFlagEnabled(config, 'tool_select');
    // The engine gates the advertised Tower* tool table on this and falls back
    // to its own bare env probe when it is absent — which never sees
    // `[experimental].tower`. Passing the host-resolved flag makes the config
    // key (and the master switch) reach the engine, same as tool_select.
    const towerEnabled = isExperimentalFlagEnabled(config, 'tower');
    const background = resolveBackgroundLimits(config);
    // Print mode (`kimi -p`): the host resolves only which `[background]`
    // values apply — the engine owns the settle behavior.
    const printBackground = resolvePrintBackground(config);
    // Agent-file discovery is host-side by design: the engine declares
    // `extra_agent_dirs` but never reads it (kimi-agent/src/config/mod.rs:588),
    // so which files exist and which scope wins is resolved here.
    const agentProfiles = await this.resolveSessionAgentProfiles(meta);
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
      // Empty means "let the engine build `prompt/system.md` for this
      // workspace" — AGENTS.md cascade, skills catalog, environment listing,
      // profile role. A host-owned prompt only ever arrives through
      // `native_llm.systemPrompt` (`[models.<alias>].systemPrompt`), which the
      // engine prefers anyway. The one-line stub that used to sit here reached
      // `messages[0]` verbatim and silently dropped all of it.
      systemPrompt: '',
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
      additionalDirs: authorizedRoots.length > 0 ? [...authorizedRoots] : undefined,
      shellPath,
      policySnapshotJson: JSON.stringify(policySnapshot),
      secondaryModelJson:
        secondaryModel === undefined ? undefined : JSON.stringify(secondaryModel),
      // Host-resolved config knobs (env > config, see native-llm-resolver).
      // `?? undefined` (never null): napi Option fields reject null.
      subagentTimeoutMs: subagentTimeoutMs ?? undefined,
      swarmTimeoutMs: swarmTimeoutMs ?? undefined,
      // The swarm mode the engine should be in for this handle's turns. The
      // engine owns the mode (its `swarm_mode` reminder and the turn-end
      // auto-exit read it), so this is the only way a `/swarm` toggle reaches
      // it over napi. `undefined` leaves it alone; `false` exits it.
      swarmMode: meta.swarmMode,
      swarmModeTrigger: meta.swarmMode ? engineSwarmTrigger(meta.swarmModeTrigger) : undefined,
      maxAttempts: maxAttempts ?? undefined,
      compactionMaxAttempts: compactionMaxAttempts ?? undefined,
      // The window `should_compact` compares history against, resolved for
      // *this session's* model — not `config.defaultModel`, which a session
      // switched with `/model` never matches. Without it the engine falls back
      // to its own 128k default and compacts a 1M-window model at ~81k tokens
      // (`128*1024 - 50_000` reserved). `[models.*].maxInputSize` still wins
      // inside `compaction_window`, matching v2's `max_input_tokens ??
      // max_context_tokens`. 0 (no declared window) means "engine default".
      maxContextTokens: resolveModelContextWindow(config, modelAlias) || undefined,
      maxSteps: maxSteps ?? undefined,
      webSearch: webSearch ?? undefined,
      webFetch: webFetch ?? undefined,
      bingApi: bingApi ?? undefined,
      imageReadByteBudget: imageReadByteBudget ?? undefined,
      imageMaxEdgePx: imageMaxEdgePx ?? undefined,
      modelCapabilities: modelCapabilities ?? undefined,
      toolSelect,
      towerEnabled,
      // Session profile catalog snapshot (P46): the native `Agent` tool spawns
      // only profiles registered here; without it every `Agent` call falls
      // back to the host, which has no tool runtime on this transport.
      subagentProfiles: agentProfiles.length > 0 ? [...agentProfiles] : undefined,
      // The concurrent-provider race (`[agent].multi_llm`). Non-empty outranks
      // `nativeLlm` in the engine's LLM selection.
      providers: multiLlmProviders ? [...multiLlmProviders] : undefined,
      // Main-agent profile (`--agent` / `--agent-file`): shapes the session's
      // own system prompt (`${role_additional}` + tool allowance), which is a
      // different consumer from `subagentProfiles` above.
      agentProfile: meta.agentProfile ?? undefined,
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
      // M1c turn telemetry: the host knows the model configuration, the
      // engine contributes the outcome fields and emits turn_started /
      // turn_ended / turn_interrupted through the telemetry callback (v2's
      // loopService owns the same events).
      // `enabled_plugins` is deliberately absent: the only source is the
      // engine's plugin registry, and reading it here would open that
      // SQLite store at every session creation (`ensurePluginStore`) —
      // a behavior change that also locks the data directory for the
      // session's lifetime. v2's semantics for a host without a plugin
      // snapshot is exactly this: the field stays absent. The toggle-time
      // set still rides the `plugin_toggle` event, which reads the
      // registry on demand.
      telemetry: {
        mode: meta.planMode ? 'plan' : 'agent',
        providerType: providerTypeForAlias(config, modelAlias),
        protocol: nativeLlm?.protocol ?? '',
        thinkingEffort: meta.thinkingEffort,
      },
    };

    return EngineSessionHandle.create(params, { ...callbacks, authToken });
  }

  override async resumeSession(input: ResumeSessionInput): Promise<ResumedSessionSummary> {
    const sessionId = input.id;
    assertSessionIdSegment(sessionId);
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
      const workDir =
        persisted?.workDir ?? normalizeRequiredWorkDir('resumeSession', process.cwd());
      // Only the caller's own roots come back from the session file; the
      // project's are re-read under the *current* trust state, so a workspace
      // that lost trust stops contributing them.
      const { explicit, project } = await this.resolveSessionAdditionalDirs(workDir, [
        ...(persisted?.additionalDirs ?? []),
        ...(input.additionalDirs ?? []),
      ]);
      const created: NativeSessionMeta = {
        id: sessionId,
        workDir,
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
        promptMetadata: [],
        custom: persisted?.custom ?? {},
        additionalDirs: explicit,
        projectAdditionalDirs: project,
        nonInteractive: persisted?.nonInteractive ?? false,
        model: persisted?.model ?? config.defaultModel,
        thinkingEffort: persisted?.thinkingEffort ?? defaults.thinkingEffort,
        permissionMode: persisted?.permissionMode ?? defaults.permissionMode,
        planMode: persisted?.planMode ?? false,
        swarmMode: false,
        swarmModeTrigger: 'manual',
        towerMode: false,
        maxContextTokens: resolveModelContextWindow(config, config.defaultModel),
        contextTokens: persisted?.contextTokens ?? 0,
        usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
        goal: persisted?.goal ?? null,
        plan: persisted?.plan,
        forkedFrom: persisted?.forkedFrom,
        agents: persisted?.agents,
        // The agent binding is the session's identity, fixed at its first
        // bind: resume restores it and ignores a differing requested profile
        // (`docs/en/customization/agents.md:143`).
        agentProfile: persisted?.agentProfile,
        agentFiles: persisted?.agentFiles,
      };
      meta = created;
      this.liveSessions.set(sessionId, created);
      this.attachSessionLog(created);
      // A binding is validated at first create; on resume it is restored, not
      // re-litigated. A profile whose file has since been deleted warns and
      // falls back to the engine default rather than bricking the session.
      try {
        await this.assertAgentProfileResolves(created);
      } catch (error) {
        log.warn(
          `resuming session "${sessionId}" with an unresolvable agent profile; using the default`,
          { error: error instanceof Error ? error.message : String(error) },
        );
        delete created.agentProfile;
      }
      created.handle = await this.buildHandle(created);
      const history = this.readPersistedHistory(created);
      if (history.length > 0) {
        await created.handle.setHistory(history);
        created.messageCount = history.length;
      }
    } else if (input.additionalDirs !== undefined && input.additionalDirs.length > 0) {
      // A live session still honors a resume that carries roots: the caller's
      // list (plus the project's, when trusted) is authorized the same way
      // `/add-dir` authorizes one, handle rebuild included.
      await this.authorizeAdditionalDirs(meta, input.additionalDirs);
    }
    return this.resumedSessionSummary(meta, input);
  }

  /**
   * v2 `WorkspaceDirsService`: a session's extra roots are the roots the caller
   * asked for (`ephemeralDirs`) plus the project's `workspace.additional_dir`
   * (`fileDirs`), and the project's half is gated on workspace trust — an
   * untrusted checkout cannot widen its own sandbox with a file it ships.
   *
   * The two halves stay in separate fields (v2 keeps the same split) so the
   * project half is re-derived on every create/resume/rebuild and never
   * persists: revoking trust withdraws it, and it can never be handed back to
   * the engine as if the caller had asked for it.
   *
   * The caller's own roots go through the same resolver the project file uses,
   * so `~`, relative paths, missing directories and broad-scope roots are judged
   * once, at the workspace, before anything is authorized (v2
   * `mergeAdditionalDirs` → `resolveAdditionalDirs`).
   */
  private async resolveSessionAdditionalDirs(
    workDir: string,
    requested: readonly string[],
  ): Promise<{ explicit: string[]; project: string[] }> {
    const explicit = await this.resolveCallerDirs(workDir, requested);
    const { trusted } = await this.getWorkspaceTrustInfo(workDir);
    if (!trusted) return { explicit, project: [] };
    try {
      const { additionalDirs } = await readAdditionalDirs(workDir);
      return { explicit, project: [...additionalDirs] };
    } catch (error) {
      log.warn('ignoring the project-local config of an unreadable workspace', {
        workDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return { explicit, project: [] };
    }
  }

  /**
   * The caller's roots, resolved against the workspace. One unusable entry is
   * reported and skipped rather than taking the whole session's roots with it:
   * a stale `/add-dir` from an earlier session must not block starting work.
   */
  private async resolveCallerDirs(
    workDir: string,
    requested: readonly string[],
  ): Promise<string[]> {
    const resolved: string[] = [];
    for (const dir of requested) {
      try {
        for (const one of await resolveAdditionalDirs(workDir, [dir])) {
          if (!resolved.includes(one)) resolved.push(one);
        }
      } catch (error) {
        log.warn('ignoring an additional directory that cannot be authorized', {
          workDir,
          dir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return resolved;
  }

  /**
   * Every root the engine is authorized for: the caller's, then the project's.
   */
  private authorizedRoots(meta: NativeSessionMeta): string[] {
    return [...new Set([...meta.additionalDirs, ...meta.projectAdditionalDirs])];
  }

  /**
   * Authorize `requested` roots for a live session, rebuilding the engine
   * handle so the sandbox and the directory listing both see them. A failed
   * rebuild leaves the previous roots in place.
   */
  private async authorizeAdditionalDirs(
    meta: NativeSessionMeta,
    requested: readonly string[],
  ): Promise<void> {
    const previous = meta.additionalDirs;
    // Only the caller's own roots are authorized here; the project's half is
    // re-read by `buildHandle` so a trust change takes effect on the rebuild.
    const { explicit } = await this.resolveSessionAdditionalDirs(meta.workDir, [
      ...previous,
      ...requested,
    ]);
    if (explicit.length === previous.length) return;
    meta.additionalDirs = explicit;
    await this.refreshProjectRoots(meta);
    try {
      await this.rebuildHandle(meta);
    } catch (error) {
      meta.additionalDirs = previous;
      throw error;
    }
    // `rebuildHandle` already stamped `meta.updatedAt`.
    this.persistMeta(meta);
  }

  /**
   * Re-derive the project's roots for `meta` from the current trust state.
   * Called before every handle build, so trusting or revoking a workspace
   * takes effect without recreating the session.
   */
  private async refreshProjectRoots(meta: NativeSessionMeta): Promise<void> {
    const { project } = await this.resolveSessionAdditionalDirs(meta.workDir, []);
    meta.projectAdditionalDirs = project;
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
        for (const found of discoverSubagentsFromToolResult(content)) {
          sessionAgentsRoster[found.agentId] = {
            homedir: meta.workDir,
            type: 'sub',
            parentAgentId: 'main',
          };
          discoveredSubagents.set(found.agentId, {
            type: 'sub',
            prompt: callInfo.prompt,
            summary: found.summary,
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
      // What the session authorizes, which includes the project's roots while
      // the workspace is trusted (v2 reports `fileDirs ∪ ephemeralDirs`).
      additionalDirs: this.authorizedRoots(meta),
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
    assertSessionIdSegment(input.id);
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
    // v2 resolves the argument against the workspace before it is stored, so
    // the session and the file agree on one spelling of the same directory —
    // and so `~`, a relative path, a missing directory or a broad-scope root
    // is rejected here rather than authorized. Resolution either yields exactly
    // one path or throws, so the fallback is unreachable.
    const [resolvedPath] = await resolveAdditionalDirs(meta.workDir, [input.path]);
    const path = resolvedPath ?? input.path;
    const changed = !meta.additionalDirs.includes(path);
    if (changed) {
      // The extra roots are baked into the engine handle at build time — the
      // native toolset's sandbox is constructed from them — so a newly
      // authorized directory only takes effect after a rebuild. Same contract as
      // setModel / setPermission: carry the history over, and drop the root
      // again when the rebuild fails.
      const previous = meta.additionalDirs;
      meta.additionalDirs = [...previous, path];
      try {
        await this.rebuildHandle(meta);
      } catch (error) {
        meta.additionalDirs = previous;
        throw error;
      }
      // `rebuildHandle` already stamped `meta.updatedAt`.
      this.persistMeta(meta);
    }
    // `persist` writes the root into the project's `.kimi-code/local.toml`, so
    // every later session of this checkout starts with it — the promise
    // `docs/*/configuration/config-files.md` makes for "remember this
    // directory". The write comes *after* the rebuild: a rebuild that failed
    // must not leave a remembered directory behind that no session authorizes.
    const persisted = input.persist === true
      ? await appendAdditionalDir(meta.workDir, path)
      : undefined;
    // What this session actually authorizes, never what the file happens to
    // list: an untrusted checkout's `local.toml` is not the caller's business,
    // and its entries must not travel back as if they had been requested here
    // (they would return as "explicit" roots on the next session).
    const additionalDirs = [...new Set([...this.authorizedRoots(meta), ...meta.additionalDirs])];
    return {
      additionalDirs,
      projectRoot: persisted?.projectRoot ?? meta.workDir,
      configPath: persisted?.configPath ?? this.configPath,
      persisted: persisted !== undefined,
    };
  }

  override async listSessions(
    input: ListSessionsOptions = {},
  ): Promise<readonly SessionSummary[]> {
    const workDir =
      input.workDir === undefined ? undefined : normalizeRequiredWorkDir('listSessions', input.workDir);
    const sessionsMap = new Map<string, SessionSummary>();
    // The project's roots are per workspace, not per session: read them once per
    // distinct work dir instead of once per session, and never persist them —
    // a stored copy would keep authorizing a workspace that lost trust.
    const storedMetas: PersistedSessionMeta[] = [];
    if (existsSync(this.sessionBaseDir)) {
      try {
        const dirs = readdirSync(this.sessionBaseDir, { withFileTypes: true });
        for (const dir of dirs) {
          if (!dir.isDirectory()) continue;
          const meta = this.loadMeta(join(this.sessionBaseDir, dir.name));
          if (meta !== undefined) storedMetas.push(meta);
        }
      } catch {
        // ignore
      }
    }
    const projectRootsByWorkDir = new Map<string, string[]>();
    for (const meta of storedMetas) {
      if (projectRootsByWorkDir.has(meta.workDir)) continue;
      const { project } = await this.resolveSessionAdditionalDirs(meta.workDir, []);
      projectRootsByWorkDir.set(meta.workDir, project);
    }
    for (const meta of storedMetas) {
      sessionsMap.set(meta.id, {
        id: meta.id,
        workDir: meta.workDir,
        sessionDir: posixPath(join(this.sessionBaseDir, meta.id)),
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        lastPrompt: meta.lastPrompt,
        metadata: { ...meta.custom } as JsonObject,
        additionalDirs: [
          ...new Set([
            ...meta.additionalDirs,
            ...(projectRootsByWorkDir.get(meta.workDir) ?? []),
          ]),
        ],
      });
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
        additionalDirs: this.authorizedRoots(meta),
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
    // The id is removed with `rmSync(recursive)`: an unchecked segment would
    // delete a directory outside the sessions root.
    assertSessionIdSegment(input.sessionId);
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
    if (meta !== undefined) await this.detachSessionLog(meta);
    // The live handle is gone, but the directory is what `listSessions`
    // enumerates: swallowing a failed removal told the caller the delete
    // succeeded while the session reappeared in the picker on the next list.
    // The TUI reports the rejection ("Failed to delete session …"), and a
    // retry finds the session on disk again and removes it.
    rmSync(join(this.sessionBaseDir, input.sessionId), { recursive: true, force: true });
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
    if (meta !== undefined) await this.detachSessionLog(meta);
  }

  override async prompt(input: SessionPromptRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    this.assertSessionModelWindow(meta);
    if (!meta.handle) {
      // Never silently drop user input: an unknown/closed session is an error,
      // not a no-op that resolves while the TUI shows nothing.
      throw new KimiError(
        ErrorCodes.SESSION_NOT_FOUND,
        `cannot prompt unknown or closed session "${input.sessionId}"`,
      );
    }
    const prompt = this.toSessionPrompt(
      input.input,
      this.promptOriginFromClientMetadata(input.clientMetadata),
    );
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
      // v2 #3764: this entry's displayText wins for the metadata when the
      // client supplied one; the raw input text is the fallback. The record
      // appended here feeds the all-entries displayText judgment for the
      // undo-label / fork-title derivations.
      this.applyPromptMetadata(
        meta,
        promptMetadataTextFromPrompt(input.input),
        input.clientMetadata?.displayText,
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
    this.assertSessionModelWindow(meta);
    if (!meta.handle) {
      throw new KimiError(
        ErrorCodes.SESSION_NOT_FOUND,
        `cannot steer unknown or closed session "${input.sessionId}"`,
      );
    }
    meta.updatedAt = Date.now();

    const prompt = this.toSessionPrompt(
      input.input,
      this.promptOriginFromClientMetadata(input.clientMetadata),
    );
    // v2 #3764: this entry's displayText wins for the metadata when the
    // client supplied one; the raw input text is the fallback. Skipped when
    // the caller already applied the metadata (the busy skill activation
    // resubmits here after applying its own entry's metadata).
    if (!input.skipPromptMetadata) {
      this.applyPromptMetadata(
        meta,
        promptMetadataTextFromPrompt(input.input),
        input.clientMetadata?.displayText,
      );
    }
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
    // The goal panel is driven by `goal.updated`; nothing else emitted it, so
    // a goal created through the SDK never reached the UI.
    this.receiveEvent({
      sessionId: input.sessionId,
      agentId: 'main',
      type: 'goal.updated',
      snapshot: toGoalSnapshot(meta.goal) as unknown as ProtocolGoalSnapshot,
    });
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
    if (meta.permissionMode === input.mode) {
      this.emitStatusUpdated(meta);
      return;
    }
    const previous = meta.permissionMode;
    meta.permissionMode = input.mode;
    // Both attempts are compensated the same way: an unknown mode makes the
    // engine's switch return an error, and a failed rebuild leaves the previous
    // handle in place. Either failure must restore the recorded mode, or the
    // session reports one mode while the engine enforces another.
    try {
      // The engine's PermissionEngine supports a live mode switch, so the new
      // mode reaches the turn already running instead of waiting for the next
      // handle. A session without a live engine falls back to a rebuild.
      const switchedLive = meta.handle ? await meta.handle.setPermissionMode(input.mode) : false;
      if (!switchedLive) {
        await this.rebuildHandle(meta);
      }
    } catch (error) {
      meta.permissionMode = previous;
      throw error;
    }
    this.persistMeta(meta);
    this.emitStatusUpdated(meta);
  }

  override async setTowerMode(input: SetSessionTowerModeRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    // The tower tools run engine-side natively (tools/tower), gated on the
    // `main` caller and the `.tower/` workspace state — not on this flag. The
    // flag records the coordinator mode for the host (steering semantics +
    // status display); the requested base is validated engine-side when the
    // agent runs TowerInit.
    const wasOn = meta.towerMode;
    meta.towerMode = input.enabled;
    meta.updatedAt = Date.now();
    // v2 #3897 `tower_mode_enter` / `tower_mode_exit`: emitted on the
    // transition, from the host side — the flag lives here, and the engine has
    // no flip point of its own to observe.
    if (wasOn !== input.enabled) {
      this.telemetry.track(input.enabled ? 'tower_mode_enter' : 'tower_mode_exit');
    }
    this.emitStatusUpdated(meta);
  }

  override async setSwarmMode(input: SetSessionSwarmModeRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    // The engine closes a `task` / `tool` swarm itself at turn end and says so
    // with an `agent.status.updated` carrying `swarmMode: false`. Recording the
    // trigger is what makes the mode survive the next handle rebuild for a
    // manual swarm and, just as importantly, stop resurrecting an auto-exited
    // one — a stale `swarmMode: true` here would re-enter it on every rebuild.
    const previousTrigger = meta.swarmModeTrigger;
    meta.swarmMode = input.enabled;
    if (input.enabled) {
      meta.swarmModeTrigger = input.trigger;
    }
    try {
      await this.rebuildHandle(meta);
    } catch (error) {
      meta.swarmMode = !input.enabled;
      meta.swarmModeTrigger = previousTrigger;
      throw error;
    }
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
    // A failed read is NOT an empty history: swallowing it created the fork
    // with no context and returned it as a success, and with a turnIndex the
    // failure surfaced as a bogus "Fork turn index is out of range" instead.
    // The read happens before the fork exists, so a throw leaves none behind.
    const history = source.handle ? await source.handle.getHistory() : [];
    if (input.turnIndex !== undefined) {
      // v1's fork rules, both bounds: the index must name a recorded user
      // turn. Anything outside [0, availableTurns) rejects with
      // request.invalid and leaves no fork behind. The lower bound is not
      // cosmetic — `retainThroughTurn` never matches `seen === turnIndex` for
      // a negative index and falls through to `history.length`, which would
      // silently retain the whole session under a "truncate at this turn"
      // call. v2 gets this from the engine, which owns the rule there.
      const availableTurns = history.filter((message) => message.role === 'user').length;
      if (input.turnIndex < 0 || input.turnIndex >= availableTurns) {
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
    } else {
      // Upstream #3974: a fork without an explicit title takes the
      // `Fork: …` default and inherits the source's titleKind, so a
      // custom-titled source's fork keeps its title instead of being
      // overwritten by the auto-title generator (the old forced
      // `replaceable` let the first prompt replace it).
      forkMeta.title = `Fork: ${source.title || source.id}`;
      forkMeta.isCustomTitle = source.isCustomTitle;
      forkMeta.titleKind = source.titleKind;
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
    // A one-shot CLI process holds no live session: resolve it from disk
    // with the same `session-meta.json` probe `listSessions` enumerates, so
    // `kimi export <id>` works for any persisted session, not only one this
    // process created. Everything below derives from the directory, so a
    // disk-resolved session exports identically to a live one.
    //
    // The id becomes a path segment twice (the session directory and the
    // default zip name), so it is checked before any join: an id carrying a
    // separator, a `..` segment, or an absolute root would otherwise read
    // and zip a directory outside the sessions root.
    assertSessionIdSegment(input.id);
    const live = this.liveSessions.get(input.id);
    const persisted =
      live === undefined ? this.loadMeta(join(this.sessionBaseDir, input.id)) : undefined;
    if (live === undefined && persisted === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `unknown session "${input.id}"`, {
        details: { sessionId: input.id },
      });
    }
    const sessionDir = live?.sessionDir ?? posixPath(join(this.sessionBaseDir, input.id));
    const zipPath = posixPath(
      input.outputPath ? resolve(input.outputPath) : join(this.sessionBaseDir, `${input.id}.zip`),
    );
    mkdirSync(dirname(zipPath), { recursive: true });

    // The global log (and its rotations) rides along only on request: it is
    // home-scoped, not session-scoped, so a session export stays focused by
    // default. The manifest names the primary entry when it is included.
    const globalLogDir = join(this.homeDir, 'logs');
    const globalLogEntries: string[] = [];
    if (input.includeGlobalLog === true && existsSync(globalLogDir)) {
      for (const file of readdirSync(globalLogDir).toSorted()) {
        if (file.startsWith('kimi-code.log')) {
          globalLogEntries.push(`logs/${file}`);
        }
      }
    }
    const globalLogPath = globalLogEntries.includes('logs/kimi-code.log')
      ? 'logs/kimi-code.log'
      : globalLogEntries[0];

    const manifest = {
      exportedAt: new Date().toISOString(),
      sessionId: input.id,
      kimiCodeVersion: input.version,
      wireProtocolVersion: '2.0.0',
      os: process.platform,
      nodejsVersion: process.version,
      ...(globalLogPath === undefined ? {} : { globalLogPath }),
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

    for (const relative of globalLogEntries) {
      zipFile.addFile(join(this.homeDir, relative), relative);
      entries.push(relative);
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

  override async importCustomRegistry(
    options: ImportCustomRegistryOptions,
  ): Promise<ImportCustomRegistryResult> {
    const { url } = options;
    const current = loadRuntimeConfig(this.configPath) as unknown as Record<string, unknown>;
    const providers = (current['providers'] ?? {}) as Record<string, unknown>;
    // A re-import commonly omits the key: the registry URL is the stable
    // identity, so fall back to the key a previous import from the same URL
    // parked on its providers.
    const source: CustomRegistrySource = {
      kind: 'apiJson',
      url,
      apiKey: options.apiKey ?? registryKeyFromExisting(providers, url) ?? '',
    };

    let entries: Record<string, CustomRegistryProviderEntry>;
    try {
      entries = await fetchCustomRegistry(source, { userAgent: this.outboundUserAgent() });
    } catch (error) {
      throw new RegistryImportError(
        `custom registry at ${url} cannot be imported: ${truncateUpstreamMessage(error)}`,
        'fetch',
        error instanceof CustomRegistryApiError ? error.status : undefined,
      );
    }
    const entryList = Object.values(entries);
    if (entryList.length === 0) {
      throw new RegistryImportError(`custom registry at ${url} has no importable providers`, 'empty');
    }
    for (const entry of entryList) {
      const existing = providers[entry.id];
      if (isPlainObject(existing) && existing['oauth'] !== undefined) {
        throw new RegistryImportError(
          `provider ${entry.id} is managed by OAuth login; log out before importing it`,
          'apply',
        );
      }
    }

    const previousDefault = current['defaultModel'];
    const previousDefaultProvider = current['defaultProvider'];
    const previousThinking = current['thinking'];
    const next = {
      providers: { ...providers },
      models: { ...((current['models'] ?? {}) as Record<string, unknown>) },
    } as unknown as ManagedKimiConfigShape;
    next.defaultModel = typeof previousDefault === 'string' ? previousDefault : undefined;
    next['defaultProvider'] =
      typeof previousDefaultProvider === 'string' ? previousDefaultProvider : undefined;
    next.thinking = previousThinking as ManagedKimiConfigShape['thinking'];

    try {
      applyCustomRegistryEntries(next, entries, source);
    } catch (error) {
      throw new RegistryImportError(
        `custom registry at ${url} cannot be imported: ${truncateUpstreamMessage(error)}`,
        'apply',
      );
    }

    const firstEntry = entryList[0];
    const firstModelKey = firstEntry === undefined ? undefined : Object.keys(firstEntry.models)[0];
    const hadDefault = typeof previousDefault === 'string' && previousDefault.trim().length > 0;
    if (
      options.setDefaultWhenUnset !== false &&
      !hadDefault &&
      firstEntry !== undefined &&
      firstModelKey !== undefined
    ) {
      next.defaultModel = `${firstEntry.id}/${firstModelKey}`;
    }

    const merged: Record<string, unknown> = {
      ...current,
      providers: next.providers,
      models: next.models,
    };
    assignOrDelete(merged, 'defaultModel', next.defaultModel);
    assignOrDelete(merged, 'defaultProvider', next['defaultProvider']);
    assignOrDelete(merged, 'thinking', next.thinking);
    const updated = validateConfig(merged);
    await writeConfigFile(this.configPath, updated);

    const hasCredential = source.apiKey.length > 0;
    return {
      providers: entryList.map((entry) => ({
        id: entry.id,
        type: entry.type,
        base_url: entry.api,
        has_api_key: hasCredential,
        status: hasCredential ? 'connected' : 'unconfigured',
        models: Object.keys(entry.models),
      })),
      modelsImported: entryList.reduce(
        (total, entry) => total + Object.keys(entry.models).length,
        0,
      ),
      credentialEnv: credentialEnvHints(entryList),
    };
  }

  private outboundUserAgent(): string | undefined {
    if (!this.identity) return undefined;
    return createKimiDefaultHeaders({ homeDir: this.homeDir, ...this.identity })['User-Agent'];
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
    // Stricter than v2 on purpose: `agent-core-v2` guarded only the empty case
    // (`fullCompactionService.ts` → "No messages to compact in current
    // history.", pinned by its `rejects manual compaction ... when history is
    // empty`), so a single-message session would summarize one message into
    // one message and spend a model call to do it. One message is not a
    // conversation, so refuse instead.
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
    // v2's two pre-checks (`skillService.ts:126-134`), before the catalog is
    // touched. The empty-input half is defence at this seam: the public
    // `Session.promptWithSkills` rejects an empty prompt earlier, in the same
    // normalize step `prompt()` uses, so this only fires for a direct RPC
    // caller. The empty-skills half is the one that bites in practice — without
    // it the submission degraded into an ordinary prompt that activated nothing.
    if (input.input.length === 0) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        'promptWithSkills requires a non-empty prompt',
      );
    }
    if (input.skills.length === 0) {
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        'promptWithSkills requires at least one skill',
      );
    }
    const wireMetadata = originClientMetadata(input.clientMetadata);
    // The bundle is validated as a unit before any turn is queued, matching
    // `activateSkill`'s failure mode. Dropping an unknown name instead would
    // hand the caller a successful turn that activated less than it asked
    // for, and the model would see a prompt missing the skill the user named.
    const activations: BundledSkillActivation[] = [];
    const renderedBlocks: { type: 'text'; text: string }[] = [];
    for (const skill of input.skills) {
      // Trim before the lookup, the way `activateSkill` does: an untrimmed
      // name would miss the skill and fail the whole bundle.
      const name = skill.name.trim();
      const args = skill.args?.trim();
      // Throws `skill.not_found` / `skill.type_unsupported` exactly as
      // `activateSkill` does, so one unknown or non-activatable name rejects
      // the bundle (v2 `prepareBundled`, `skillService.ts:189-204`).
      const resolved = await this.resolveSkillPrompt(meta, name, args);
      activations.push({
        activationId: `skill_${randomUUID()}`,
        skillName: resolved.name,
        ...(args !== undefined && args.length > 0 ? { skillArgs: args } : {}),
        ...(resolved.skillType !== undefined ? { skillType: resolved.skillType } : {}),
        ...(resolved.path !== undefined ? { skillPath: resolved.path } : {}),
        ...(resolved.source !== undefined ? { skillSource: resolved.source } : {}),
      });
      renderedBlocks.push({ type: 'text', text: resolved.text });
    }
    // v2 `AgentSkillService.promptWithSkills` (`skillService.ts:139-146`) derives
    // the prompt metadata from **the caller's own parts** — `input.input`, before
    // the rendered skill blocks are prepended — and does it before recording the
    // activations. `prompt()` cannot supply that here: it derives from whatever
    // parts it is handed, and the content this turn needs is
    // `[...renderedBlocks, ...input.input]` (v2 `:155`), so handing both to
    // `prompt()` made the title/lastPrompt the skill's rendered body instead of
    // the user's sentence. Applied here with the caller's parts, exactly as
    // `activateSkill` applies `/name args` over its rendered prompt.
    //
    // v2 gates on the main agent (`agentContext.agentId === MAIN_AGENT_ID`): a
    // btw side-channel turn leaves the session metadata untouched, which is what
    // `prompt()`'s own non-main early return already did before this call.
    if (this.interactiveAgentId === 'main') {
      this.applyPromptMetadata(
        meta,
        promptMetadataTextFromPrompt(input.input),
        input.clientMetadata?.displayText,
      );
    }
    // Each activation is published before the turn, the same ordering
    // `activateSkill` uses, so the live transcript shows the cards ahead of
    // `turn.started` and `message-dispatch` can group them with the prompt
    // they were bundled into.
    //
    // `agentId` is the interactive-agent scope, not a constant: v2 stamps
    // `SkillActivated` with `scopeContext.agentContext.agentId`
    // (`skillService.ts:248`), so a btw side-channel activation belongs to the
    // subagent that ran it. Hardcoding `main` attributed every bundled
    // activation to the main transcript — including the btw panel's, which has
    // no skill-card surface of its own yet (the event is honest now; that
    // rendering gap is a separate item).
    for (const activation of activations) {
      this.trackSkillInvocation(activation.skillName, 'user-slash', activation.skillType);
      this.receiveEvent({
        sessionId: meta.id,
        agentId: this.interactiveAgentId,
        type: 'skill.activated',
        activationId: activation.activationId,
        skillName: activation.skillName,
        ...(activation.skillArgs !== undefined ? { skillArgs: activation.skillArgs } : {}),
        trigger: 'user-slash',
        ...(activation.skillPath !== undefined ? { skillPath: activation.skillPath } : {}),
        ...(activation.skillSource !== undefined ? { skillSource: activation.skillSource } : {}),
      });
    }
    return this.prompt({
      sessionId: meta.id,
      // protocol `UserPromptOrigin.skillActivations` and v2 `skillService.ts:155`:
      // the rendered blocks precede the caller's parts, and the same list rides
      // the turn so resume / replay rebuilds the per-skill view from the one
      // message. The metadata step above already ran, from the caller's parts.
      input: [...renderedBlocks, ...input.input],
      clientMetadata: {
        ...input.clientMetadata,
        // v2's bundle origin carries the metadata entries and the activation
        // list (`skillService.ts:158-163`); the entries were dropped here, so a
        // bundled prompt's displayText never reached the transcript fold.
        origin: {
          kind: 'user',
          skillActivations: activations,
          ...(wireMetadata !== undefined ? { clientMetadata: wireMetadata } : {}),
          ...(input.attachments !== undefined && input.attachments.length > 0
            ? { attachments: input.attachments }
            : {}),
        },
      },
      skipPromptMetadata: true,
    });
  }

  override async runShellCommand(input: {
    sessionId: string;
    command: string;
    commandId?: string;
  }): Promise<{ stdout: string; stderr: string; isError?: boolean; backgrounded?: boolean }> {
    const meta = this.requireSession(input.sessionId);
    // The TUI routes live `!` command output and ctrl+b detach by these events;
    // without them the live view stayed empty until the command finished.
    const commandId = input.commandId ?? randomUUID();
    try {
      const { nativeBashSpawn, nativeBashWait } = await import('@moonshot-ai/kimi-agent/native');
      const shell = probeShellPath() ?? 'bash';
      let stdout = '';
      let stderr = '';
      let taskId: string | undefined;
      const { id } = nativeBashSpawn(
        {
          argv: [shell, '-c', input.command],
          cwd: meta.workDir,
        },
        (_err, ev) => {
          if (!ev) return;
          if (ev.kind === 'stdout' && ev.data) {
            stdout += ev.data;
            this.receiveEvent({
              sessionId: input.sessionId,
              agentId: 'main',
              type: 'shell.output',
              commandId,
              update: { kind: 'stdout', text: ev.data },
              ...(taskId !== undefined ? { taskId } : {}),
            });
          }
          if (ev.kind === 'stderr' && ev.data) {
            stderr += ev.data;
            this.receiveEvent({
              sessionId: input.sessionId,
              agentId: 'main',
              type: 'shell.output',
              commandId,
              update: { kind: 'stderr', text: ev.data },
              ...(taskId !== undefined ? { taskId } : {}),
            });
          }
        },
      );
      taskId = String(id);
      this.receiveEvent({
        sessionId: input.sessionId,
        agentId: 'main',
        type: 'shell.started',
        commandId,
        taskId: String(id),
      });
      // Publish the handle so `cancelShellCommand` can reach the process this
      // call spawned. Without it the cancel had nothing to kill and reported
      // success while the command kept running.
      const key = shellCommandKey(input.sessionId, input.commandId);
      if (key !== undefined) this.liveShellCommands.set(key, id);
      try {
        const exit = await nativeBashWait(id);
        const isError = exit.exitCode !== 0 || Boolean(exit.error);
        this.receiveEvent({
          sessionId: input.sessionId,
          agentId: 'main',
          type: 'shell.completed',
          commandId,
          isError,
          taskId: String(id),
        });
        return {
          stdout,
          stderr,
          isError,
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
    const meta = this.requireSession(input.sessionId);
    // The cron registry is workspace-level engine state (the state-bridge
    // `cron` domain carries no session id), so the host reads it the same way
    // it reads the todo domain: through the engine, which owns the digest
    // layout of the workspace state directory.
    const { nativeCronNextFire, nativeReadEngineState } = await import(
      '@moonshot-ai/kimi-agent/native'
    );
    const raw = nativeReadEngineState(meta.workDir, 'cron');
    if (raw === null) return { tasks: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { tasks: [] };
    }
    if (!Array.isArray(parsed)) return { tasks: [] };
    const now = Date.now();
    const tasks = parsed.map((entry: Record<string, unknown>) => {
      const id = typeof entry['id'] === 'string' ? entry['id'] : '';
      const cron = typeof entry['cron'] === 'string' ? entry['cron'] : '';
      const createdAt =
        typeof entry['createdAt'] === 'number'
          ? entry['createdAt']
          : typeof entry['created_at'] === 'number'
            ? entry['created_at']
            : undefined;
      const lastFiredAt =
        typeof entry['lastFiredAt'] === 'number' ? entry['lastFiredAt'] : undefined;
      // The post-jitter next fire comes from the engine: the host cannot
      // reproduce the parser, the local timezone, or the jitter derivation.
      let nextFireAt: number | null = null;
      if (id !== '' && cron !== '') {
        try {
          nextFireAt = nativeCronNextFire(JSON.stringify(entry), now);
        } catch {
          nextFireAt = null;
        }
      }
      return {
        id,
        cron,
        recurring: entry['recurring'] !== false,
        createdAt: createdAt ?? 0,
        lastFiredAt,
        nextFireAt,
      };
    });
    return { tasks };
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
    // v2 serves the skill catalog from the engine, and this list drives the
    // slash panel: the builtin product skills, the dotted sub-skill commands
    // and `extra_skill_dirs` exist only there — a host-side scan listed none of
    // them, so `/custom-theme` and `/sub-skill.review` never appeared even
    // though the system prompt advertised them.
    const engine = meta.handle ? await meta.handle.skills() : undefined;
    if (engine === undefined) {
      return this.listWorkspaceSkills(meta.workDir);
    }
    const merged: SkillSummary[] = [...(engine as SkillSummary[])];
    const seen = new Set(merged.map((skill) => skill.name.toLowerCase()));
    // Keep the host's own roots (it scans `<home>/skills`, which the engine
    // does not) and let the engine's precedence win on a name clash.
    for (const skill of await this.listWorkspaceSkills(meta.workDir)) {
      if (seen.has(skill.name.toLowerCase())) continue;
      seen.add(skill.name.toLowerCase());
      merged.push(skill);
    }
    return merged;
  }

  override async activateSkill(input: ActivateSkillRpcInput): Promise<void> {
    const meta = this.requireSession(input.sessionId);
    const name = input.name.trim();
    if (name.length === 0) {
      throw new KimiError(ErrorCodes.SKILL_NAME_EMPTY, 'Skill name cannot be empty');
    }
    const args = input.args?.trim();
    const wireMetadata = originClientMetadata(input.clientMetadata);
    const resolved = await this.resolveSkillPrompt(meta, name, args);
    const rendered = resolved.text;
    const activationId = `skill_${randomUUID()}`;
    this.trackSkillInvocation(resolved.name, 'user-slash', resolved.skillType);
    // v1/v2 published the activation event before the turn launched, so the
    // event stream orders it ahead of turn.started. v2 also stamps the scope's
    // agent (`skillService.ts:248`) rather than a constant, and takes the
    // provenance from the catalog instead of guessing it from a path.
    this.receiveEvent({
      sessionId: meta.id,
      agentId: this.interactiveAgentId,
      type: 'skill.activated',
      activationId,
      skillName: resolved.name,
      ...(args !== undefined && args.length > 0 ? { skillArgs: args } : {}),
      trigger: 'user-slash',
      ...(resolved.path !== undefined ? { skillPath: resolved.path } : {}),
      ...(resolved.source !== undefined ? { skillSource: resolved.source } : {}),
    });
    // v2 #3832: the same activation rides the turn request as a
    // `skill_activation` prompt origin, so the engine echoes it on the turn
    // events and an origin-aware consumer can tell this turn from a typed
    // prompt. The web client nests the identical shape in its submission
    // metadata (`metadata.origin`).
    const origin: SkillActivationOrigin = {
      kind: 'skill_activation',
      activationId,
      skillName: resolved.name,
      ...(args !== undefined && args.length > 0 ? { skillArgs: args } : {}),
      trigger: 'user-slash',
      ...(resolved.skillType !== undefined ? { skillType: resolved.skillType } : {}),
      ...(resolved.path !== undefined ? { skillPath: resolved.path } : {}),
      ...(resolved.source !== undefined ? { skillSource: resolved.source } : {}),
      // v2's origin carries the metadata entries as an array
      // (`skillService.ts:98`); `undefined` when the client sent none.
      ...(wireMetadata !== undefined ? { clientMetadata: wireMetadata } : {}),
      ...(input.attachments !== undefined && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    };
    const clientMetadata: ClientPromptMetadata = {
      ...input.clientMetadata,
      origin,
    };
    // v2 `activate` submits `[rendered, ...(input.content ?? [])]`
    // (`skillService.ts:73-85`): the skill block leads, the caller's own parts
    // follow in the same turn.
    const parts: PromptPart[] = [
      { type: 'text', text: rendered },
      ...(input.content ?? []),
    ];
    // The activation updates the prompt-derived metadata like a prompt whose
    // text is the slash command itself — with this entry's displayText
    // winning over the raw slash text when the client supplied one (v2
    // #3764). Applied exactly once here, like upstream's single
    // `promptMetadataTextFromSkill` application: the busy path below
    // resubmits the rendered prompt as a steer with the metadata step
    // skipped, so the steered activation keeps this entry's metadata.
    this.applyPromptMetadata(
      meta,
      promptMetadataTextFromText(`/${name}${args ? ` ${args}` : ''}`),
      input.clientMetadata?.displayText,
    );
    // A turn already running steers the activation into it (v2 #3832: the
    // steered activation gets a transcript frame via the same event); a
    // fresh `newTurn` enqueue here would queue a second turn behind a busy
    // session instead of joining the running one.
    if (meta.busy) {
      return this.steer({
        sessionId: meta.id,
        input: parts,
        clientMetadata,
        skipPromptMetadata: true,
      });
    }
    return this.prompt({
      sessionId: meta.id,
      input: parts,
      clientMetadata,
      skipPromptMetadata: true,
    });
  }

  /**
 * Resolve a `/skill:` activation through the engine and render its prompt —
 * v2 `AgentSkillService` asks its own catalog for both
 * (`skillService.ts:207` + `prepareBundled`), and so does this: the engine
 * resolves the name against the whole scan (project, user, `extra_skill_dirs`,
 * builtins), applies the user-activatable type gate, and expands
 * `$ARGUMENTS` / `${KIMI_SKILL_DIR}`.
 *
 * Throws the two errors v2 raises, so a caller cannot tell the paths apart:
 * `skill.not_found` for an unknown name, `skill.type_unsupported` for a skill
 * whose `type` is not user-activatable (v2 `isUserActivatableSkillType`).
 */
private async resolveSkillPrompt(
  meta: NativeSessionMeta,
  name: string,
  args: string | undefined,
): Promise<ResolvedSkillPrompt> {
  const rendered = await meta.handle?.renderSkillPrompt(name, args ?? '');
  if (rendered !== undefined && rendered.status !== 'ok') {
    if (rendered.status === 'type_unsupported') {
      const resolved = rendered.name ?? name;
      throw new KimiError(
        ErrorCodes.SKILL_TYPE_UNSUPPORTED,
        `Skill "${resolved}" cannot be activated by the user`,
      );
    }
    throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${name}" was not found`);
  }
  if (rendered?.text !== undefined) {
    return {
      text: rendered.text,
      name: rendered.name ?? name,
      ...(rendered.path !== undefined ? { path: rendered.path } : {}),
      // The wire type is a closed union; the engine's own vocabulary is
      // `project` | `user` | `builtin`. A value outside it is dropped rather
      // than widened, so an origin never carries a source no consumer knows.
      ...(SKILL_SOURCES.has(rendered.source ?? '')
        ? { source: rendered.source as SkillSource }
        : {}),
      ...(rendered.skillType !== undefined ? { skillType: rendered.skillType } : {}),
    };
  }
  // An addon predating `sessionRenderSkillPrompt`. Project-scope only, no
  // expansion, no type gate — the degraded path the fork had before, kept so
  // an older binary still activates the skills it always did.
  const fallback = this.renderProjectSkillPrompt(meta, name, args);
  if (fallback === undefined) {
    throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${name}" was not found`);
  }
  return fallback;
}

/**
 * One activation's telemetry (v2 `AgentSkillService.publishActivation`,
 * `skillService.ts:277-287`): `skill_invoked` for every activation, plus
 * `flow_invoked` when the skill declares `type: flow`.
 *
 * The model-tool path already emits these from the engine
 * (`tools/skill.rs`); the user-slash path records its activation on the host
 * side, so it emits them here — without this, only model-invoked skills were
 * counted at all.
 */
private trackSkillInvocation(
  skillName: string,
  trigger: 'user-slash',
  skillType: string | undefined,
): void {
  this.telemetry.track('skill_invoked', { skill_name: skillName, trigger });
  if (skillType === 'flow') {
    this.telemetry.track('flow_invoked', { flow_name: skillName });
  }
}

/**
 * The pre-engine renderer, kept only as the fallback above: the instruction
 * line plus a `<skill-loaded>` wrapper over the body read from
 * `<workDir>/.kimi-code/skills/<name>/SKILL.md`. It finds project skills and
 * nothing else, and expands no arguments — which is why the engine owns this
 * now.
 */
private renderProjectSkillPrompt(
  meta: NativeSessionMeta,
  name: string,
  args: string | undefined,
): ResolvedSkillPrompt | undefined {
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
  return { text: lines.join('\n'), name, path: posixPath(skillMd), source: 'project' };
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

  /**
   * Switch the active web search engine at runtime (manual hot-switch).
   * `engine` is `"bing"` or `"ddg"`. Returns the active engine name.
   */
  override async setSearchEngine(engine: string): Promise<string> {
    const { setSearchEngine } = await import('@moonshot-ai/kimi-agent/native');
    return setSearchEngine(engine);
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
   *
   * Before the store opens, the built-in `normify` plugin is materialized from
   * the embedded copy and seeded into the registry when absent, so the CLI
   * ships with it enabled by default (zero install). A user's disable is
   * preserved (the seeder never re-enables) and an explicit removal is
   * remembered via the opt-out marker.
   */
  private async ensurePluginStore(): Promise<void> {
    if (this.pluginStoreReady) return;
    const { initPluginStore } = await import('@moonshot-ai/kimi-agent/native');
    const seededRoot = materializeBuiltinPlugins(this.engineDataDir);
    initPluginStore(
      this.engineDataDir,
      resolvePluginMarketplaceDir(),
      // Only the packaged single-file binary can re-execute itself as
      // `__plugin_run_node`; source (bun) and node-dist runs keep spawning the
      // `node` that a JS plugin server declares.
      pluginNodeRunnerPath(),
    );
    if (seededRoot !== undefined) await this.seedBuiltinNormify(seededRoot);
    this.pluginStoreReady = true;
  }

  /**
   * Install the built-in normify plugin from its materialized local copy when
   * the registry has no record of it. The engine defaults a fresh install to
   * enabled; an existing record (enabled or user-disabled) is left exactly as
   * it is, so the seeder never overrides a `/plugins` toggle. Failures are
   * swallowed: a broken seed must not take down the plugin API.
   */
  private async seedBuiltinNormify(seededRoot: string): Promise<void> {
    try {
      const { pluginInfo, pluginInstall } = await import('@moonshot-ai/kimi-agent/native');
      const existing = pluginInfo(BUILTIN_NORMIFY_PLUGIN_ID);
      if (existing !== null && existing !== undefined) return;
      pluginInstall(seededRoot);
    } catch (error) {
      console.warn(`builtin plugin seed failed: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    // Re-enabling the built-in normify plugin clears the removal opt-out: the
    // toggle is the newer user decision and it wins over the marker.
    if (id === BUILTIN_NORMIFY_PLUGIN_ID && enabled) {
      setBuiltinPluginOptOut(this.engineDataDir, false);
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
    // Removing the built-in normify plugin is an explicit user decision: record
    // it so the seeder does not reinstall it on the next launch.
    if (id === BUILTIN_NORMIFY_PLUGIN_ID) setBuiltinPluginOptOut(this.engineDataDir, true);
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

  /**
   * The project-level MCP servers that trusting this workspace would enable,
   * in the shape the trust prompt renders.
   *
   * Read straight from the two project candidates rather than through
   * `listWorkspaceMcpServers`: that method ignores its `workDir` and answers
   * the *user-global* `mcp.json` (its own comment says so), so it would
   * disclose servers the user already chose instead of the ones this project
   * gates. Showing the wrong set here is worse than showing none: the prompt
   * asks the user to judge a directory on the strength of that list.
   *
   * Deliberately the safe subset. `env`, headers and anything else the config
   * carries are what a planted `.mcp.json` would exfiltrate, and this prompt
   * runs *before* the workspace is trusted, so they are not carried into it.
   * The renderer sanitizes control characters on top of that.
   */
  private readProjectMcpDisclosure(workDir: string): WorkspaceTrustMcpServerInfo[] {
    const candidates = [join(workDir, '.mcp.json'), join(workDir, '.kimi-code', 'mcp.json')];
    const disclosure: WorkspaceTrustMcpServerInfo[] = [];
    for (const file of candidates) {
      let parsed: { mcpServers?: Record<string, unknown> };
      try {
        parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
          mcpServers?: Record<string, unknown>;
        };
      } catch {
        // Missing or unparseable: the same silent skip the vscode handler makes.
        continue;
      }
      const servers = parsed?.mcpServers;
      if (servers === null || typeof servers !== 'object') continue;
      for (const [name, raw] of Object.entries(servers)) {
        if (raw === null || typeof raw !== 'object') continue;
        const cfg = raw as Record<string, unknown>;
        const command = typeof cfg['command'] === 'string' ? cfg['command'] : undefined;
        const url = typeof cfg['url'] === 'string' ? cfg['url'] : undefined;
        const declared = cfg['transport'];
        const transport =
          declared === 'stdio' || declared === 'http' || declared === 'sse'
            ? declared
            : command !== undefined
              ? ('stdio' as const)
              : url !== undefined
                ? ('http' as const)
                : undefined;
        // Neither a command nor a url: there is nothing to describe, and
        // guessing a transport would put a claim in front of the user that the
        // config never made.
        if (transport === undefined) continue;
        const args = cfg['args'];
        disclosure.push({
          name,
          transport,
          command,
          args: Array.isArray(args) ? args.map(String) : undefined,
          cwd: typeof cfg['cwd'] === 'string' ? cfg['cwd'] : undefined,
          url,
        });
      }
    }
    return disclosure;
  }

  override async getWorkspaceTrustInfo(workDir: string): Promise<WorkspaceTrustInfo> {
    // Fail closed: a workspace is untrusted until the user explicitly trusts it.
    // The previous `trusted: true` stub silently disabled the TUI's "do you trust
    // this folder?" gate, so an unfamiliar checkout's workspace-level MCP servers
    // and skills were loaded and run without any prompt. gatedMcpServers stays
    // empty until the MCP catalog is wired; the trust decision itself is persisted
    // so the prompt is shown once, not on every launch.
    //
    // `KIMI_CODE_TRUST_WORKSPACE` (upstream #4059) ORs over the persisted
    // decision, so a non-interactive host can opt every workspace in without a
    // persisted record. It wins over the record, which means untrusting has no
    // observable effect while it is set — the same trade upstream made. Only the
    // truthy spellings count; `parseBooleanEnv` returns undefined for anything it
    // does not recognise, so a typo leaves the normal prompt in place instead of
    // silently trusting everything.
    const envTrusted = parseBooleanEnv(process.env['KIMI_CODE_TRUST_WORKSPACE']) === true;
    const trusted =
      envTrusted ||
      this.readTrustedWorkspaces().some((entry) => workspaceTrustKey(entry) === workspaceTrustKey(workDir));
    return { trusted, gatedMcpServers: this.readProjectMcpDisclosure(workDir) };
  }

  override async trustWorkspace(workDir: string): Promise<void> {
    const trusted = this.readTrustedWorkspaces();
    if (!trusted.some((entry) => workspaceTrustKey(entry) === workspaceTrustKey(workDir))) {
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
      // Keep the goal panel's counters live (v2 `goal.updated`).
      this.receiveEvent({
        sessionId: meta.id,
        agentId: 'main',
        type: 'goal.updated',
        snapshot: toGoalSnapshot(meta.goal) as unknown as ProtocolGoalSnapshot,
      });
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
    // A failed read is NOT an empty history: swallowing it started the
    // replacement handle with no context while the transcript still showed the
    // whole conversation. The throw lands before buildHandle, so the session
    // stays on its previous handle — the contract this method documents.
    const history = previous ? await previous.getHistory() : [];
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
   * Fail session creation when `--agent` names a profile that resolves
   * nowhere. The name may be a built-in profile or one discovered from an
   * agent file; anything else is a typo, and the SDK must not fall back to the
   * default agent silently (`docs/en/customization/agents.md:140`).
   */
  private async assertAgentProfileResolves(meta: NativeSessionMeta): Promise<void> {
    const requested = meta.agentProfile;
    if (requested === undefined) return;
    const key = requested.trim().toLowerCase();
    if (BUILTIN_AGENT_PROFILE_NAMES.includes(key)) return;
    const discovered = await this.resolveSessionAgentProfiles(meta);
    if (discovered.some((profile) => profile.name.toLowerCase() === key)) return;
    const available = [
      ...BUILTIN_AGENT_PROFILE_NAMES,
      ...discovered.map((profile) => profile.name),
    ];
    throw new KimiError(
      ErrorCodes.AGENT_NOT_FOUND,
      `Unknown agent profile "${requested}". Available agents: ${available.join(', ')}`,
      { details: { agentProfile: requested, available } },
    );
  }

  /**
   * Discover the agent files visible to a session and project them onto the
   * engine's `subagentProfiles` wire (P46). The native `Agent` tool reads the
   * registered snapshot to spawn subagents; without this the host's profiles
   * never reach it.
   *
   * A malformed discovered file is skipped with a warning; an explicit
   * `--agent-file` is fatal, because the user named it on the command line.
   */
  private async resolveSessionAgentProfiles(
    meta: NativeSessionMeta,
  ): Promise<readonly AgentFileDefinition[]> {
    const config = loadRuntimeConfigLenient(this.configPath);
    let discovered: DiscoveredAgentFiles;
    try {
      discovered = discoverAgentFiles({
        workDir: meta.workDir,
        kimiHome: this.homeDir,
        osHomeDir: homedir(),
        extraDirs: config.extraAgentDirs,
        explicitFiles: meta.agentFiles,
        pluginAgentDirs: await this.resolvePluginAgentDirs(),
      });
    } catch (error) {
      // Only an explicit `--agent-file` read/parse failure throws here; every
      // other scope degrades to a warning. Fail creation naming the file.
      throw new KimiError(
        ErrorCodes.REQUEST_INVALID,
        `Cannot load --agent-file for session "${meta.id}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    for (const warning of discovered.warnings) {
      log.warn(`agent file discovery: ${warning}`);
    }
    return discovered.profiles;
  }

  /**
   * The `agents` directories of enabled plugins: each manifest-declared `./`
   * path, or the plugin root's `agents/` when the manifest omits the field
   * (`docs/en/customization/plugins.md:409`). Plugin roots come from the
   * engine's plugin registry — the only side that installs and knows them.
   * Any failure degrades to "no plugin agents": a plugin problem must not
   * block session creation.
   *
   * The registry is only consulted when the host has already initialized it.
   * Opening it here would be a side effect of creating a session — it pins the
   * plugin SQLite file for the process lifetime, and on Windows that alone is
   * enough to make a caller's cleanup fail with EBUSY. Session creation must
   * not take a lock the caller never asked for, so an uninitialized store
   * simply contributes no plugin agents (the plugin panel initializes it when
   * the user opens it, and the next handle build picks the agents up).
   */
  private async resolvePluginAgentDirs(): Promise<readonly string[]> {
    if (!this.pluginStoreReady) return [];
    try {
      const native = await import('@moonshot-ai/kimi-agent/native');
      const summaries = JSON.parse(native.pluginList()) as readonly PluginSummary[];
      const dirs: string[] = [];
      for (const summary of summaries) {
        if (!summary.enabled) continue;
        const raw = native.pluginInfo(summary.id);
        if (raw === null || raw === undefined) continue;
        const info = JSON.parse(raw) as PluginInfo;
        if (typeof info.root !== 'string' || info.root.length === 0) continue;
        for (const entry of manifestAgentPaths(info)) {
          dirs.push(resolve(info.root, entry));
        }
      }
      return dirs;
    } catch (error) {
      log.warn('plugin agent discovery failed; continuing without plugin agents', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Apply a setting that is baked into the engine handle at build time, and
   * roll the field back when the rebuild fails. Without the rollback a failed
   * `setModel` left `meta.model` naming a model the engine never switched to,
   * so the TUI reported a change that had not happened.
   *
   * The new value must also be persisted: the handle is rebuilt from `meta`,
   * so a resume that reads a stale `session-meta.json` builds the engine with
   * the old value while the replay (which reads the engine's own recorded
   * state) shows the new one — a permission mode switched mid-conversation
   * came back as the previous mode and prompted for tools the user had already
   * allowed.
   */  private async applyRebuiltSetting<K extends keyof NativeSessionMeta>(
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
    this.persistMeta(meta);
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
      agentProfile: meta.agentProfile,
      agentFiles: meta.agentFiles,
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
  private toSessionPrompt(
    input: SessionPromptRpcInput['input'],
    origin?: unknown,
  ): SessionPrompt {
    if (typeof input === 'string') {
      return { role: 'user', content: input, ...(origin === undefined ? {} : { origin }) };
    }
    return this.toSessionPromptFromParts(input, origin);
  }

  private toSessionPromptFromParts(
    parts: readonly PromptPart[],
    origin?: unknown,
  ): SessionPrompt {
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
      ...(origin === undefined ? {} : { origin }),
    } as SessionPrompt;
  }

  /// The prompt origin a submission's client metadata nests (v2 #3832): an
  /// `origin` field that names its `kind` is a prompt origin in the
  /// transcript contract's shape — the `skill_activation` variant a
  /// user-slash activation carries — and rides the turn request so the engine
  /// echoes it on the turn events. Mirrors the engine's own
  /// `prompt_origin_from_metadata`.
  private promptOriginFromClientMetadata(
    clientMetadata: ClientPromptMetadata | undefined,
  ): PromptOrigin | undefined {
    const origin = clientMetadata?.['origin'] as PromptOrigin | undefined;
    return origin !== undefined && typeof origin.kind === 'string' ? origin : undefined;
  }

  /// The deferred model-config failure the lenient loader promises (see
  /// `loadRuntimeConfigLenient`'s design note): a schema-invalid `[models]`
  /// entry stays in the loaded view, and this is the point it bites. An entry
  /// without a positive `max_context_size` cannot serve a turn — the engine
  /// would run a 0-token window and fail opaquely at the provider — so the
  /// submission is refused here with the schema's own actionable message.
  /// Entries the env synthesizer and the built-in defaults build always carry
  /// a window, so only a hand-written broken entry lands here.
  private assertSessionModelWindow(meta: NativeSessionMeta): void {
    const config = loadRuntimeConfigLenient(this.configPath);
    const alias = meta.model ?? config.defaultModel;
    if (alias === undefined) return;
    const entry = lookupModelAlias(config, alias);
    if (entry !== undefined && (effectiveModelAlias(entry).maxContextSize ?? 0) < 1) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `Model "${alias}" must define a positive max_context_size in config.toml.`,
      );
    }
  }

  /**
   * Apply the prompt-derived metadata update (v2 `applyPromptMetadataUpdate`):
   * lastPrompt always, and the title only while it is still the untitled
   * default and not host-customized. Emits `session.meta.updated`.
   *
   * #3764 per-entry preference: when this entry's client supplied a
   * `displayText`, its sanitized form is the metadata the entry contributes —
   * it never mixes with `fallbackText` (the entry's sanitized content-derived
   * text), and an entry without one falls back to `fallbackText`. Every call
   * also appends one {@link NativePromptMetadataRecord} to
   * `meta.promptMetadata` so the displayText set judgment behind the
   * undo-label / fork-title derivations
   * ({@link displayTextForUndoOrForkLabel}) sees the entries in submission
   * order; an entry carrying neither a `displayText` nor metadata text is not
   * recorded. The record keeps the raw `displayText` even when it sanitizes
   * to empty: the flag records what the client provided, not what survived
   * redaction.
   */
  private applyPromptMetadata(
    meta: NativeSessionMeta,
    fallbackText: string | undefined,
    displayText?: string,
  ): void {
    const text = displayText !== undefined ? promptMetadataTextFromText(displayText) : fallbackText;
    if (displayText !== undefined || fallbackText !== undefined) {
      meta.promptMetadata.push({ text, hasDisplayText: displayText !== undefined, displayText });
    }
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
      // Close each session sink while its meta is still in hand: the clear()
      // below drops the last reference that can reach it, and an unclosed sink
      // leaves whatever is still buffered on the floor.
      await this.detachSessionLog(meta);
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
