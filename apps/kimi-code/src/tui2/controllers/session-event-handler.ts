/**
 * TUI2 session event handler — session events → response store.
 *
 * Mirrors `tui/controllers/session-event-handler.ts`. The v1 controller
 * mounted pi-tui components (StatusMessageComponent, SwarmModeMarkerComponent,
 * goal markers, MCP status rows) into the transcript Container; the tui2
 * version appends transcript entries to the response store and the opentui
 * reconciler renders them.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type {
  BackgroundTaskInfo,
  Event,
  GoalChange,
  Session,
  SessionMetaUpdatedEvent,
  TokenUsage,
} from '@moonshot-ai/kimi-code-sdk';
import { log } from '@moonshot-ai/kimi-code-sdk';

/** Narrowed event shapes consumed by the private handlers below. */
type StatusUpdatedEvent = Extract<Event, { type: 'agent.status.updated' }>;
type TurnStartedEvent = Extract<Event, { type: 'turn.started' }>;
type TurnEndedEvent = Extract<Event, { type: 'turn.ended' }>;
type TurnStepStartedEvent = Extract<Event, { type: 'turn.step.started' }>;
type TurnStepCompletedEvent = Extract<Event, { type: 'turn.step.completed' }>;
type TurnStepInterruptedEvent = Extract<Event, { type: 'turn.step.interrupted' }>;
type TurnStepRetryingEvent = Extract<Event, { type: 'turn.step.retrying' }>;
type CronFiredEvent = Extract<Event, { type: 'cron.fired' }>;
type ErrorEvent = Extract<Event, { type: 'error' }>;
type WarningEvent = Extract<Event, { type: 'warning' }>;
type GoalUpdatedEvent = Extract<Event, { type: 'goal.updated' }>;
type HookResultEvent = Extract<Event, { type: 'hook.result' }>;
type SkillActivatedEvent = Extract<Event, { type: 'skill.activated' }>;
type PluginCommandActivatedEvent = Extract<Event, { type: 'plugin_command.activated' }>;
type ThinkingDeltaEvent = Extract<Event, { type: 'thinking.delta' }>;
type AssistantDeltaEvent = Extract<Event, { type: 'assistant.delta' }>;
type ToolCallDeltaEvent = Extract<Event, { type: 'tool.call.delta' }>;
type ToolCallStartedEvent = Extract<Event, { type: 'tool.call.started' }>;
type ToolProgressEvent = Extract<Event, { type: 'tool.progress' }>;
type ToolResultEvent = Extract<Event, { type: 'tool.result' }>;
type CompactionStartedEvent = Extract<Event, { type: 'compaction.started' }>;
type CompactionCompletedEvent = Extract<Event, { type: 'compaction.completed' }>;
type CompactionCancelledEvent = Extract<Event, { type: 'compaction.cancelled' }>;
type BackgroundTaskEvent = Extract<Event, { type: 'task.started' | 'task.terminated' }>;

import { t } from '#/i18n';
import type { ColorToken } from '../theme';
import { openUrl } from '#/utils/open-url';
import { formatStepDebugTiming } from '#/utils/usage/debug-timing';

import { createGoal as startGoalCommand } from '../commands/goal';
import { errorReportHintLine } from '../constant/feedback';
import {
  getOauthLoginRequiredStartupNotice,
  OAUTH_LOGIN_REQUIRED_CODE,
} from '../constant/kimi-tui';
import {
  readGoalQueue,
  removeGoalQueueItem,
  restoreGoalQueueItem,
  type UpcomingGoal,
} from '../goal-queue-store';
import type { Tui2Store } from '../state';
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  SkillActivationTrigger,
  TodoItem,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import { formatBackgroundTaskTranscript } from '../utils/background-task-status';
import {
  argsRecord,
  formatErrorPayload,
  formatErrorMessage,
  isTodoItemShape,
  serializeToolResultOutput,
  stringValue,
} from '../utils/event-payload';
import { buildGoalCompletionMessage } from '../utils/goal-completion';
import { formatHookResultMarkdown } from '../utils/hook-result-format';
import { McpOAuthAuthorizationUrlOpener } from '../utils/mcp-oauth';
import {
  formatMcpStartupStatusSummary,
  mcpServerStatusKey,
  type McpServerStatusSnapshot,
  selectMcpStartupStatusRows,
} from '../utils/mcp-server-status';
import { nextTranscriptId } from '../utils/transcript-id';
import type { BtwPanelController } from './btw-panel';
import { isPluginMcpToolName, PluginUpdateNotifier } from './plugin-update-notifier';
import type { StreamingUIController } from './streaming-ui';
import { SubAgentEventHandler } from './subagent-event-handler';

/** The slice of the tasks-browser controller the event handler drives. */
export interface TasksBrowserControllerLike {
  repaint(): void;
  refreshOutputViewer(options: { silent: boolean }): Promise<void>;
}

export interface SessionEventHost {
  store: Tui2Store;
  session: Session | undefined;
  aborted: boolean;
  sessionEventUnsubscribe: (() => void) | undefined;
  readonly streamingUI: StreamingUIController;

  requireSession(): Session;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  updateActivityPane(): void;
  track(event: string, props?: Record<string, unknown>): void;
  recordSessionActivity(): void;
  noteStepUsage(usage: TokenUsage | undefined): void;
  noteStepCacheStats(usage: TokenUsage | undefined, streamDurationMs: number | undefined): void;
  noteSessionTurnStarted(): void;
  noteSessionStepCompleted(
    usage: TokenUsage | undefined,
    llmStreamDurationMs: number | undefined,
    llmFirstTokenLatencyMs: number | undefined,
  ): void;
  noteSessionToolCompleted(deltaMs: number): void;
  noteCompactionFinished(): void;
  mountEditorReplacement(panel: unknown): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  handleShellOutput(event: { commandId: string; update: { kind: string; text?: string } }): void;
  handleShellStarted(event: { commandId: string; taskId: string }): void;
  sendNormalUserInput(text: string): void;
  updateTerminalTitle(): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;
  shiftQueuedMessage(): QueuedMessage | undefined;
  /** Activate a skill directly; queued skill activations dispatch here when
   *  the queue drains (mirrors v1 `sendQueuedMessage`). */
  sendSkillActivation?(session: Session, skillName: string, skillArgs: string): void;
  /** Whether `skillName` was bundled into the prompt currently dispatching
   *  (v2 `promptWithSkills`); drives the skill card's prompt grouping. */
  hasPendingBundledSkill?(skillName: string): boolean;
  /** Transcript id of the user entry dispatched with the running prompt —
   *  the grouping window for cards bundled into that submission. */
  lastDispatchedUserEntryId?: string;
  readonly btwPanelController: BtwPanelController;
  readonly tasksBrowserController: TasksBrowserControllerLike;
}

/**
 * Estimate token count from text content. Matches the heuristic used by
 * the native token estimator in tokens.rs: ASCII chars ≈ 4/token,
 * non-ASCII (CJK, emoji) ≈ 1/token.
 */
function estimateTokensFromText(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if ((text.codePointAt(i) ?? 0) < 128) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

// Caps mirrored from v1 ToolCallComponent so a chatty tool can't grow the
// stored card data without bound.
const MAX_PROGRESS_LINES = 24;
const MAX_LIVE_OUTPUT_CHARS = 50_000;

/**
 * Flush cadence for coalesced `tool.progress` patches. Matches the streaming
 * UI flush cadence: 20 fps is well above what a terminal repaints.
 */
export const TOOL_PROGRESS_COALESCE_MS = 50;

type PendingProgressUpdate =
  | { readonly kind: 'status'; readonly text: string; readonly replace: boolean }
  | { readonly kind: 'output'; readonly text: string };

/**
 * Coalesces rapid-fire `tool.progress` updates (chatty Bash stdout arrives
 * every few ms) into one transcript store patch per flush interval. Without
 * this, each event costs an O(transcript) array rebuild plus an O(50KB)
 * liveOutput string copy — the worst path in busy-shell sessions.
 *
 * `flushNow()` must be called before any consumer reads the patched state:
 * tool results, phase changes and session switches do so eagerly.
 */
class ToolProgressCoalescer {
  private readonly pendingByEntry = new Map<string, PendingProgressUpdate[]>();
  private detachEntryIds = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly schedule: (fn: () => void) => ReturnType<typeof setTimeout>,
    private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void,
    private readonly applyPatches: (
      pendingByEntry: ReadonlyMap<string, PendingProgressUpdate[]>,
      detachEligible: ReadonlySet<string>,
    ) => void,
  ) {}

  add(entryId: string, update: PendingProgressUpdate, detachEligible: boolean): void {
    let updates = this.pendingByEntry.get(entryId);
    if (updates === undefined) {
      updates = [];
      this.pendingByEntry.set(entryId, updates);
    }
    updates.push(update);
    if (detachEligible) this.detachEntryIds.add(entryId);
    if (this.timer === undefined) {
      this.timer = this.schedule(() => this.flushNow());
    }
  }

  /** Apply every buffered patch immediately (tool result / turn end / reset). */
  flushNow(): void {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
    if (this.pendingByEntry.size === 0) return;
    const pending = new Map(this.pendingByEntry);
    const detach = this.detachEntryIds;
    this.pendingByEntry.clear();
    this.detachEntryIds = new Set();
    this.applyPatches(pending, detach);
  }

  hasPending(): boolean {
    return this.timer !== undefined || this.pendingByEntry.size > 0;
  }

  dispose(): void {
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
    this.pendingByEntry.clear();
    this.detachEntryIds.clear();
  }
}

/** Append a `tool.progress` status line to the card's progress block. With
 *  `replace`, the previous replaceable status rows are swapped out first
 *  (periodic "still working" updates would otherwise pile up stale rows);
 *  oldest rows drop once the buffer passes {@link MAX_PROGRESS_LINES}. */
function appendToolProgressLine(
  data: ToolCallBlockData,
  text: string,
  replace: boolean,
): void {
  const lines = data.progressLines ?? [];
  const kept =
    replace && (data.progressStatusRows ?? 0) > 0
      ? lines.slice(0, lines.length - Math.min(data.progressStatusRows ?? 0, lines.length))
      : [...lines];
  const appended = text.split('\n');
  kept.push(...appended);
  while (kept.length > MAX_PROGRESS_LINES) kept.shift();
  data.progressLines = kept;
  data.progressStatusRows = replace ? appended.length : 0;
}

/** Append a live stdout/stderr chunk, head-truncating past
 *  {@link MAX_LIVE_OUTPUT_CHARS} with v1's marker. */
function appendToolLiveOutput(data: ToolCallBlockData, text: string): void {
  const combined = `${data.liveOutput ?? ''}${text}`;
  data.liveOutput =
    combined.length > MAX_LIVE_OUTPUT_CHARS
      ? `[...truncated]\n${combined.slice(combined.length - MAX_LIVE_OUTPUT_CHARS)}`
      : combined;
}

/** Normalize a TodoList tool result into store items, keeping the tool's tree
 *  fields (id/parentId/kind/progress) so the panel's milestone branch gets
 *  real data; only title/status-carrying rows are accepted. */
function normalizeTranscriptTodos(raw: readonly unknown[]): TodoItem[] {
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (!isTodoItemShape(entry)) continue;
    const rec = entry as unknown as Record<string, unknown>;
    const progressRaw = rec['progress'];
    items.push({
      id: typeof rec['id'] === 'string' && rec['id'].length > 0 ? rec['id'] : undefined,
      parentId:
        typeof rec['parentId'] === 'string' && rec['parentId'].length > 0
          ? rec['parentId']
          : null,
      kind: rec['kind'] === 'milestone' ? 'milestone' : 'task',
      title: entry.title,
      status: entry.status,
      progress:
        typeof progressRaw === 'number' && Number.isFinite(progressRaw)
          ? Math.min(100, Math.max(0, Math.round(progressRaw)))
          : undefined,
    });
  }
  return items;
}

export class SessionEventHandler {
  readonly subAgentEventHandler: SubAgentEventHandler;
  private readonly pluginUpdateNotifier: PluginUpdateNotifier;

  constructor(
    private readonly host: SessionEventHost,
    pluginUpdateNotifier?: PluginUpdateNotifier,
  ) {
    this.progressCoalescer = new ToolProgressCoalescer(
      (fn) => setTimeout(fn, TOOL_PROGRESS_COALESCE_MS),
      (timer) => clearTimeout(timer),
      (pendingByEntry, detachEligible) => {
        for (const [entryId, updates] of pendingByEntry) {
          this.patchToolCallEntry(entryId, (data) => {
            let detach = detachEligible.has(entryId);
            for (const update of updates) {
              if (update.kind === 'status') {
                appendToolProgressLine(data, update.text, update.replace);
              } else {
                appendToolLiveOutput(data, update.text);
              }
              if (detachEligible.has(entryId)) detach = true;
            }
            if (detach) data.detachHint = true;
          });
        }
      },
    );
    this.subAgentEventHandler = new SubAgentEventHandler(host, {
      backgroundTasks: this.backgroundTasks,
      backgroundTaskTranscriptedTerminal: this.backgroundTaskTranscriptedTerminal,
      syncBackgroundAgentBadge: () => {
        this.syncBackgroundTaskBadge();
      },
    });
    this.pluginUpdateNotifier =
      pluginUpdateNotifier ??
      new PluginUpdateNotifier({
        getSession: () => this.host.session,
        workDir: host.store.state.workDir,
        notify: (message) => {
          this.host.showStatus(message, 'warning');
        },
      });
  }

  // Runtime state – owned by this handler, reset between sessions.
  backgroundTasks: Map<string, BackgroundTaskInfo> = new Map();
  backgroundTaskTranscriptedTerminal: Set<string> = new Set();

  renderedSkillActivationIds: Set<string> = new Set();
  renderedPluginCommandActivationIds: Set<string> = new Set();
  renderedMcpServerStatusKeys: Map<string, string> = new Map();
  mcpServers: Map<string, McpServerStatusSnapshot> = new Map();
  private goalCompletionAwaitingClear = false;
  private goalCompletionTurnEnded = false;
  private currentTurnHasAssistantText = false;
  private pluginCommandTurns: Map<string, string> = new Map();
  private pluginMcpToolsUsedInTurn: Set<string> = new Set();
  /** `tool.call.started` timestamps for the footer tool-duration stat; entries
   *  are removed when the matching `tool.result` arrives. */
  private toolStartTimes: Map<string, number> = new Map();
  private pendingModelBlockedFallback: GoalChange | undefined;
  private queuedGoalPromotionPending = false;
  private queuedGoalPromotionInFlight = false;
  private queuedGoalPromotionTimer: ReturnType<typeof setTimeout> | undefined;
  private stepRetryAttemptTimer: ReturnType<typeof setTimeout> | undefined;
  /** Buffered `tool.progress` patches, applied once per coalesce interval. */
  private readonly progressCoalescer: ToolProgressCoalescer;

  resetRuntimeState(): void {
    this.progressCoalescer.dispose();
    this.backgroundTasks.clear();
    this.backgroundTaskTranscriptedTerminal.clear();
    this.subAgentEventHandler.resetRuntimeState();
    this.renderedSkillActivationIds.clear();
    this.renderedPluginCommandActivationIds.clear();
    this.renderedMcpServerStatusKeys.clear();
    this.mcpServers.clear();
    this.goalCompletionAwaitingClear = false;
    this.goalCompletionTurnEnded = false;
    this.currentTurnHasAssistantText = false;
    this.pluginCommandTurns.clear();
    this.pluginMcpToolsUsedInTurn.clear();
    this.pendingModelBlockedFallback = undefined;
    this.queuedGoalPromotionPending = false;
    this.queuedGoalPromotionInFlight = false;
    this.clearQueuedGoalPromotionTimer();
    // Clear the retry timer AND the stale `stepRetry` appState — switching
    // sessions mid-backoff must not leave the previous session's countdown.
    this.clearStepRetry();
  }

  clearAgentSwarmProgress(): void {
    this.subAgentEventHandler.clearAgentSwarmProgress();
  }

  hasActiveAgentSwarmToolCall(): boolean {
    return this.subAgentEventHandler.hasActiveAgentSwarmToolCall();
  }

  startSubscription(): void {
    const { host } = this;
    const session = host.requireSession();
    const sendQueued = (item: QueuedMessage): void => {
      // A queued slash-skill activation re-enters through the activation path,
      // not as a literal prompt (mirrors v1 `sendQueuedMessage`).
      if (item.skillName !== undefined) {
        host.sendSkillActivation?.(session, item.skillName, item.skillArgs ?? '');
        return;
      }
      host.sendQueuedMessage(session, item);
    };
    host.sessionEventUnsubscribe?.();
    const mcpOAuthOpener = new McpOAuthAuthorizationUrlOpener(openUrl);
    const { sessionId } = host.store.state;
    host.sessionEventUnsubscribe = session.onEvent((event) => {
      if (host.aborted) return;
      if (event.sessionId !== sessionId) return;
      if (event.type === 'tool.progress') {
        mcpOAuthOpener.handleToolProgress(event);
      }
      this.handleEvent(event, sendQueued);
    });
    void this.syncMcpServerStatusSnapshot(session);
  }

  async syncMcpServerStatusSnapshot(session: Session): Promise<void> {
    const { host } = this;
    let servers: readonly McpServerStatusSnapshot[];
    try {
      servers = await session.listMcpServers();
    } catch (error) {
      if (host.session !== session || host.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      host.showError(t('tui.statusMessages.failedToSyncMcp', { message }));
      return;
    }
    if (host.session !== session || host.store.state.sessionId !== session.id) return;

    const visible = selectMcpStartupStatusRows(servers);
    const visibleNames = new Set(visible.map((server) => server.name));
    for (const server of visible) {
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderMcpServerStatus(server);
    }

    this.mcpServers.clear();
    for (const server of servers) {
      this.mcpServers.set(server.name, server);
    }
    const hidden: McpServerStatusSnapshot[] = [];
    for (const server of servers) {
      if (visibleNames.has(server.name)) continue;
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderedMcpServerStatusKeys.set(server.name, mcpServerStatusKey(server));
      hidden.push(server);
    }
    const summary = formatMcpStartupStatusSummary(servers);
    host.setAppState({ mcpServersSummary: summary || null });
  }

  handleEvent(event: Event, sendQueued: (item: QueuedMessage) => void): void {
    if (this.subAgentEventHandler.routeChildAgentEvent(event)) return;

    if ('turnId' in event && event.turnId !== undefined) {
      this.host.streamingUI.setTurnId(String(event.turnId));
    }

    switch (event.type) {
      case 'turn.started':
        this.handleTurnBegin(event);
        break;
      case 'turn.ended':
        this.handleTurnEnd(event, sendQueued);
        break;
      case 'turn.step.started':
        this.handleStepBegin(event);
        break;
      case 'turn.step.interrupted':
        this.handleStepInterrupted(event);
        break;
      case 'turn.step.completed':
        this.handleStepCompleted(event);
        break;
      case 'turn.step.retrying':
        this.handleStepRetrying(event);
        break;
      case 'tool.progress':
        this.handleToolProgress(event);
        break;
      case 'shell.output':
        this.host.handleShellOutput(event);
        break;
      case 'shell.started':
        this.host.handleShellStarted(event);
        break;
      case 'assistant.delta':
        this.handleAssistantDelta(event);
        break;
      case 'hook.result':
        this.handleHookResult(event);
        break;
      case 'thinking.delta':
        this.handleThinkingDelta(event);
        break;
      case 'tool.call.started':
        this.handleToolCall(event);
        break;
      case 'tool.call.delta':
        this.handleToolCallDelta(event);
        break;
      case 'tool.result':
        this.handleToolResult(event);
        break;
      case 'agent.status.updated':
        this.handleStatusUpdate(event);
        break;
      case 'session.meta.updated':
        this.handleSessionMetaChanged(event);
        break;
      case 'goal.updated':
        this.handleGoalUpdated(event);
        break;
      case 'skill.activated':
        this.handleSkillActivated(event);
        break;
      case 'plugin_command.activated':
        this.handlePluginCommandActivated(event);
        break;
      case 'error':
        this.handleSessionError(event);
        break;
      case 'warning':
        this.handleSessionWarning(event);
        break;
      case 'compaction.started':
        this.handleCompactionBegin(event);
        break;
      case 'compaction.completed':
        this.handleCompactionEnd(event, sendQueued);
        break;
      case 'compaction.blocked':
        break;
      case 'compaction.cancelled':
        this.handleCompactionCancel(event, sendQueued);
        break;
      case 'subagent.spawned':
      case 'subagent.started':
      case 'subagent.suspended':
      case 'subagent.completed':
      case 'subagent.failed':
        this.subAgentEventHandler.handleLifecycleEvent(event);
        break;
      case 'task.started':
      case 'task.terminated':
        this.handleBackgroundTaskEvent(event);
        break;
      case 'cron.fired':
        this.handleCronFired(event);
        break;
      case 'mcp.server.status':
        this.renderMcpServerStatus(event.server);
        break;
      case 'tool.list.updated':
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Private handlers
  // ---------------------------------------------------------------------------

  private handleTurnBegin(event: TurnStartedEvent): void {
    this.currentTurnHasAssistantText = false;
    if (event.origin?.kind === 'plugin_command') {
      this.pluginCommandTurns.set(String(event.turnId), event.origin.pluginId);
    } else {
      this.host.noteSessionTurnStarted();
    }
    this.clearAgentSwarmProgress();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.setStep(0);
    this.host.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.host.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  private handleCronFired(event: CronFiredEvent): void {
    this.host.streamingUI.flushNow();
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'cron',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: event.prompt,
      cronData: {
        jobId: event.origin.jobId,
        cron: event.origin.cron,
        recurring: event.origin.recurring,
        coalescedCount: event.origin.coalescedCount,
        stale: event.origin.stale,
      },
    });
  }

  private handleTurnEnd(event: TurnEndedEvent, sendQueued: (item: QueuedMessage) => void): void {
    this.host.streamingUI.flushNow();
    this.clearStepRetry();
    if (event.reason === 'cancelled') {
      this.markActiveAgentSwarmsCancelled();
    }
    // Aborted foreground subagents emit no completed/failed lifecycle event
    // (v2 suppresses it for aborts), so their activity records would linger
    // until the session reset — prune them when the owning turn ends.
    this.subAgentEventHandler.dropForegroundOnlyActivityRecords();
    // A tool interrupted by the turn end (abort, max_tokens without result)
    // would otherwise leave a stale start timestamp that a later same-id
    // result could match — drop the whole map at the turn boundary.
    this.toolStartTimes.clear();
    if (event.reason === 'failed' && event.error?.code === 'provider.filtered') {
      this.host.showStatus(t('tui.statusMessages.turnStoppedFiltered'), 'error');
    }
    if (event.reason === 'blocked') {
      this.host.showStatus(t('tui.statusMessages.turnStoppedBlocked'), 'error');
    }
    const todos = this.host.store.state.todoItems;
    if (todos.length > 0 && todos.every((todo) => todo.status === 'done')) {
      this.host.streamingUI.setTodoList([]);
    }
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeTurn(sendQueued);
    this.host.recordSessionActivity();
    this.renderPendingModelBlockedFallback();
    this.currentTurnHasAssistantText = false;
    this.goalCompletionTurnEnded = true;
    // Plugin usage is reported once the whole turn's output has ended — but a
    // cancelled turn cut the output short, so skip the notice there.
    const reportPluginUsage = event.reason !== 'cancelled';
    const pluginCommandPluginId = this.pluginCommandTurns.get(String(event.turnId));
    if (pluginCommandPluginId !== undefined) {
      this.pluginCommandTurns.delete(String(event.turnId));
      if (reportPluginUsage) {
        void this.pluginUpdateNotifier.handlePluginCommandCompleted(pluginCommandPluginId);
      }
    }
    if (reportPluginUsage) {
      for (const toolName of this.pluginMcpToolsUsedInTurn) {
        void this.pluginUpdateNotifier.handleMcpToolCompleted(toolName);
      }
    }
    this.pluginMcpToolsUsedInTurn.clear();
    this.scheduleQueuedGoalPromotion();
  }

  private handleStepBegin(event: TurnStepStartedEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.setStep(event.step);
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('waiting');
    this.host.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.host.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  private handleStepCompleted(event: TurnStepCompletedEvent): void {
    this.host.streamingUI.flushNow();
    this.clearStepRetry();
    this.host.noteStepUsage(event.usage);
    this.host.noteStepCacheStats(event.usage, event.llmStreamDurationMs);
    this.host.noteSessionStepCompleted(
      event.usage,
      event.llmStreamDurationMs,
      event.llmFirstTokenLatencyMs,
    );
    this.maybeShowDebugTiming(event);

    if (event.providerFinishReason === 'filtered') {
      this.host.showNotice(
        t('tui.statusMessages.policyBlocked'),
        t('tui.statusMessages.outputFiltered', {
          reason: event.rawFinishReason ?? 'content_filter',
        }),
      );
      return;
    }

    if (event.finishReason !== 'max_tokens') return;

    const truncatedCount = this.host.streamingUI.markStepTruncated(
      String(event.turnId),
      event.step,
    );

    const title =
      truncatedCount > 0
        ? t('tui.statusMessages.maxTokensTruncated')
        : t('tui.statusMessages.maxTokensNoToolCall');
    const detail = this.isAnthropicSessionActive()
      ? t('tui.statusMessages.maxTokensHint')
      : undefined;
    this.host.showNotice(title, detail);
  }

  private handleStepRetrying(event: TurnStepRetryingEvent): void {
    // The failure may arrive mid-stream, after thinking/assistant deltas have
    // parked the pane in `thinking`/`composing` — drive it back to waiting so
    // the retry label and detail actually render during the backoff.
    this.host.patchLivePane({ mode: 'waiting' });
    this.host.setAppState({
      streamingPhase: 'waiting',
      stepRetry: {
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
        phase: 'backoff',
      },
    });
    // Both engines sleep for `delayMs` before the next attempt runs, but only
    // v2 re-emits `turn.step.started` for it — flip the phase on a timer so the
    // stale countdown drops on the legacy engine too.
    this.clearStepRetryAttemptTimer();
    this.stepRetryAttemptTimer = setTimeout(() => {
      this.stepRetryAttemptTimer = undefined;
      const retry = this.host.store.state.stepRetry;
      if (retry === null) return;
      this.host.setAppState({ stepRetry: { ...retry, phase: 'attempt' } });
    }, event.delayMs);
  }

  private clearStepRetry(): void {
    this.clearStepRetryAttemptTimer();
    if (this.host.store.state.stepRetry === null) return;
    this.host.setAppState({ stepRetry: null });
  }

  clearStepRetryAttemptTimer(): void {
    if (this.stepRetryAttemptTimer !== undefined) {
      clearTimeout(this.stepRetryAttemptTimer);
      this.stepRetryAttemptTimer = undefined;
    }
  }

  private maybeShowDebugTiming(event: TurnStepCompletedEvent): void {
    if (process.env['KIMI_CODE_DEBUG'] !== '1') return;
    const text = formatStepDebugTiming(event);
    if (text === undefined) return;
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      turnId: String(event.turnId),
      renderMode: 'plain',
      content: text,
    });
  }

  private markActiveAgentSwarmsCancelled(): void {
    this.subAgentEventHandler.markActiveAgentSwarmsCancelled();
    // Data-side gap recorded in plan/tui2-full-replacement.md: the sub-agent
    // handler only flips its internal `cancelled` flag — its publisher never
    // emits a cancelled status. Fold still-running swarm summaries here so
    // the stored transcript reflects the aborted turn.
    this.host.store.setState('transcript', (entries) =>
      entries.map((entry) => {
        const swarm = entry.agentSwarmData;
        if (swarm === undefined) return entry;
        if (swarm.status !== 'streaming' && swarm.status !== 'running') return entry;
        return { ...entry, agentSwarmData: { ...swarm, status: 'cancelled' } };
      }),
    );
  }

  private isAnthropicSessionActive(): boolean {
    const { store } = this.host;
    const model = store.state.availableModels[store.state.model];
    if (model === undefined) return false;
    if (model.protocol === 'anthropic') return true;
    return store.state.availableProviders[model.provider]?.type === 'anthropic';
  }

  private handleStepInterrupted(event: TurnStepInterruptedEvent): void {
    this.host.streamingUI.flushNow();
    this.clearStepRetry();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('idle');
    const reason = event.reason;
    if (reason === 'error') return;
    if (reason === 'aborted' || reason === undefined || reason === '') {
      this.markActiveAgentSwarmsCancelled();
      if (event.message === undefined || event.message === '') {
        this.host.showStatus(t('tui.statusMessages.interruptedByUser'), 'error');
      } else {
        this.host.showError(event.message);
      }
      return;
    }
    this.host.showError(
      reason === 'max_steps'
        ? t('tui.statusMessages.stepMaxSteps')
        : t('tui.statusMessages.stepInterrupted', { reason }),
    );
  }

  private handleThinkingDelta(event: ThinkingDeltaEvent): void {
    const { store, streamingUI } = this.host;
    // Encrypted / redacted reasoning (e.g. Kimi over the Anthropic-compatible
    // protocol) streams thinking deltas whose visible text is empty — only an
    // opaque signature rides along. Models also occasionally stream whitespace-
    // only thinking (e.g. a single space). Such deltas carry nothing to render,
    // so switching into the `thinking` pane mode here would stop the "waiting"
    // moon spinner while no ThinkingComponent is ever created (it needs visible
    // text), leaving a blank, spinner-less gap until the first real text/tool
    // token arrives. Keep the moon up until actual thinking text shows up.
    if (event.delta.trim().length === 0 && !streamingUI.hasThinkingDraft()) return;
    streamingUI.appendThinkingDelta(event.delta);
    this.host.patchLivePane({ mode: 'idle' });
    if (store.state.streamingPhase !== 'thinking') {
      this.host.setAppState({
        streamingPhase: 'thinking',
        streamingStartTime: Date.now(),
        outputTokens: 0,
      });
    }
    this.host.setAppState({
      outputTokens: store.state.outputTokens + estimateTokensFromText(event.delta),
    });
    streamingUI.scheduleFlush();
  }

  private handleAssistantDelta(event: AssistantDeltaEvent): void {
    const { store, streamingUI } = this.host;
    if (streamingUI.hasThinkingDraft()) {
      streamingUI.flushThinkingToTranscript('idle');
    }

    if (event.delta.trim().length > 0) {
      this.currentTurnHasAssistantText = true;
      this.pendingModelBlockedFallback = undefined;
    }
    streamingUI.appendAssistantDelta(event.delta);

    this.host.patchLivePane({
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (store.state.streamingPhase !== 'composing') {
      this.host.setAppState({
        streamingPhase: 'composing',
        streamingStartTime: Date.now(),
        outputTokens: 0,
      });
    }
    this.host.setAppState({
      outputTokens: store.state.outputTokens + estimateTokensFromText(event.delta),
    });
    streamingUI.scheduleFlush();
  }

  private handleHookResult(event: HookResultEvent): void {
    this.host.streamingUI.flushNow();
    if (this.host.streamingUI.hasThinkingDraft()) {
      this.host.streamingUI.flushThinkingToTranscript('idle');
    }
    this.host.streamingUI.finalizeAssistantStream();
    if (event.content.trim().length > 0) {
      this.currentTurnHasAssistantText = true;
      this.pendingModelBlockedFallback = undefined;
    }
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'assistant',
      turnId: String(event.turnId),
      renderMode: 'markdown',
      content: formatHookResultMarkdown(event),
    });
    this.host.patchLivePane({
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  private handleToolCall(event: ToolCallStartedEvent): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    this.toolStartTimes.set(event.toolCallId, Date.now());
    const { turnId, step } = streamingUI.getTurnContext();
    const toolCall: ToolCallBlockData = {
      id: event.toolCallId,
      name: event.name,
      args: argsRecord(event.args),
      description: event.description,
      display: event.display,
      step,
      turnId,
    };
    streamingUI.registerToolCall(toolCall);
    if (event.name === 'AgentSwarm' || event.name === 'Team') {
      this.subAgentEventHandler.handleAgentSwarmToolCallStarted(event.toolCallId, toolCall.args);
    }
    this.host.patchLivePane({
      mode: 'tool',
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  private handleToolCallDelta(event: ToolCallDeltaEvent): void {
    if (event.toolCallId.length === 0) return;
    const { store, streamingUI } = this.host;
    streamingUI.accumulateToolCallDelta(event.toolCallId, event.name, event.argumentsPart);
    const preview = streamingUI.getStreamingToolCallPreview(event.toolCallId);
    if (
      preview !== undefined &&
      (preview.name === 'AgentSwarm' ||
        preview.name === 'Team' ||
        this.subAgentEventHandler.hasAgentSwarmProgress(event.toolCallId))
    ) {
      this.subAgentEventHandler.handleAgentSwarmToolCallDelta(event.toolCallId, preview.args, {
        streamingArguments: preview.argumentsText,
      });
    }

    this.host.patchLivePane({
      mode: 'tool',
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (store.state.streamingPhase !== 'composing') {
      this.host.setAppState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
    }
    streamingUI.scheduleFlush();
  }

  private handleToolProgress(event: ToolProgressEvent): void {
    const text = event.update.text;
    if (text === undefined || text.length === 0) return;
    const entryId = this.host.streamingUI.getToolComponent(event.toolCallId);
    if (entryId === undefined) return;
    const toolName = this.host.streamingUI.getActiveToolCall(event.toolCallId)?.name;
    // A progress event is evidence the call is still running in the
    // foreground; eligible tools advertise Ctrl+B from here on (v1 drove the
    // same hint with a per-card timer inside ToolCallComponent).
    const detachEligible = toolName === 'Bash' || toolName === 'Agent';

    // Semantic dispatch — progress must never land in `streamingArguments`:
    // that field renders the command preview, which running output would
    // pollute (v1 kept the same separation via appendProgress/appendLiveOutput).
    // Patches coalesce onto one per TOOL_PROGRESS_COALESCE_MS tick.
    if (event.update.kind === 'status') {
      this.progressCoalescer.add(
        entryId,
        { kind: 'status', text, replace: event.update.replace === true },
        detachEligible,
      );
      return;
    }
    if (event.update.kind === 'stdout' || event.update.kind === 'stderr') {
      this.progressCoalescer.add(entryId, { kind: 'output', text }, detachEligible);
    }
  }

  private handleToolResult(event: ToolResultEvent): void {
    const { streamingUI } = this.host;
    this.progressCoalescer.flushNow();
    streamingUI.flushNow();
    this.clearStepRetry();
    const startMs = this.toolStartTimes.get(event.toolCallId);
    this.toolStartTimes.delete(event.toolCallId);
    if (startMs !== undefined && event.synthetic !== true) {
      this.host.noteSessionToolCompleted(Date.now() - startMs);
    }
    const resultData: ToolResultBlockData = {
      tool_call_id: event.toolCallId,
      output: serializeToolResultOutput(event.output),
      is_error: event.isError,
      synthetic: event.synthetic,
    };
    const matchedCall = streamingUI.completeToolResult(event.toolCallId, resultData);
    if (matchedCall !== undefined && isPluginMcpToolName(matchedCall.name)) {
      // Buffer plugin MCP usage for the turn; the update notice fires once the
      // whole turn's output has ended (see handleTurnEnd).
      this.pluginMcpToolsUsedInTurn.add(matchedCall.name);
    }
    this.subAgentEventHandler.handleAgentSwarmToolResult(
      event.toolCallId,
      resultData,
      event.isError === true,
    );
    if (matchedCall !== undefined && matchedCall.name === 'TodoList' && !event.isError) {
      const rawTodos = (matchedCall.args as { todos?: unknown }).todos;
      if (Array.isArray(rawTodos)) {
        streamingUI.setTodoList(normalizeTranscriptTodos(rawTodos));
      }
    }
    this.host.patchLivePane({ mode: 'waiting' });
  }

  private handleStatusUpdate(event: StatusUpdatedEvent): void {
    const shouldRenderSwarmEnded =
      event.swarmMode === false &&
      this.host.store.state.swarmMode &&
      this.host.store.state.swarmModeEntry === 'task';
    const patch: Partial<AppState> = {};
    if (
      event.contextTokens !== undefined &&
      event.maxContextTokens !== undefined &&
      event.maxContextTokens > 0
    ) {
      patch.contextUsage = event.contextTokens / event.maxContextTokens;
    }
    if (event.contextTokens !== undefined) patch.contextTokens = event.contextTokens;
    if (event.maxContextTokens !== undefined) patch.maxContextTokens = event.maxContextTokens;
    if (event.planMode !== undefined) patch.planMode = event.planMode;
    if (event.swarmMode !== undefined) patch.swarmMode = event.swarmMode;
    if (event.model !== undefined) patch.model = event.model;
    if (event.thinkingEffort !== undefined) patch.thinkingEffort = event.thinkingEffort;
    if (Object.keys(patch).length > 0) this.host.setAppState(patch);
    if (event.swarmMode === false) {
      this.host.store.setState('swarmModeEntry', undefined);
      if (shouldRenderSwarmEnded) {
        this.renderSwarmModeMarker('ended');
      }
    }
  }

  private renderSwarmModeMarker(state: 'active' | 'inactive' | 'ended'): void {
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      renderMode: 'plain',
      content: '',
      swarmData: { state },
    });
  }

  private handleGoalUpdated(event: GoalUpdatedEvent): void {
    this.host.setAppState({ goal: event.snapshot });
    if (event.snapshot === null && this.goalCompletionAwaitingClear) {
      this.goalCompletionAwaitingClear = false;
      this.queuedGoalPromotionPending = true;
      this.scheduleQueuedGoalPromotion();
    }
    if (event.snapshot === null) {
      this.pendingModelBlockedFallback = undefined;
    }
    const change = event.change;
    if (change === undefined) return;

    // Completion -> the box disappears (snapshot cleared on the follow-up null
    // update) and a deterministic completion message lands in the transcript.
    // Resume renders the same text from the durable goal completion replay
    // record, so live and replayed completion cards stay identical.
    if (change.kind === 'completion' && event.snapshot !== null) {
      this.pendingModelBlockedFallback = undefined;
      this.goalCompletionAwaitingClear = true;
      this.goalCompletionTurnEnded = false;
      this.host.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'assistant',
        renderMode: 'markdown',
        content: buildGoalCompletionMessage(event.snapshot),
        goalCompletionData: true,
      });
      return;
    }

    // Lifecycle change (pause / resume / blocked) -> a low-profile,
    // ctrl+o-expandable marker.
    if (change.kind === 'lifecycle' && change.status === 'blocked') {
      void this.notifyQueuedGoalWaitingOnBlocked();
      if (change.actor === 'model' || change.reason === undefined) {
        this.pendingModelBlockedFallback = this.currentTurnHasAssistantText ? undefined : change;
        return;
      }
      this.pendingModelBlockedFallback = undefined;
    } else if (change.kind === 'lifecycle') {
      this.pendingModelBlockedFallback = undefined;
    }
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'goal',
      renderMode: 'plain',
      content: '',
      goalData: { kind: 'lifecycle', change },
      expanded: this.host.store.state.toolOutputExpanded,
    });
  }

  private renderPendingModelBlockedFallback(): void {
    const change = this.pendingModelBlockedFallback;
    if (change === undefined) return;
    this.pendingModelBlockedFallback = undefined;
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'goal',
      renderMode: 'plain',
      content: '',
      goalData: { kind: 'lifecycle', change },
      expanded: this.host.store.state.toolOutputExpanded,
    });
  }

  private scheduleQueuedGoalPromotion(): void {
    if (!this.queuedGoalPromotionPending || !this.goalCompletionTurnEnded) return;
    if (this.queuedGoalPromotionInFlight) return;
    if (this.queuedGoalPromotionTimer !== undefined) return;
    this.queuedGoalPromotionTimer = setTimeout(() => {
      this.queuedGoalPromotionTimer = undefined;
      if (!this.queuedGoalPromotionPending || !this.goalCompletionTurnEnded) return;
      if (this.queuedGoalPromotionInFlight) return;
      if (!this.isReadyForQueuedGoalPromotion()) {
        return;
      }
      this.queuedGoalPromotionInFlight = true;
      void this.promoteNextQueuedGoal()
        .then((complete) => {
          if (complete) {
            this.queuedGoalPromotionPending = false;
            this.goalCompletionTurnEnded = false;
            return;
          }
          this.goalCompletionTurnEnded = false;
        })
        .catch((error) => {
          // An unexpected failure must not surface as an unhandled rejection;
          // reset the pending state so a later turn can retry the promotion.
          this.queuedGoalPromotionPending = false;
          this.goalCompletionTurnEnded = false;
          log.error('Failed to promote queued goal', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.queuedGoalPromotionInFlight = false;
          this.scheduleQueuedGoalPromotion();
        });
    }, 0);
  }

  private clearQueuedGoalPromotionTimer(): void {
    if (this.queuedGoalPromotionTimer === undefined) return;
    clearTimeout(this.queuedGoalPromotionTimer);
    this.queuedGoalPromotionTimer = undefined;
  }

  requestQueuedGoalPromotion(): void {
    this.queuedGoalPromotionPending = true;
    this.goalCompletionTurnEnded = true;
    this.scheduleQueuedGoalPromotion();
  }

  retryQueuedGoalPromotion(): void {
    this.scheduleQueuedGoalPromotion();
  }

  private isReadyForQueuedGoalPromotion(session?: Session): boolean {
    return (
      (session === undefined || this.host.session === session) &&
      !this.host.aborted &&
      this.host.store.state.streamingPhase === 'idle' &&
      this.host.store.state.queuedMessages.length === 0 &&
      !this.host.store.state.queuedMessageDispatchPending
    );
  }

  private async promoteNextQueuedGoal(): Promise<boolean> {
    const { host } = this;
    const session = host.session;
    if (session === undefined || host.aborted) return true;

    let queue;
    try {
      queue = await readGoalQueue(session);
    } catch (error) {
      host.showError(
        t('tui.statusMessages.failedToReadUpcomingGoals', { error: formatErrorMessage(error) }),
      );
      return false;
    }
    if (host.session !== session || host.aborted) return true;

    const next = queue.goals[0];
    if (next === undefined) return true;

    if (!this.isReadyForQueuedGoalPromotion(session)) return false;

    const started = await startGoalCommand(
      {
        state: { appState: host.store.state },
        session: host.session,
        requireSession: () => host.requireSession(),
        setAppState: (patch) => host.setAppState(patch),
        showError: (msg) => host.showError(msg),
        showStatus: (msg, color) => host.showStatus(msg, color),
        track: (event, props) => host.track(event, props),
        mountEditorReplacement: (panel) => host.mountEditorReplacement(panel),
        restoreEditor: () => host.restoreEditor(),
        restoreInputText: (text) => host.restoreInputText(text),
        sendNormalUserInput: (text) => host.sendNormalUserInput(text),
        appendTranscriptEntry: (entry) => host.appendTranscriptEntry(entry),
      },
      { kind: 'create', objective: next.objective, replace: false },
      next.objective,
      {
        beforeSend: async () => {
          if (!this.isReadyForQueuedGoalPromotion(session)) {
            await this.cancelStartedQueuedGoal(session);
            return false;
          }
          try {
            await removeGoalQueueItem(session, { goalId: next.id });
          } catch (error) {
            host.showError(
              t('tui.statusMessages.queuedGoalRemoveFailed', { error: formatErrorMessage(error) }),
            );
            await this.cancelStartedQueuedGoal(session);
            return false;
          }
          if (this.isReadyForQueuedGoalPromotion(session)) {
            return true;
          }
          await this.restoreAndCancelStartedQueuedGoal(session, next);
          return false;
        },
        sendInput: (objective) => {
          host.sendQueuedMessage(session, { text: objective });
        },
      },
    );
    return started || host.session !== session || host.aborted;
  }

  private async restoreAndCancelStartedQueuedGoal(
    session: Session,
    goal: UpcomingGoal,
  ): Promise<void> {
    try {
      await restoreGoalQueueItem(session, goal);
    } catch (error) {
      this.host.showError(
        t('tui.statusMessages.queuedGoalRestoreFailed', { error: formatErrorMessage(error) }),
      );
    }
    await this.cancelStartedQueuedGoal(session);
  }

  private async cancelStartedQueuedGoal(session: Session): Promise<void> {
    try {
      await session.cancelGoal();
    } catch (error) {
      this.host.showError(
        t('tui.statusMessages.queuedGoalCancelFailed', { error: formatErrorMessage(error) }),
      );
    }
  }

  private async notifyQueuedGoalWaitingOnBlocked(): Promise<void> {
    const { host } = this;
    const session = host.session;
    if (session === undefined || host.aborted) return;

    let hasQueuedGoal = false;
    try {
      const queue = await readGoalQueue(session);
      hasQueuedGoal = queue.goals.length > 0;
    } catch {
      return;
    }
    if (!hasQueuedGoal || host.session !== session || host.aborted) return;

    host.showNotice(t('tui.statusMessages.goalBlocked'), t('tui.statusMessages.goalBlockedDetail'));
  }

  private handleSessionMetaChanged(event: SessionMetaUpdatedEvent): void {
    const title = event.title ?? stringValue(event.patch?.['title']);
    if (title !== undefined) {
      this.host.setAppState({ sessionTitle: title });
      this.host.updateTerminalTitle();
    }
  }

  private handleSessionError(event: ErrorEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('idle');
    if (event.code === OAUTH_LOGIN_REQUIRED_CODE) {
      this.host.showError(getOauthLoginRequiredStartupNotice());
      return;
    }
    this.host.showError(formatErrorPayload(event));
    const sessionId = this.host.store.state.sessionId;
    if (sessionId.length > 0) {
      this.host.showStatus(errorReportHintLine());
    }
  }

  private handleSessionWarning(event: WarningEvent): void {
    this.host.showStatus(
      t('tui.statusMessages.warningPrefix', { message: event.message }),
      'warning',
    );
  }

  private renderMcpServerStatus(server: McpServerStatusSnapshot): void {
    const key = mcpServerStatusKey(server);
    if (this.renderedMcpServerStatusKeys.get(server.name) === key) return;
    this.renderedMcpServerStatusKeys.set(server.name, key);
    this.mcpServers.set(server.name, server);
    const summary = formatMcpStartupStatusSummary([...this.mcpServers.values()]);
    this.host.setAppState({ mcpServersSummary: summary || null });

    switch (server.status) {
      case 'connected': {
        const message = t('tui.statusMessages.mcpServerConnected', {
          name: server.name,
          count: server.toolCount,
          transport: server.transport,
        });
        this.appendMcpStatusRow(message, 'success');
        return;
      }
      case 'failed': {
        const message =
          server.error !== undefined
            ? t('tui.statusMessages.mcpServerFailedWithError', {
                name: server.name,
                error: server.error,
              })
            : t('tui.statusMessages.mcpServerFailed', { name: server.name });
        this.appendMcpStatusRow(message, 'error');
        return;
      }
      case 'needs-auth': {
        const message = t('tui.statusMessages.mcpServerNeedsAuth', { name: server.name });
        this.appendMcpStatusRow(message, 'warning');
        return;
      }
      case 'disabled':
        this.appendMcpStatusRow(
          t('tui.statusMessages.mcpServerDisabled', { name: server.name }),
          'textMuted',
        );
        return;
      case 'removed':
        this.appendMcpStatusRow(
          t('tui.statusMessages.mcpServerRemoved', { name: server.name }),
          'textMuted',
        );
        return;
      case 'pending':
        this.appendMcpStatusRow(
          t('tui.statusMessages.mcpServerConnecting', { name: server.name }),
          'textMuted',
        );
        return;
    }
  }

  private appendMcpStatusRow(message: string, color: ColorToken): void {
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      renderMode: 'plain',
      content: message,
      color,
    });
  }

  private handleSkillActivated(event: SkillActivatedEvent): void {
    if (this.renderedSkillActivationIds.has(event.activationId)) return;
    this.renderedSkillActivationIds.add(event.activationId);
    const isBundled = this.host.hasPendingBundledSkill?.(event.skillName) ?? false;
    // Group with the prompt only while the transcript still ends with the user
    // message this activation was bundled into; otherwise append plainly.
    const lastEntry = this.host.store.state.transcript.at(-1);
    const beforeUserPrompt =
      isBundled && lastEntry !== undefined && lastEntry.id === this.host.lastDispatchedUserEntryId;
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'skill_activation',
      turnId: undefined,
      renderMode: 'plain',
      content: t('tui.statusMessages.activatedSkill', { skillName: event.skillName }),
      skillActivationId: event.activationId,
      skillName: event.skillName,
      skillArgs: event.skillArgs,
      // v2 declares `trigger` as a plain string; the engine only ever emits
      // the three `SkillActivationTrigger` values (see SkillActivationOrigin).
      skillTrigger: event.trigger as SkillActivationTrigger,
      bundledWithPrompt: beforeUserPrompt || undefined,
    };
    if (!beforeUserPrompt) {
      this.host.appendTranscriptEntry(entry);
      return;
    }
    const userEntryId = this.host.lastDispatchedUserEntryId;
    this.host.store.setState('transcript', (entries) => {
      const idx = entries.findIndex((candidate) => candidate.id === userEntryId);
      // The prompt's group window closed while the activation was in flight —
      // keep it, but as a plain trailing card.
      if (idx === -1) return [...entries, entry];
      return [...entries.slice(0, idx), entry, ...entries.slice(idx)];
    });
  }

  private handlePluginCommandActivated(event: PluginCommandActivatedEvent): void {
    if (this.renderedPluginCommandActivationIds.has(event.activationId)) return;
    this.renderedPluginCommandActivationIds.add(event.activationId);
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'plugin_command',
      turnId: undefined,
      renderMode: 'plain',
      content: `/${event.pluginId}:${event.commandName}`,
      pluginCommandData: {
        activationId: event.activationId,
        pluginId: event.pluginId,
        commandName: event.commandName,
        args: event.commandArgs,
        trigger: event.trigger,
      },
    });
  }

  private handleCompactionBegin(event: CompactionStartedEvent): void {
    this.host.streamingUI.finalizeLiveTextBuffers('waiting');
    this.host.setAppState({
      isCompacting: true,
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
    this.host.streamingUI.beginCompaction(event.instruction);
  }

  private handleCompactionEnd(
    event: CompactionCompletedEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.host.streamingUI.endCompaction(
      event.result.tokensBefore,
      event.result.tokensAfter,
      event.result.summary,
    );
    // A completed compaction just refreshed and shrank the cached context —
    // count it as activity so the next submit isn't judged against the
    // pre-compaction timestamp, and reset the cache-break baseline (the drop
    // is expected). Cancellations do neither: the context was not cut.
    this.host.recordSessionActivity();
    this.host.noteCompactionFinished();
    this.finishCompaction(sendQueued);
  }

  private handleCompactionCancel(
    _event: CompactionCancelledEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.host.streamingUI.cancelCompaction();
    this.finishCompaction(sendQueued);
  }

  private finishCompaction(sendQueued: (item: QueuedMessage) => void): void {
    const hasActiveTurn = this.host.streamingUI.hasActiveTurn();
    if (!hasActiveTurn) {
      const next = this.host.shiftQueuedMessage();
      if (next !== undefined) {
        this.host.store.setState('queuedMessageDispatchPending', true);
      }
      this.host.setAppState({
        isCompacting: false,
        streamingPhase: 'idle',
      });
      this.host.resetLivePane();
      if (next !== undefined) {
        setTimeout(() => {
          this.host.store.setState('queuedMessageDispatchPending', false);
          sendQueued(next);
        }, 0);
      }
    } else {
      this.host.setAppState({ isCompacting: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Background task lifecycle
  // ---------------------------------------------------------------------------

  private handleBackgroundTaskEvent(event: BackgroundTaskEvent): void {
    const { info } = event;
    const previous = this.backgroundTasks.get(info.taskId);
    this.backgroundTasks.set(info.taskId, info);

    void this.host.tasksBrowserController.refreshOutputViewer({ silent: true });

    const isTerminal =
      info.status === 'completed' ||
      info.status === 'failed' ||
      info.status === 'timed_out' ||
      info.status === 'killed' ||
      info.status === 'lost';

    if (event.type === 'task.started') {
      if (info.kind === 'agent') {
        // A foreground subagent detached via Ctrl+B: flip its card to
        // `◐ backgrounded` so it doesn't look like it completed.
        this.host.streamingUI.markSubagentBackgrounded(info.agentId);
        this.syncBackgroundTaskBadge();
        this.host.tasksBrowserController.repaint();
        return;
      }
      this.appendBackgroundTaskEntry(info);
      this.syncBackgroundTaskBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (event.type === 'task.terminated' && isTerminal) {
      if (info.kind === 'agent') {
        // The Agent tool's spawn-success ToolResult is not an error, so the
        // parent toolCall card would otherwise render `✓ Completed` for any
        // terminated bg agent — including `lost` / `failed` / `killed`.
        // Push the actual terminal status so the card matches reality.
        this.host.streamingUI.applyBackgroundTaskTerminalStatus({
          agentId: info.agentId,
          description: info.description,
          status: info.status,
        });
        // Stopped / timed-out agents terminate without a `subagent.failed`
        // event — mark the activity record here so the detail view does not
        // stay "running" forever. `subagent.completed` carries the result
        // summary and may land after this, so only fill still-running records.
        const agentId = info.agentId;
        if (agentId !== undefined) {
          const record = this.subAgentEventHandler.activityStore.get(agentId);
          if (record !== undefined && record.status === 'running') {
            if (info.status === 'completed') {
              this.subAgentEventHandler.activityStore.markCompleted(agentId);
            } else {
              this.subAgentEventHandler.activityStore.markFailed(agentId);
            }
          }
        }
      }
      if (!this.backgroundTaskTranscriptedTerminal.has(info.taskId)) {
        if (info.kind === 'process' || info.kind === 'question') {
          this.appendBackgroundTaskEntry(info);
        }
        this.backgroundTaskTranscriptedTerminal.add(info.taskId);
      }
      this.syncBackgroundTaskBadge();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (previous?.status !== info.status) {
      this.syncBackgroundTaskBadge();
    }
    this.host.tasksBrowserController.repaint();
  }

  private appendBackgroundTaskEntry(info: BackgroundTaskInfo): void {
    const status = formatBackgroundTaskTranscript(info);
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    };
    this.host.appendTranscriptEntry(entry);
  }

  private syncBackgroundTaskBadge(): void {
    let bashTasks = 0;
    let agentTasks = 0;
    for (const info of this.backgroundTasks.values()) {
      if (
        info.status === 'completed' ||
        info.status === 'failed' ||
        info.status === 'timed_out' ||
        info.status === 'killed' ||
        info.status === 'lost'
      ) {
        continue;
      }
      if (info.kind === 'agent') {
        agentTasks += 1;
      } else {
        bashTasks += 1;
      }
    }
    this.host.store.setState('backgroundCounts', { bashTasks, agentTasks });
  }

  // ---------------------------------------------------------------------------
  // Store helpers
  // ---------------------------------------------------------------------------

  private patchToolCallEntry(
    entryId: string,
    update: (data: ToolCallBlockData) => void,
  ): void {
    this.host.store.setState('transcript', (entries) =>
      entries.map((entry) => {
        if (entry.id !== entryId || entry.toolCallData === undefined) return entry;
        const data = { ...entry.toolCallData };
        update(data);
        return { ...entry, toolCallData: data };
      }),
    );
  }
}
