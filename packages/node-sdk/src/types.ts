import type {
  AgentContextData,
  AgentReplayRecord,
  AgentTaskInfo,
  AgentTaskStatus,
  ContextMessage,
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
  ExportSessionManifest,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
  PermissionData,
  PlanData,
  PluginCommandDef,
  PluginGithubMetadata,
  PluginGithubRef,
  PluginInfo,
  PluginMcpServerInfo,
  PluginSource,
  TurnEngine,
  PluginSummary,
  PromptOrigin,
  ReloadSummary,
  ShellEnvironment,
  SkillSummary,
  ToolInfo,
  UsageStatus,
} from '@moonshot-ai/agent-core-v2';
import type { AgentCommandInfo } from '@moonshot-ai/agent-core-v2/agent/command/agentCommand';
import type {
  McpRegistryPluginOrigin,
  McpServerSource,
} from '@moonshot-ai/agent-core-v2/app/mcpRegistry/mcpRegistry';
import type { CapabilityStatus } from '@moonshot-ai/agent-core-v2/app/capability/types';
import type { McpServerEntry } from '@moonshot-ai/agent-core-v2/mcpCore/connection-manager';
import type { Kaos } from '@moonshot-ai/kaos';
import type { KimiHostIdentity, OAuthRefreshOutcome } from '@moonshot-ai/kimi-code-oauth';
import type { ContentPart, ModelCapability } from '@moonshot-ai/kosong';

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
import type { TelemetryClient, TelemetryContextPatch, TelemetryProperties } from '#/legacy';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type Unsubscribe = () => void;

export type { CapabilityStatus };

export type { AgentReplayRecord };

export type BackgroundTaskInfo = AgentTaskInfo;
export type BackgroundTaskStatus = AgentTaskStatus;

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

export type { McpServerLocator } from '@moonshot-ai/agent-core-v2/app/mcpManagement/mcpManagement';
export type { McpServerInspection as AppMcpServerInspection } from '@moonshot-ai/agent-core-v2/app/mcpManagement/mcpManagement';

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

export type { PermissionData, PlanData, UsageStatus };
export type {
  ContextMessage,
  PromptOrigin,
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
  ExportSessionManifest,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
  PluginCommandDef,
  PluginGithubMetadata,
  PluginGithubRef,
  PluginInfo,
  PluginMcpServerInfo,
  PluginSource,
  PluginSummary,
  ReloadSummary,
  ShellEnvironment,
  SkillSummary,
  ToolInfo,
  AgentCommandInfo,
};
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
export type { TelemetryClient, TelemetryContextPatch, TelemetryProperties } from '#/legacy';
export type { ContentPart, Role, ThinkingEffort, ToolCall } from '@moonshot-ai/kosong';

export type PermissionMode = 'yolo' | 'manual' | 'auto';

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
export type { FileMeta } from '@moonshot-ai/agent-core-v2/app/file/fileService';

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
  readonly engineOverride?: TurnEngine | undefined;
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
  readonly plan: PlanData;
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
