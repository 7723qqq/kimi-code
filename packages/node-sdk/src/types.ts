import type { Kaos } from '@moonshot-ai/kaos';
import type { KimiHostIdentity, OAuthRefreshOutcome } from '@moonshot-ai/kimi-code-oauth';
import type { ContentPart, ModelCapability, ToolCall } from '@moonshot-ai/kosong';

export interface ImageCompressionTelemetryClient {
  track(
    event: string,
    properties?: Readonly<Record<string, string | number | boolean | null | undefined>>,
  ): void;
}

export interface ImageCompressionTelemetry {
  readonly client: ImageCompressionTelemetryClient;
  readonly source: string;
}

export type StrictPropertyCheck<T, Target> = T extends Target
  ? Exclude<keyof T, keyof Target> extends never
    ? T
    : never
  : never;

export type TelemetryEventName = string;
export type TelemetryEventPayload<_K extends TelemetryEventName = string> = Record<string, unknown>;

import type { ApprovalResponse } from '#/events';

export type SwarmModeTrigger = 'manual' | 'auto' | 'system' | 'task' | 'tool';

export type PermissionMode = 'manual' | 'yolo' | 'auto';

export interface PermissionApprovalResultRecord {
  readonly turnId?: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: ApprovalResponse;
}

export interface CompactionResult {
  readonly summary: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly keptUserMessageCount?: number;
}

export interface AgentConfigUpdateData {
  readonly [key: string]: unknown;
}

export type AgentReplayRecordPayload =
  | { readonly type: 'message'; readonly message: ContextMessage }
  | { readonly type: 'compaction'; readonly result?: CompactionResult | 'cancelled'; readonly instruction?: string }
  | {
      readonly type: 'goal_updated';
      readonly snapshot: GoalSnapshot;
      readonly change: GoalChange | { readonly kind: 'created' };
    }
  | { readonly type: 'plan_updated'; readonly enabled: boolean }
  | { readonly type: 'config_updated'; readonly config?: AgentConfigUpdateData }
  | { readonly type: 'permission_updated'; readonly mode: PermissionMode }
  | { readonly type: 'approval_result'; readonly record: PermissionApprovalResultRecord };

export type AgentReplayRecord = { readonly time: number } & AgentReplayRecordPayload;

export type TaskLifecycleStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export type AgentTaskStatus = TaskLifecycleStatus;
export type BackgroundTaskStatus = AgentTaskStatus;

export interface TaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: AgentTaskStatus;
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt?: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly timeoutMs?: number;
  readonly title?: string;
  readonly id?: string;
  readonly progress?: number;
  readonly error?: string;
}

export interface ProcessTaskInfo extends TaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}

export interface AgentTaskInfo extends TaskInfoBase {
  readonly kind: 'agent';
  readonly agentId?: string;
  readonly subagentType?: string;
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly toolCallId?: string;
  readonly questionCount?: number;
}

export interface QuestionTaskInfo extends TaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export type TaskInfo = ProcessTaskInfo | AgentTaskInfo | QuestionTaskInfo;
export type BackgroundTaskInfo = TaskInfo;
export type ProcessBackgroundTaskInfo = ProcessTaskInfo;
export type AgentBackgroundTaskInfo = AgentTaskInfo;
export type QuestionBackgroundTaskInfo = QuestionTaskInfo;

export interface ContextMessage {
  readonly id?: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string | readonly ContentPart[];
  readonly toolCalls?: readonly ToolCall[];
  readonly origin?: PromptOrigin;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

export interface AgentContextData {
  readonly history: readonly ContextMessage[];
  readonly tokenCount: number;
}

export type ExperimentalFlagSource = 'default' | 'config' | 'env' | 'master-env';
export interface ExperimentalFeatureState {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly source?: ExperimentalFlagSource;
  readonly title?: string;
  readonly env?: string;
  readonly defaultEnabled?: boolean;
  readonly surface?: string;
  readonly configValue?: unknown;
  readonly [key: string]: unknown;
}
export type ExperimentalFlagMap = Record<string, ExperimentalFeatureState>;

export interface ExportSessionManifest {
  readonly version?: number;
  readonly workspaceDir?: string;
  readonly [key: string]: unknown;
  readonly sessionId: string;
  readonly title?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly agentCount?: number;
  readonly exportedAt?: string;
  readonly kimiCodeVersion?: string;
  readonly wireProtocolVersion?: string;
  readonly os?: string;
  readonly nodejsVersion?: string;
  readonly sessionFirstActivity?: string;
  readonly sessionLogPath?: string;
  readonly globalLogPath?: string;
}

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'complete'
  | 'budget_limited'
  | 'usage_limited';
export interface GoalBudgetLimits {
  readonly maxTurns?: number;
  readonly maxTokens?: number;
  readonly maxSeconds?: number;
}
export interface GoalBudgetReport {
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly secondsUsed: number;
  readonly limits: GoalBudgetLimits;
  readonly tokenBudget?: number;
}
export interface GoalChange {
  readonly kind: string;
  readonly description?: string;
  readonly timestamp?: number;
  readonly reason?: string;
  readonly status?: string;
  readonly actor?: string;
  readonly stats?: any;
}
export interface GoalChangeStats {
  readonly additions: number;
  readonly deletions: number;
  readonly modifications: number;
}
export interface GoalSnapshot {
  readonly id?: string;
  readonly goalId?: string;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly completionCriterion?: string;
  readonly created_at?: number;
  readonly updated_at?: number;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly turnsUsed?: number;
  readonly tokensUsed?: number;
  readonly inputTokensUsed?: number;
  readonly outputTokensUsed?: number;
  readonly wallClockMs?: number;
  readonly budget?: any;
  readonly changes?: readonly GoalChange[];
  readonly terminalReason?: string;
}
export interface GoalToolResult {
  readonly toolCallId?: string;
  readonly success?: boolean;
  readonly output?: string;
  readonly error?: string;
  readonly goal?: GoalSnapshot | null;
}

export interface PermissionData {
  readonly mode: PermissionMode;
  readonly rules?: readonly unknown[];
}

export interface PlanData {
  readonly id?: string;
  readonly content?: string;
  readonly path?: string;
  readonly steps?: readonly unknown[];
  readonly activeIndex?: number;
  readonly [key: string]: unknown;
}

export interface PluginCommandDef {
  readonly name: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly pluginId?: string;
  readonly body?: string;
  readonly path?: string;
}
export interface PluginGithubRef {
  readonly owner: string;
  readonly repo: string;
  readonly ref?: any;
  readonly path?: string;
  readonly installedSha?: string;
  readonly [key: string]: any;
}
export interface PluginGithubMetadata {
  readonly stars?: number;
  readonly description?: string;
}
export type PluginSource = 'official' | 'community' | 'local' | 'git' | 'local-path' | 'github' | 'zip-url';
export interface PluginMcpServerInfo {
  readonly name: string;
  readonly transport: string;
  readonly enabled?: boolean;
  readonly url?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly runtimeName?: string;
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
  readonly [key: string]: any;
}
export interface PluginInfo {
  readonly id: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly version?: string;
  readonly author?: string;
  readonly enabled: boolean;
  readonly state?: string;
  readonly source: PluginSource;
  readonly commands?: readonly PluginCommandDef[];
  readonly mcpServers?: readonly PluginMcpServerInfo[];
  readonly github?: PluginGithubRef;
  readonly enabledMcpServerCount?: number;
  readonly skillCount?: number;
  readonly mcpServerCount?: number;
  readonly hookCount?: number;
  readonly commandCount?: number;
  readonly hasErrors?: boolean;
  readonly root?: string;
  readonly installedAt?: number | string;
  readonly updatedAt?: number | string;
  readonly originalSource?: string;
  readonly manifestPath?: string;
  readonly manifestKind?: string;
  readonly shadowedManifestPath?: string;
  readonly manifest?: any;
  readonly diagnostics?: readonly any[];
  readonly [key: string]: any;
}
export interface PluginSummary {
  readonly id: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly version?: string;
  readonly enabled: boolean;
  readonly state?: string;
  readonly source: PluginSource;
  readonly originalSource?: string;
  readonly skillCount?: number;
  readonly mcpServerCount?: number;
  readonly enabledMcpServerCount?: number;
  readonly hookCount?: number;
  readonly commandCount?: number;
  readonly hasErrors?: boolean;
  readonly github?: PluginGithubRef;
}

export type TurnEngine = 'native' | 'v2' | 'rust';

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

export interface BundledSkillActivation {
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
}

export interface UserPromptOrigin {
  readonly kind: 'user';
  readonly skillActivations?: readonly BundledSkillActivation[];
}

export interface SkillActivationOrigin {
  readonly kind: 'skill_activation';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
}

export interface PluginCommandOrigin {
  readonly kind: 'plugin_command';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string;
  readonly trigger: 'user-slash';
}

export interface InjectionOrigin {
  readonly kind: 'injection';
  readonly variant: string;
}

export interface ShellCommandOrigin {
  readonly kind: 'shell_command';
  readonly phase: 'input' | 'output';
  readonly isError?: boolean;
}

export interface CompactionSummaryOrigin {
  readonly kind: 'compaction_summary';
}

export interface SystemTriggerOrigin {
  readonly kind: 'system_trigger';
  readonly name: string;
}

export interface TaskOrigin {
  readonly kind: 'task';
  readonly taskId: string;
  readonly status: TaskLifecycleStatus;
  readonly notificationId: string;
}

export interface BackgroundTaskOrigin {
  readonly kind: 'background_task';
  readonly taskId: string;
  readonly status: TaskLifecycleStatus;
  readonly notificationId: string;
}

export interface CronJobOrigin {
  readonly kind: 'cron_job';
  readonly jobId: string;
  readonly cron: string;
  readonly recurring: boolean;
  readonly coalescedCount: number;
  readonly stale: boolean;
}

export interface CronMissedOrigin {
  readonly kind: 'cron_missed';
  readonly count: number;
}

export interface HookResultOrigin {
  readonly kind: 'hook_result';
  readonly event: string;
  readonly blocked?: boolean;
}

export interface RetryOrigin {
  readonly kind: 'retry';
  readonly trigger?: string;
}

export type PromptOrigin =
  | UserPromptOrigin
  | SkillActivationOrigin
  | PluginCommandOrigin
  | InjectionOrigin
  | ShellCommandOrigin
  | CompactionSummaryOrigin
  | SystemTriggerOrigin
  | TaskOrigin
  | BackgroundTaskOrigin
  | CronJobOrigin
  | CronMissedOrigin
  | HookResultOrigin
  | RetryOrigin;

export interface ReloadSummary {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: readonly { id: string; message: string }[];
}

export interface ShellEnvironment {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly term?: string;
  readonly termProgram?: string;
  readonly termProgramVersion?: string;
  readonly multiplexer?: string;
  readonly shell?: string;
}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly path?: string;
  readonly enabled?: boolean;
  readonly source?: string;
  readonly type?: string;
  readonly isSubSkill?: boolean;
  readonly disableModelInvocation?: boolean;
  readonly [key: string]: unknown;
}

export interface ToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
}

export interface UsageStatus {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly totalCostUsd?: number;
  readonly contextTokens?: number;
  readonly contextLimit?: number;
  readonly turnCount?: number;
  readonly byModel?: Record<string, TokenUsage>;
  readonly currentTurn?: TokenUsage;
  readonly total?: TokenUsage;
  readonly [key: string]: unknown;
}

export interface AgentCommandInfo {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
}

export interface McpRegistryPluginOrigin {
  readonly pluginId: string;
  readonly serverName: string;
}
export type McpServerSource = 'user' | 'project' | 'session' | 'plugin' | 'global';

export interface CapabilityStatus {
  readonly enabled?: boolean;
  readonly state?: string;
  readonly reason?: string;
  readonly id?: string;
  readonly pluginId?: string;
  readonly supported?: boolean;
  readonly version?: string;
  readonly install?: any;
  readonly steps?: readonly any[];
  readonly displayName?: string;
  readonly description?: string;
}

export interface McpServerEntry {
  readonly id?: string;
  readonly name: string;
  readonly status: 'running' | 'stopped' | 'failed' | 'connecting' | 'connected' | 'pending' | 'needs-auth' | 'disabled' | 'removed';
  readonly transport: string;
  readonly tools?: readonly unknown[];
  readonly source?: string;
  readonly origin?: string;
  readonly mutable?: boolean;
  readonly plugin?: unknown;
  readonly toolCount?: number;
  readonly error?: string | null;
  readonly [key: string]: any;
}

import type { ImageLimits } from '#/image-limits';

import type {
  BackgroundConfig,
  GlobalMcpServerConfig,
  KimiConfig,
  KimiConfigPatch,
  LoopControl,
  ModelAlias,
  MoonshotServiceConfig,
  OAuthRef,
  ProviderConfig,
  ProviderType,
  ServicesConfig,
  ThinkingConfig,
} from '#/config-local';
import type { TelemetryClient, TelemetryContextPatch, TelemetryProperties } from '#/telemetry';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type Unsubscribe = () => void;

/** Warnings from the most recent config.toml load; empty when the config is fully valid. */
export interface ConfigDiagnostics {
  readonly warnings: readonly string[];
}

/** A scheduled cron task snapshot (v1 wire shape, kept as the SDK contract). */
export interface CronTaskSnapshot {
  readonly id: string;
  readonly cron: string;
  readonly recurring: boolean;
  readonly createdAt: number;
  readonly lastFiredAt: number | undefined;
  /** Post-jitter next fire (epoch ms), or null when no future fire exists. */
  readonly nextFireAt: number | null;
}

export interface GetCronTasksResult {
  readonly tasks: readonly CronTaskSnapshot[];
}

export type { McpServerEntry as McpServerInfo };

export interface McpServerLocator {
  readonly serverName: string;
  readonly scope?: string;
}

export interface AppMcpServerInspection {
  readonly serverName: string;
  readonly tools: readonly unknown[];
}

export interface McpStartupMetrics {
  readonly durationMs: number;
}

/**
 * Auth state of a user-global MCP server entry (v1 wire shape, kept as the
 * SDK contract; upstream defines it in agent-core v1, this fork defines it
 * here since v1 was retired).
 */
export type GlobalMcpServerAuthState =
  | 'not-applicable'
  | 'bearer-token'
  | 'oauth-required'
  | 'oauth-authorized'
  // Stored credentials exist but are expired without a usable refresh token
  // (or failed an online verification): re-login required.
  | 'oauth-expired';

export interface GlobalMcpServerAuthStatus {
  readonly name: string;
  readonly authStatus: GlobalMcpServerAuthState;
}

export interface McpTestResult {
  readonly success: boolean;
  readonly output: string;
}

/**
 * A named entry of the user-global `<KIMI_CODE_HOME>/mcp.json` store — the
 * v1 wire shape the SDK's MCP surface serves (`GlobalMcpServerConfig` under
 * the v1 name `McpServerConfig`; the schema type without the name lives in
 * `#/config-local` for the store internals).
 */
export type McpServerConfig = GlobalMcpServerConfig;
export type { GlobalMcpServerConfig };

export type { KimiConfig, KimiConfigPatch };
export type {
  BackgroundConfig,
  LoopControl,
  ModelAlias,
  MoonshotServiceConfig,
  OAuthRef,
  ProviderConfig,
  ProviderType,
  ServicesConfig,
  ThinkingConfig,
};
export type { KimiHostIdentity, OAuthRefreshOutcome };
export type { TelemetryClient, TelemetryContextPatch, TelemetryProperties } from '#/telemetry';
export type { ContentPart, Role, ThinkingEffort, ToolCall } from '@moonshot-ai/kosong';

/**
 * Result of beginning a global MCP server OAuth flow (v1 wire shape, kept as
 * the SDK's public contract).
 */
export type BeginGlobalMcpServerAuthResult =
  | { readonly status: 'already-authorized' }
  | {
      readonly status: 'authorization-required';
      readonly flowId: string;
      readonly authorizationUrl: string;
    };

/**
 * Trust state of a workspace directory. Only meaningful on the agent-core-v2
 * engine; the v1 engine has no workspace-trust concept and reports
 * `{ trusted: true, gatedMcpServers: [] }`.
 */
export interface WorkspaceTrustMcpServerInfo {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
}

export interface WorkspaceTrustInfo {
  readonly trusted: boolean;
  /** Safe descriptions of project-level MCP servers that trusting would enable. */
  readonly gatedMcpServers: readonly WorkspaceTrustMcpServerInfo[];
}

/**
 * File-suggestion query against a workspace root, no session required. Only
 * meaningful on the agent-core-v2 engine; the v1 engine has no equivalent
 * and reports `undefined`.
 */
export interface SuggestFilesInput {
  readonly query: string;
  readonly limit?: number;
}

export interface SuggestFilesItem {
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'directory' | 'symlink';
  /** Matched-character offsets into `path`, for mention-style highlighting. */
  readonly matchPositions: readonly number[];
}

export interface SuggestFilesResult {
  readonly items: readonly SuggestFilesItem[];
  readonly truncated: boolean;
}

/** Metadata of one upload in the engine's daemon file store. */
export interface FileMeta {
  readonly id: string;
  readonly filename?: string;
  readonly name?: string;
  readonly size: number;
  readonly mimeType?: string;
  readonly media_type?: string;
  readonly createdAt?: number;
  readonly created_at?: number | string;
  readonly expiresAt?: number;
  readonly expires_at?: number | string;
}

/** Input for `uploadFile`: the upload's display name and MIME type. */
export interface UploadFileOptions {
  readonly name: string;
  readonly mimeType?: string;
  /** Optional daemon-side TTL for staging uploads. */
  readonly expiresInSec?: number;
}

export interface CreateGoalInput {
  readonly objective: string;
  readonly replace?: boolean;
}

export type TextPromptPart = Extract<ContentPart, { type: 'text' }>;
export type PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>;

export type PromptInput = readonly PromptPart[];

export interface PromptSkillActivation {
  readonly name: string;
  readonly args?: string;
}

export interface KimiHarnessOptions {
  readonly identity?: KimiHostIdentity | undefined;
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly autoLoadConfig?: boolean | undefined;
  readonly uiMode?: string;
  readonly skillDirs?: readonly string[];
  readonly telemetry?: TelemetryClient | undefined;
  readonly onOAuthRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
  readonly sessionStartedProperties?: TelemetryProperties;
  readonly imageLimits?: ImageLimits | undefined;
  /**
   * External turn-engine override (the Rust kimi-agent engine). When set,
   * every turn is driven by this engine instead of the JS loop. `undefined`
   * keeps the default JS engine.
   */
  readonly engineOverride?: unknown;
}

export interface CreateSessionOptions {
  readonly id?: string | undefined;
  readonly workDir: string;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly permission?: PermissionMode | undefined;
  readonly planMode?: boolean;
  readonly metadata?: JsonObject | undefined;
  readonly additionalDirs?: readonly string[];
  /**
   * Main-agent profile name (`--agent`): a builtin profile or one defined by
   * an agentfile discovered from the user/project agent directories.
   */
  readonly agentProfile?: string;
  /**
   * Explicit agentfiles (`--agent-file`) loaded for this session with the
   * highest precedence; an invalid file fails session creation.
   */
  readonly agentFiles?: readonly string[];
  readonly sessionStartedProperties?: TelemetryProperties;
  /** Kaos (remote/isolated execution environment) session target, if any. */
  readonly kaos?: Kaos | undefined;
  /** Secondary persistence environment; falls back to `kaos` when set. */
  readonly persistenceKaos?: Kaos | undefined;
  /**
   * Print-mode (`kimi -p`) only: when the main agent ends a turn while
   * background subagents (`kind === 'agent'`) are still running, hold the turn
   * open and idle-wait until they all finish, flushing their completions into
   * the turn so the model can react before the run exits. Ignored by
   * interactive / SDK sessions.
   */
  readonly drainAgentTasksOnStop?: boolean;
}

export interface RenameSessionInput {
  readonly id: string;
  readonly title: string;
}

export interface GenerateSessionTitleInput {
  readonly id: string;
  /** Regenerate even when the session already has a generated/custom title. */
  readonly force?: boolean;
  /** Conversation excerpt to generate from (default `user_prompts`). */
  readonly source?: 'user_prompts' | 'first_turn' | 'digest';
}

export interface ResumeSessionInput {
  readonly id: string;
  readonly additionalDirs?: readonly string[];
  /** Re-select the session's already-bound main profile; a different name fails. */
  readonly agentProfile?: string;
  /** Include persisted subagent states in the returned replay snapshot. */
  readonly includeSubagents?: boolean;
  /**
   * Limit each returned agent replay to the most recent N user turns. Omit to
   * return the full replay. Lets UI callers that only render the tail avoid
   * transferring the entire history over the RPC boundary.
   */
  readonly replayTurnLimit?: number;
  readonly sessionStartedProperties?: TelemetryProperties;
  /** Kaos (remote/isolated execution environment) session target, if any. */
  readonly kaos?: Kaos | undefined;
  /** Secondary persistence environment; falls back to `kaos` when set. */
  readonly persistenceKaos?: Kaos | undefined;
}

export interface ReloadSessionInput extends ResumeSessionInput {
  readonly forcePluginSessionStartReminder?: boolean;
}

export interface AddAdditionalDirInput {
  readonly id: string;
  readonly path: string;
  readonly persist: boolean;
}

export interface AddAdditionalDirOptions {
  /** When true, share the directory through workspace local config. When false,
   * keep it scoped to this session while still restoring it on session resume. */
  readonly persist: boolean;
}

export interface ForkSessionInput {
  readonly id: string;
  readonly forkId?: string;
  readonly title?: string;
  readonly metadata?: JsonObject;
  /**
   * Zero-based index of the user-visible turn to retain through. Omit it to
   * preserve the existing full-session fork behavior.
   */
  readonly turnIndex?: number;
}

export interface ExportSessionInput {
  readonly id: string;
  readonly outputPath?: string | undefined;
  readonly includeGlobalLog?: boolean | undefined;
  /** Host version to record in the export manifest. */
  readonly version: string;
  /** How the CLI was installed (e.g. 'npm-global', 'native'). */
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
}

export interface ExportSessionResult {
  readonly zipPath: string;
  readonly entries: readonly string[];
  readonly sessionDir: string;
  readonly manifest: ExportSessionManifest;
}

export interface ListSessionsOptions {
  readonly workDir?: string;
  readonly sessionId?: string;
  /**
   * Include archived sessions in the listing. Defaults to non-archived only.
   */
  readonly includeArchived?: boolean;
  /**
   * Maximum number of summaries in one page. Only consulted by
   * `listSessionsPage`; plain `listSessions` always returns the whole
   * filtered set.
   */
  readonly limit?: number;
  /** Keyset cursor: return the page strictly older than this session id. */
  readonly before?: string;
}

export interface SessionSummaryPage {
  readonly items: readonly SessionSummary[];
  /** Pass as `before` for the next older page; absent when the listing is exhausted. */
  readonly nextCursor?: string;
}

export interface GetConfigOptions {
  readonly reload?: boolean | undefined;
}

export interface AuthenticateMcpServerOptions {
  readonly onAuthorizationUrl: (url: string) => void | boolean | PromiseLike<void | boolean>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

export interface TestMcpServerOptions {
  readonly cwd?: string;
}

export interface CompactOptions {
  readonly instruction?: string | undefined;
}

export interface ReloadSessionOptions {
  readonly forcePluginSessionStartReminder?: boolean;
}

export interface PlanInfo {
  readonly id: string;
  readonly content: string;
  readonly path: string;
}

export type SessionPlan = PlanInfo | null;

export type SessionTodoStatus = 'pending' | 'in_progress' | 'done';

export interface SessionTodoItem {
  readonly title: string;
  readonly status: SessionTodoStatus;
}

export interface TokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface SessionUsage {
  readonly byModel?: Record<string, TokenUsage> | undefined;
  readonly currentTurn?: TokenUsage | undefined;
  readonly total?: TokenUsage | undefined;
}

export interface SessionStatus {
  readonly model?: string;
  readonly thinkingEffort: string;
  readonly permission: PermissionMode;
  readonly planMode: boolean;
  readonly swarmMode?: boolean;
  readonly towerMode?: boolean;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly contextUsage: number;
  readonly usage?: SessionUsage;
}

/**
 * The engine's canonical title state: `replaceable` (a prompt-derived easy
 * title auto generation may overwrite), `generated` (an auto-generated title
 * already landed), `custom` (a user-set title that is never overwritten).
 * Only populated by the v2 engine on live / resumed sessions (read off the
 * metadata document); v1 backends leave it undefined, and the v2 list path
 * does not project it.
 */
export type SessionTitleKind = 'replaceable' | 'generated' | 'custom';

export interface SessionSummary {
  readonly id: string;
  readonly title?: string | undefined;
  readonly titleKind?: SessionTitleKind;
  readonly lastPrompt?: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived?: boolean | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly additionalDirs?: readonly string[];
  /** Terminal outcome of the session's latest main turn, when one ended. */
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export interface AddAdditionalDirResult {
  readonly additionalDirs: readonly string[];
  readonly projectRoot: string;
  readonly configPath: string;
  readonly persisted: boolean;
}

/* ------------------------------------------------------------------ */
/*  Resumed session snapshot (v1 wire shape, kept as the SDK contract) */
/* ------------------------------------------------------------------ */

export type AgentType = 'main' | 'sub';

/**
 * One agent's snapshot within a resumed session — the v1 shape, kept as the
 * SDK's public contract: `toolStore` and `background` are v1-only concepts
 * (the v2 engine reports `tasks` instead of `background` and has no
 * tool-store projection), so the v2 client folds them from the agent wire.
 */
export interface ResumedAgentState {
  readonly type: AgentType;
  readonly config: ResumedAgentConfigData;
  readonly context: AgentContextData;
  readonly replay: readonly AgentReplayRecord[];
  readonly permission: PermissionData;
  readonly plan: PlanData | null;
  readonly swarmMode?: boolean | undefined;
  readonly usage: UsageStatus;
  readonly tools: readonly ToolInfo[];
  readonly toolStore?: Readonly<Record<string, unknown>>;
  readonly background: readonly BackgroundTaskInfo[];
}

/** The per-agent config snapshot of a resumed session (v1 wire shape). */
export interface ResumedAgentConfigData {
  readonly cwd: string;
  readonly provider?: ProviderConfig;
  readonly modelAlias?: string;
  readonly modelCapabilities: ModelCapability;
  readonly profileName?: string;
  readonly subagentNames?: readonly string[];
  readonly thinkingEffort: string;
  readonly systemPrompt: string;
}

/** Session metadata document (v1 wire shape, kept as the SDK contract). */
export interface AgentMeta {
  readonly homedir?: string;
  readonly type: AgentType;
  readonly parentAgentId?: string | null;
  readonly swarmItem?: string;
}

export interface SessionMeta {
  createdAt: string;
  updatedAt: string;
  title: string;
  isCustomTitle: boolean;
  lastPrompt?: string;
  forkedFrom?: string;
  /** Absolute working directory the session was created in. */
  workDir?: string;
  /** Directories added for this session only. */
  additionalDirs?: string[];
  agents: Record<string, AgentMeta>;
  custom: Record<string, any>;
}

export interface ResumeSessionResult extends SessionSummary {
  readonly sessionMetadata: SessionMeta;
  readonly agents: Readonly<Record<string, ResumedAgentState>>;
  readonly warning?: string | undefined;
}

export type ResumedSessionState = Pick<
  ResumeSessionResult,
  'sessionMetadata' | 'agents' | 'warning'
>;

export interface ResumedSessionSummary extends SessionSummary, ResumedSessionState {}

export interface AgentRuntimeBinding {
  readonly workspaceId: string;
  readonly runtimeId: string;
}

/**
 * Unified management-plane view of a global MCP server: the named config
 * entry flattened to the top level and tagged with its registry metadata
 * (mutable entries keep the full values, read-only ones the redacted key
 * lists). Plugin, project, and user entries normalize into this shape for
 * RPC consumers.
 */
export type McpManagedServerInfo = GlobalMcpServerConfig & {
  readonly source: McpServerSource;
  /** global: defining file path; plugin: plugin id. */
  readonly origin: string;
  readonly mutable: boolean;
  readonly plugin?: McpRegistryPluginOrigin;
  /** Set instead of `env` / `headers` when the entry is read-only. */
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
};
