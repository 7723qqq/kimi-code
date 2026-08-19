/** @jsxImportSource @opentui/solid */
/**
 * TUI2 response state core.
 *
 * This is the opentui + SolidJS replacement for the v1 pi-tui `TUIState`
 * (a command tree of Containers). It holds the whole interactive view model
 * in a single SolidJS store (`createStore`) and exposes it to components via
 * a Context provider — the same architecture opencode uses for its TUI.
 *
 * The store is the single source of truth: event adapters (`event.ts`) and
 * command handlers mutate it with `produce` / `reconcile`, and the opentui
 * reconciler re-renders whatever subscribes to the changed slice. There is
 * no `requestRender()` / `addChild()` imperative plumbing — components react
 * to store slices automatically.
 *
 * Status: REAL (tui2). New file — no v1 counterpart to re-export.
 */

import { createContext, Show, useContext, type ParentProps } from 'solid-js'
import { createStore, produce, reconcile, type SetStoreFunction } from 'solid-js/store'

import type {
  GoalSnapshot,
  ModelAlias,
  PermissionMode,
  ProviderConfig,
  ThinkingEffort,
} from '@moonshot-ai/kimi-code-sdk'

import type {
  NotificationsConfig,
  StatusLineConfig,
  UpgradePreferences,
} from './config'
import type { PendingApproval, PendingQuestion } from './reverse-rpc/types'
import type { SessionRow } from './components/dialogs/session-picker'
import type { ThemeName } from './theme'
import { createTerminalState, type TerminalState } from './utils/terminal-state'
import type {
  ActiveDialog,
  AgentPaneItem,
  BackgroundCounts,
  BannerState,
  DiffReviewItem,
  LivePaneMode,
  QueuedMessage,
  SessionStats,
  StepRetryState,
  TasksBrowserState,
  TodoItem,
  TranscriptEntry,
  TUIStartupState,
  WorkflowRunData,
} from './types'

/** A turn's streaming buffers, keyed by turnId. */
export interface TurnStream {
  /** Accumulated assistant text from `assistant.delta`. */
  assistantText: string
  /** Accumulated thinking text from `thinking.delta`. */
  thinkingText: string
  /** Tool calls keyed by toolCallId, live arguments merged from `tool.call.delta`. */
  toolCalls: Record<string, StreamToolCall>
}

export interface StreamToolCall {
  id: string
  name?: string
  /** Accumulated partial JSON arguments. */
  argumentsText: string
  finished?: boolean
}

export interface TuiRuntimeState {
  /** Current session id (empty until a session exists). */
  sessionId: string
  /** Working directory mirrored from startup. */
  workDir: string
  /** Extra working directories attached via /add-dir. */
  additionalDirs: readonly string[]
  model: string
  permissionMode: PermissionMode
  planMode: boolean
  /** Resolved profile name from --agent/--agent-file, carried to the
   * lazy-created first session when the TUI starts session-less. */
  agentProfile?: string
  /** Raw --agent-file paths, passed to session creation alongside `agentProfile`. */
  agentFiles?: readonly string[]
  /** The current `defaultPlanMode` value from config (false when absent). */
  configDefaultPlanMode?: boolean
  /** Session-only thinking effort chosen while no session exists yet. */
  lazySessionThinking?: ThinkingEffort
  thinkingEffort: ThinkingEffort
  inputMode: 'prompt' | 'bash'
  swarmMode: boolean
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell'
  streamingStartTime: number
  /** Transcript entries in display order. */
  transcript: TranscriptEntry[]
  /** Live streaming buffers for the active turn. */
  streams: Record<string, TurnStream>
  /** Live activity-pane mode + pending reverse-RPC modals. */
  livePane: {
    mode: LivePaneMode
    pendingApproval: PendingApproval | null
    pendingQuestion: PendingQuestion | null
    activityPaneVisible: boolean
  }
  /** Live workflow runs for the workflow panel (Workflow tool). */
  workflowRuns: readonly WorkflowRunData[]
  /** Live BTW (interactive agent) panel state; `active` false when closed. */
  btwPanel: {
    active: boolean
    agentId: string
    answer: string
    thinking: string
    running: boolean
    done: boolean
    failed: string | null
    transientNotice: string | null
    scrollOffset: number
  }
  /** Editor draft text (mirrors the input line; also used by BTW busy notice). */
  editorDraft: string
  /** Editor border highlight state (plan/bash/slash context). */
  editorBorderHighlighted: boolean
  /** Editor border color token. */
  editorBorderToken: 'shellMode' | 'primary' | 'border'
  /** Autocomplete provider (slash commands + file mentions). */
  autocompleteProvider: unknown
  /** Right-side agent pane visibility. */
  agentPaneVisible: boolean
  /** Right-side diff review pane visibility. */
  diffReviewPaneVisible: boolean
  /** Todo panel expansion state. */
  todoPanelExpanded: boolean
  /** Leader-chord overlay visibility. */
  leaderOverlayVisible: boolean
  /** Queued messages waiting for the current turn to end. */
  queuedMessages: readonly QueuedMessage[]
  /** True while a queued user message has been shifted out of
   * `queuedMessages` but its deferred send has not run yet. */
  queuedMessageDispatchPending: boolean
  /** Sorted list of sessions for the picker. */
  sessions: readonly SessionRow[]
  loadingSessions: boolean
  /** Keyset cursor for the next older page; `undefined` when the listing is exhausted. */
  sessionsNextCursor: string | undefined
  /** A follow-up session page fetch is in flight. */
  sessionsLoadingMore: boolean
  sessionsScope: 'cwd' | 'all'
  /** Session title (footer). */
  sessionTitle: string | null
  /** Context usage fraction (0..1) of the active session. */
  contextUsage: number
  contextTokens: number
  maxContextTokens: number
  /** Session-cumulative cache-hit input tokens. */
  cacheReadTokens: number
  /** Session-cumulative cache-write input tokens (cache misses). */
  cacheMissTokens: number
  /** Session-cumulative plain (non-cache) input tokens. */
  cacheOtherTokens: number
  /** Model output speed of the most recent step (tokens/second). */
  tokenSpeed: number
  /** Session-level cumulative stats, shown on the footer's second line. */
  sessionStats: SessionStats
  isCompacting: boolean
  isReplaying: boolean
  outputTokens: number
  locale: string
  /** Pending step retry backoff; null when no retry is in flight. */
  stepRetry: StepRetryState | null
  theme: ThemeName
  version: string
  editorCommand: string | null
  disablePasteBurst: boolean
  renderLatex: boolean
  cacheExpiryHint: boolean
  notifications: NotificationsConfig
  upgrade: UpgradePreferences
  /** Footer status line customization from tui.toml; absent means the default layout. */
  statusLine?: StatusLineConfig
  availableModels: Record<string, ModelAlias>
  availableProviders: Record<string, ProviderConfig>
  /** Current goal snapshot for the footer badge; null when no active goal. */
  goal: GoalSnapshot | null
  mcpServersSummary: string | null
  /** Optional banner shown below the welcome panel; null means no banner. */
  banner: BannerState | null
  /** Startup phase of the TUI shell. */
  startupState: TUIStartupState
  /** The dialog currently open on top of the shell; null when none. */
  activeDialog: ActiveDialog
  /** Choices for the open undo selector; undefined when none. */
  undoChoices: readonly { id: string; count: number; input: string; label: string }[] | undefined
  /** Plugins panel dialog state; null when closed. */
  pluginsPanel: {
    installed: readonly import('@moonshot-ai/kimi-code-sdk').PluginSummary[]
    installedIds: ReadonlySet<string>
    capabilities: readonly import('@moonshot-ai/kimi-code-sdk').CapabilityStatus[]
    catalogIsDefault: boolean
    initialTab?: string
    selectedId?: string
    pluginHint?: { id: string; text: string }
    marketplace?: { plugins: readonly unknown[]; source: string }
    marketplaceError?: string
    marketplaceLoading: boolean
    installing?: string
  } | null
  /** Plugin MCP picker dialog state; null when closed. */
  pluginMcpPicker: {
    info: import('@moonshot-ai/kimi-code-sdk').PluginInfo
    selectedServer?: string
    serverHint?: { server: string; text: string }
  } | null
  /** Plugin remove/trust confirmation; null when none. */
  pluginConfirm: { kind: 'remove'; id: string; displayName: string } | { kind: 'trust'; label: string } | null
  /** Resolver for the open plugin confirmation. */
  pluginConfirmResolver: ((confirmed: boolean) => void) | undefined
  /** Data for the open cache-hint dialog; null when none. */
  cacheHintDialog: { idleSeconds: number; totalTokens: number } | null
  /** Transient footer hint (clipboard image hint, key hints). */
  footerTransientHint: string | null
  /** Transcript navigation mode (j/k/Enter/Esc). */
  transcriptNav: {
    active: boolean
    index: number
  }
  /** True while an external $EDITOR is running. */
  externalEditorRunning: boolean
  /** Whether tool outputs render expanded. */
  toolOutputExpanded: boolean
  /** Todo items from the TodoList tool (todo panel). */
  todoItems: readonly TodoItem[]
  /** Background task counts for the footer badge. */
  backgroundCounts: BackgroundCounts
  /** Right-side agent status panel items. */
  agentPaneItems: readonly AgentPaneItem[]
  /** Right-side diff review panel items. */
  diffReviewItems: readonly DiffReviewItem[]
  /** Live progress spinner (login / msys2 install); null when none. */
  progressSpinner: { label: string } | null
  /** Live `!` shell output entries keyed by commandId. */
  shellOutputs: Record<string, { content: string; taskId?: string; finished?: boolean }>
  /** Current activity-pane loading tip. */
  activityTip: string | undefined
  /** Tasks-browser dialog state; undefined when closed. */
  tasksBrowser: TasksBrowserState | undefined
  /** Terminal capability snapshot (focus, notification support). */
  terminalState: TerminalState
  /** How swarm mode was entered ('task' auto-promotes queued goals). */
  swarmModeEntry: 'manual' | 'task' | undefined
}

export const INITIAL_RUNTIME: TuiRuntimeState = {
  sessionId: '',
  workDir: '',
  additionalDirs: [],
  model: '',
  permissionMode: 'manual',
  planMode: false,
  thinkingEffort: 'off',
  inputMode: 'prompt',
  swarmMode: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  transcript: [],
  streams: {},
  livePane: {
    mode: 'idle',
    pendingApproval: null,
    pendingQuestion: null,
    activityPaneVisible: true,
  },
  workflowRuns: [],
  btwPanel: {
    active: false,
    agentId: '',
    answer: '',
    thinking: '',
    running: false,
    done: false,
    failed: null,
    transientNotice: null,
    scrollOffset: 0,
  },
  editorDraft: '',
  editorBorderHighlighted: false,
  editorBorderToken: 'border',
  autocompleteProvider: undefined,
  agentPaneVisible: true,
  diffReviewPaneVisible: false,
  todoPanelExpanded: false,
  leaderOverlayVisible: false,
  queuedMessages: [],
  queuedMessageDispatchPending: false,
  sessions: [],
  loadingSessions: false,
  sessionsNextCursor: undefined,
  sessionsLoadingMore: false,
  sessionsScope: 'cwd',
  sessionTitle: null,
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  cacheReadTokens: 0,
  cacheMissTokens: 0,
  cacheOtherTokens: 0,
  tokenSpeed: 0,
  sessionStats: {
    turnCount: 0,
    stepCount: 0,
    llmTotalMs: 0,
    toolTotalMs: 0,
    firstTokenSamples: [],
    inputTokens: 0,
    outputTokens: 0,
  },
  isCompacting: false,
  isReplaying: false,
  outputTokens: 0,
  locale: 'en',
  stepRetry: null,
  theme: 'auto',
  version: '',
  editorCommand: null,
  disablePasteBurst: false,
  renderLatex: true,
  cacheExpiryHint: true,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  availableModels: {},
  availableProviders: {},
  goal: null,
  mcpServersSummary: null,
  banner: null,
  startupState: 'pending',
  activeDialog: null,
  undoChoices: undefined,
  pluginsPanel: null,
  pluginMcpPicker: null,
  pluginConfirm: null,
  pluginConfirmResolver: undefined,
  cacheHintDialog: null,
  footerTransientHint: null,
  transcriptNav: {
    active: false,
    index: 0,
  },
  externalEditorRunning: false,
  toolOutputExpanded: false,
  todoItems: [],
  backgroundCounts: { bashTasks: 0, agentTasks: 0 },
  agentPaneItems: [],
  diffReviewItems: [],
  progressSpinner: null,
  shellOutputs: {},
  activityTip: undefined,
  tasksBrowser: undefined,
  terminalState: createTerminalState(),
  swarmModeEntry: undefined,
}

export interface Tui2Store {
  readonly state: TuiRuntimeState
  readonly setState: SetStoreFunction<TuiRuntimeState>
}

export interface Tui2StoreInit {
  workDir?: string;
  additionalDirs?: readonly string[];
  model?: string;
  permissionMode?: PermissionMode;
  planMode?: boolean;
  thinkingEffort?: ThinkingEffort;
  locale?: string;
  theme?: ThemeName;
  version?: string;
  editorCommand?: string | null;
  disablePasteBurst?: boolean;
  renderLatex?: boolean;
  cacheExpiryHint?: boolean;
  notifications?: NotificationsConfig;
  upgrade?: UpgradePreferences;
  statusLine?: StatusLineConfig;
  agentProfile?: string;
  agentFiles?: readonly string[];
}

export function createTui2Store(input?: Tui2StoreInit): Tui2Store {
  const [state, setState] = createStore<TuiRuntimeState>({
    ...INITIAL_RUNTIME,
    workDir: input?.workDir ?? process.cwd(),
    additionalDirs: [...(input?.additionalDirs ?? [])],
    model: input?.model ?? '',
    permissionMode: input?.permissionMode ?? 'manual',
    planMode: input?.planMode ?? false,
    thinkingEffort: input?.thinkingEffort ?? 'off',
    locale: input?.locale ?? 'en',
    theme: input?.theme ?? 'auto',
    version: input?.version ?? '',
    editorCommand: input?.editorCommand ?? null,
    disablePasteBurst: input?.disablePasteBurst ?? false,
    renderLatex: input?.renderLatex ?? true,
    cacheExpiryHint: input?.cacheExpiryHint ?? true,
    notifications: input?.notifications ?? { enabled: true, condition: 'unfocused' },
    upgrade: input?.upgrade ?? { autoInstall: true },
    statusLine: input?.statusLine,
    agentProfile: input?.agentProfile,
    agentFiles: input?.agentFiles,
  })
  return { state, setState }
}

const Ctx = createContext<Tui2Store>()

export function Tui2StoreProvider(props: ParentProps<{ store: Tui2Store }>) {
  return (
    <Show when={props.store}>
      <Ctx.Provider value={props.store}>{props.children}</Ctx.Provider>
    </Show>
  )
}

export function useTui2Store(): Tui2Store {
  const ctx = useContext(Ctx)
  if (ctx === undefined) throw new Error('Tui2StoreProvider missing')
  return ctx
}

export { produce, reconcile }
