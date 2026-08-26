/**
 * TUI2 shared types.
 *
 * Mirrors `tui/types.ts` with imports converged onto the tui2 tree. Pure
 * type surface — no pi-tui / opentui dependency, so it stays framework-free.
 *
 * Status: REAL (tui2). Mirrors `tui/types.ts`.
 */

import type {
  GoalChange,
  GoalSnapshot,
  ModelAlias,
  PermissionMode,
  ProviderConfig,
  PromptPart,
  ThinkingEffort,
  ToolInputDisplay,
} from '@moonshot-ai/kimi-code-sdk';

import type { NotificationsConfig, StatusLineConfig, UpgradePreferences } from './config';
import type { PendingApproval, PendingQuestion } from './reverse-rpc/types';
import type { ColorToken, ThemeName } from './theme';

export type BannerDisplay = 'always' | 'once' | 'cooldown';

export interface BannerState {
  key: string;
  tag: string | null;
  mainText: string;
  subText: string | null;
  display: BannerDisplay;
  ttlHours?: number;
}

export interface AppState {
  model: string;
  workDir: string;
  additionalDirs: readonly string[];
  sessionId: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  /** Resolved profile name from --agent/--agent-file, carried to the
   * lazy-created first session when the TUI starts session-less. */
  agentProfile?: string;
  /** Raw --agent-file paths, passed to session creation alongside `agentProfile`. */
  agentFiles?: readonly string[];
  /** 'bash' when the editor is in `!` shell-command mode. */
  inputMode: 'prompt' | 'bash';
  swarmMode: boolean;
  /** Live thinking effort of the active session (e.g. 'off', 'on', 'high');
   * mirrors the runtime. The single source of truth for the thinking state in
   * the TUI. */
  thinkingEffort: ThinkingEffort;
  /**
   * The current `defaultPlanMode` value from config (false when absent),
   * refreshed by `hydrateLazyConfigDefaults`. Used to tell a config-driven
   * plan-mode entry apart from an explicit CLI `--plan` when lazy-creating
   * the first session (the engine applies the config default itself).
   */
  configDefaultPlanMode?: boolean;
  /**
   * Session-only thinking effort chosen (e.g. via the model picker's Alt+S)
   * while no session exists yet on the v2 engine. Applied to the first
   * lazy-created session and cleared once it exists; the engine's config
   * default is used instead when unset.
   */
  lazySessionThinking?: ThinkingEffort;
  contextUsage: number;
  contextTokens: number;
  maxContextTokens: number;
  /** Session-cumulative cache-hit input tokens (exact hit rate = read/(read+creation)). */
  cacheReadTokens: number;
  /** Session-cumulative cache-write input tokens (i.e. cache misses, cache_creation). */
  cacheMissTokens: number;
  /**
   * Session-cumulative plain (non-cache) input tokens, used as a fallback for
   * the "hit share of total input" ratio when cache-write data is missing
   * (otherwise read/(read+0) is always 100%).
   */
  cacheOtherTokens: number;
  /** Model output speed of the most recent step (tokens/second). */
  tokenSpeed: number;
  /** Session-level cumulative stats (turns/steps/elapsed/tokens), shown on the footer's second line; valid for the TUI lifetime. */
  sessionStats: SessionStats;
  isCompacting: boolean;
  isReplaying: boolean;
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell';
  streamingStartTime: number;
  outputTokens: number;
  locale: string;
  /** Pending step retry backoff (fed by `turn.step.retrying`); null when no retry is in flight. */
  stepRetry: StepRetryState | null;
  theme: ThemeName;
  version: string;
  editorCommand: string | null;
  /** Mirrors the TUI config toggle; defaults to false when absent from older fixtures. */
  disablePasteBurst?: boolean;
  /** LaTeX math rendering in Markdown; defaults to true when absent from older fixtures. */
  renderLatex?: boolean;
  /** Mirrors the TUI config toggle; defaults to true when absent from older fixtures. */
  cacheExpiryHint?: boolean;
  notifications: NotificationsConfig;
  upgrade: UpgradePreferences;
  /** Footer status line customization from tui.toml; absent means the default layout. */
  statusLine?: StatusLineConfig;
  availableModels: Record<string, ModelAlias>;
  availableProviders: Record<string, ProviderConfig>;
  sessionTitle: string | null;
  /** Current goal snapshot for the footer badge; null/undefined when no active goal. */
  goal?: GoalSnapshot | null;
  mcpServersSummary: string | null;
  /** Optional banner shown below the welcome panel; null means no banner to render. */
  banner?: BannerState | null;
}

/**
 * Session-level cumulative stats, shown on the footer's second line.
 * Data comes from `turn.started` / `turn.step.completed` / `tool.call.started`→`tool.result`
 * events and accumulates over the TUI lifetime (naturally reset by a new
 * session/restart, consistent with the cache* fields).
 */
export interface SessionStats {
  /** User turns (`turn.started`, excluding plugin-internal turns). */
  turnCount: number;
  /** LLM call steps (`turn.step.completed`). */
  stepCount: number;
  /** Cumulative LLM streaming time (`llmStreamDurationMs`), in milliseconds. */
  llmTotalMs: number;
  /** Cumulative tool-call time (timed TUI-side from `tool.call.started`→`tool.result`), in milliseconds. */
  toolTotalMs: number;
  /** `llmFirstTokenLatencyMs` samples, averaged at render time. */
  firstTokenSamples: number[];
  /** Cumulative input tokens (inputOther + inputCacheRead + inputCacheCreation). */
  inputTokens: number;
  /** Cumulative output tokens (exact usage.output value). */
  outputTokens: number;
}

export interface StepRetryState {
  /** Upcoming attempt number (1-based). */
  nextAttempt: number;
  maxAttempts: number;
  /** Backoff wait before the next attempt, in milliseconds. */
  delayMs: number;
  errorName: string;
  errorMessage: string;
  /** HTTP status code for `APIStatusError`; undefined for network/timeout failures. */
  statusCode?: number;
  /**
   * `backoff` while sleeping before the next attempt (label shows the
   * countdown); `attempt` once the `delayMs` backoff has elapsed and the next
   * attempt is running — the countdown has expired by then and is dropped.
   */
  phase: 'backoff' | 'attempt';
}

export interface ToolCallBlockData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  display?: ToolInputDisplay;
  streamingArguments?: string;
  streamingStartedAtMs?: number;
  /** Live `tool.progress` status lines while the call runs (replace-aware:
   *  `progressStatusRows` trailing rows form the swappable block). Never
   *  mixed into `streamingArguments` — that field renders the command
   *  preview, which running output must not pollute. */
  progressLines?: readonly string[];
  /** Number of trailing `progressLines` rows that a replacing status update
   *  (`update.replace === true`) swaps out. */
  progressStatusRows?: number;
  /** Combined live stdout/stderr of the running call; capped by the writer. */
  liveOutput?: string;
  /** Foreground Bash/Agent card advertising Ctrl+B while running. */
  detachHint?: boolean;
  result?: ToolResultBlockData;
  subagent?: SubagentReplayBlockData;
  step?: number;
  turnId?: string;
  /** Set when the step ended (e.g. max_tokens) before the tool call's
   *  arguments finished streaming. Renderer flips the header verb to
   *  "Truncated" and stops showing the in-progress argument preview. */
  truncated?: boolean;
  /** Terminal status of a backgrounded agent task, pushed from `task.terminated`. */
  backgroundStatus?: {
    status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
    errorText?: string;
  };
  /** Set when a foreground subagent card is detached to background (Ctrl+B). */
  backgrounded?: boolean;
}

export interface ToolResultBlockData {
  tool_call_id: string;
  output: string;
  is_error?: boolean;
  synthetic?: boolean;
}

export interface SubagentReplayToolCallData {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  result?: ToolResultBlockData;
}

export interface SubagentReplayBlockData {
  id: string;
  name?: string;
  text?: string;
  /** Display name of the bound model (resolved at spawn / status update). */
  model?: string;
  toolCalls?: readonly SubagentReplayToolCallData[];
}

export interface BackgroundAgentMetadata {
  readonly agentId: string;
  readonly parentToolCallId: string;
  readonly agentName?: string;
  readonly description?: string;
  /** Display name of the model the agent is bound to (resolved at spawn). */
  readonly model?: string;
  /** Thinking effort, set only for concrete levels (boolean on/off hidden). */
  readonly effort?: string;
}

export type BackgroundAgentStatusPhase =
  | 'started'
  | 'completed'
  | 'failed'
  | 'lost'
  | 'killed'
  | 'timed_out';

export interface BackgroundAgentStatusData {
  readonly phase: BackgroundAgentStatusPhase;
  readonly headline: string;
  readonly detail?: string;
}

/** Minimal per-member state of a live AgentSwarm, published incrementally by
 *  the subagent event handler and converged at terminal lifecycle events. */
export interface AgentSwarmMemberData {
  readonly id: string;
  readonly name: string;
  status: 'queued' | 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';
  /** Latest activity phase (current tool-call name); absent until observed. */
  phase?: string;
  /** Epoch ms when the member started running; absent while queued. */
  startedAt?: number;
  /** Epoch ms when the member reached a terminal state; freezes its elapsed time. */
  endedAt?: number;
}

/** Live AgentSwarm progress summary carried by a tool-call transcript entry
 *  (see `controllers/subagent-event-handler.ts` `publishSwarmProgress`). */
export interface AgentSwarmProgressData {
  toolCallId: string;
  description: string;
  status: 'streaming' | 'running' | 'ended' | 'cancelled';
  memberCount: number;
  completedCount: number;
  failedCount: number;
  /** Per-member minimal state in spawn order; empty until members spawn. */
  members: readonly AgentSwarmMemberData[];
}

export interface CompactionTranscriptData {
  readonly result?: 'cancelled';
  readonly summary?: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly instruction?: string;
}

export interface CronTranscriptData {
  readonly jobId?: string;
  readonly cron?: string;
  readonly recurring?: boolean;
  readonly coalescedCount?: number;
  readonly stale?: boolean;
  readonly missedCount?: number;
}

export type GoalTranscriptData =
  | { readonly kind: 'created' }
  | { readonly kind: 'lifecycle'; readonly change: GoalChange };

export type TranscriptEntryKind =
  | 'welcome'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'thinking'
  | 'status'
  | 'skill_activation'
  | 'plugin_command'
  | 'cron'
  | 'goal';

export type SkillActivationTrigger = 'user-slash' | 'model-tool' | 'nested-skill';

export interface PluginCommandTranscriptData {
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly args?: string;
  readonly trigger: 'user-slash';
}

export interface TranscriptEntry {
  id: string;
  kind: TranscriptEntryKind;
  turnId?: string;
  renderMode: 'markdown' | 'plain' | 'notice';
  content: string;
  /**
   * True only for entries holding real model-authored text (created by the
   * assistant stream). Derived cards — hook results, goal completions, goal
   * reminders — share kind 'assistant' but are not replies, so /copy must
   * skip them.
   */
  modelText?: boolean;
  color?: ColorToken;
  detail?: string;
  /** Optional override for the leading bullet of a 'user' message entry. An empty string suppresses the bullet entirely (used by shell-command echoes so `$` replaces the sparkles marker). */
  bullet?: string;
  /** Transcript-navigation mode: whether this entry is expanded (tool calls, thinking, goal markers). */
  expanded?: boolean;
  /** Transcript-navigation mode: whether this entry is the focused one. */
  navigated?: boolean;
  /** Grouping key for tool-call entries (Agent/Read groups); entries sharing
   *  a key render as one group. */
  groupKey?: string;
  toolCallData?: ToolCallBlockData;
  backgroundAgentStatus?: BackgroundAgentStatusData;
  compactionData?: CompactionTranscriptData;
  cronData?: CronTranscriptData;
  goalData?: GoalTranscriptData;
  /** Set on the derived 'assistant' card built from a goal-completion snapshot
   * (distinct from real model-authored text; lets rendering avoid localizing /
   * string-matching the message content to pick the goal-completion card). */
  goalCompletionData?: boolean;
  /** Step-summary entry (folded thinking/tool/assistant counts). */
  stepSummary?: boolean;
  /** Counts folded into a step-summary entry. */
  stepSummaryCounts?: { thinking: number; tool: number; assistant: number };
  /** Swarm-mode entry/exit marker data. */
  swarmData?: { state: 'active' | 'inactive' | 'ended' };
  /** Live AgentSwarm progress summary for a tool-call entry. */
  agentSwarmData?: AgentSwarmProgressData;
  imageAttachmentIds?: readonly number[];
  videoAttachmentIds?: readonly number[];
  skillActivationId?: string;
  skillName?: string;
  skillArgs?: string;
  skillTrigger?: SkillActivationTrigger;
  /** Card belongs to the following prompt's bundled submission: undo removes them together. */
  bundledWithPrompt?: boolean;
  pluginCommandData?: PluginCommandTranscriptData;
}

export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowRunData {
  readonly runId: string;
  readonly name: string;
  readonly status: WorkflowStatus;
  readonly currentPhase?: string;
  readonly agentCount: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
}

export const MAX_VISIBLE_RUNS = 5;

/** A todo item shown in the todo panel (TodoList tool). */
export interface TodoItem {
  readonly title: string;
  readonly status: 'pending' | 'in_progress' | 'done';
  /** Tree node id from the TodoList tool; absent for legacy flat lists. */
  readonly id?: string;
  /** Parent node id; null/undefined for top-level rows. */
  readonly parentId?: string | null;
  /** Milestone rows group their children into a progress-summarized branch. */
  readonly kind?: 'milestone' | 'task';
  /** Leaf progress (0..100) for in-progress rows. */
  readonly progress?: number;
}

/** Background task counts for the footer badge. */
export interface BackgroundCounts {
  readonly bashTasks: number;
  readonly agentTasks: number;
}

/** One row of the right-side agent status panel. */
export interface AgentPaneItem {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'waiting' | 'done' | 'error';
  readonly detail?: string;
}

/** One file-change row of the diff review panel. */
export interface DiffReviewItem {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

/** Tasks-browser dialog state (store-backed; no component instances). */
export interface TasksBrowserState {
  /** Latest task list snapshot (kept in sync by the tasks-browser controller). */
  tasks: readonly import('@moonshot-ai/kimi-code-sdk').BackgroundTaskInfo[];
  filter: 'all' | 'active';
  selectedTaskId: string | undefined;
  tailOutput: string | undefined;
  tailLoading: boolean;
  /** Monotonic request id guarding stale tail fetches. */
  tailRequestId: number;
  flashMessage: string | undefined;
  viewer:
    | {
        taskId: string;
        output: string;
        kind: 'output' | 'activity';
        /** Last `agentId:version` fed to the activity viewer; polls skip when unchanged. */
        lastRecordKey?: string;
      }
    | undefined;
}

export type LivePaneMode = 'idle' | 'waiting' | 'thinking' | 'tool' | 'session';

/** The dialog currently open on top of the shell; null when none. */
export type ActiveDialog =
  | 'approval-panel'
  | 'cache-hint'
  | 'editor-selector'
  | 'effort-selector'
  | 'experiments-selector'
  | 'goal-queue-edit'
  | 'goal-queue-manager'
  | 'goal-start-permission-prompt'
  | 'help'
  | 'locale-selector'
  | 'migration'
  | 'model-selector'
  | 'msys2-prompt'
  | 'permission-selector'
  | 'plugins-confirm'
  | 'plugins-mcp'
  | 'plugins-selector'
  | 'question-dialog'
  | 'session-picker'
  | 'settings-selector'
  | 'start-permission-prompt'
  | 'swarm-start-permission-prompt'
  | 'theme-selector'
  | 'trust-prompt'
  | 'tasks-browser'
  | 'undo-selector'
  | 'update-preference'
  | 'which-key'
  | null;

export interface LivePaneState {
  mode: LivePaneMode;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
  /** User toggle for the activity pane (leader+b). */
  activityPaneVisible: boolean;
}

export interface QueuedMessage {
  readonly text: string;
  readonly agentId?: string;
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly videoAttachmentIds?: readonly number[];
  /** `bash` for a `!` shell command queued while another command is running;
   *  undefined (=`prompt`) for a normal message. A queued skill activation
   *  keeps `prompt` mode and is recognized by its `skillName` payload. */
  readonly mode?: 'prompt' | 'bash';
  /** Skill activation payload; a queued item carrying these re-enters
   *  through `sendSkillActivation` when the queue drains (v1 behavior). */
  readonly skillName?: string;
  readonly skillArgs?: string;
}

export interface InlineSkillActivation {
  readonly skillName: string;
  /**
   * Skill arguments. Only set for a leading `/skill:<name> args` command that
   * is combined with further inline skills; inline tokens carry no args.
   */
  readonly args?: string;
}

/**
 * One unit of Ctrl-S steer input: a queued message or the editor draft,
 * with the media parts extracted at submit/paste time so images and video
 * tags survive the steer path (which accepts full prompt parts, not just
 * text).
 */
export interface SteerInputItem {
  readonly text: string;
  readonly parts?: readonly PromptPart[];
  readonly imageAttachmentIds?: readonly number[];
  readonly videoAttachmentIds?: readonly number[];
}

export const INITIAL_LIVE_PANE: LivePaneState = {
  mode: 'idle',
  pendingApproval: null,
  pendingQuestion: null,
  activityPaneVisible: true,
};

// ---------------------------------------------------------------------------
// TUI startup / options types (extracted from kimi-tui.ts)
// ---------------------------------------------------------------------------

export interface TUIStartupOptions {
  readonly sessionFlag?: string;
  readonly continueLast: boolean;
  readonly yolo: boolean;
  readonly auto: boolean;
  readonly plan: boolean;
  readonly model?: string;
  /** Resolved profile name from --agent/--agent-file; bound to the startup session only. */
  readonly agentProfile?: string;
  /** Raw --agent-file paths, passed to session creation alongside `agentProfile`. */
  readonly agentFiles?: readonly string[];
  readonly startupNotice?: string;
}

export type TUIStartupState = 'pending' | 'ready' | 'picker';

export interface KimiTUIOptions {
  initialAppState: AppState;
  startup: TUIStartupOptions;
}

export interface PendingExit {
  readonly kind: 'ctrl-c' | 'ctrl-d';
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface LoginProgressSpinnerHandle {
  stop(opts: { ok: boolean; label: string }): void;
  setLabel(label: string): void;
}

export type ProgressSpinnerHandle = LoginProgressSpinnerHandle;
