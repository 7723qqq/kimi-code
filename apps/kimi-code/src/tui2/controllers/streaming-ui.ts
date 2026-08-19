/**
 * TUI2 streaming UI controller — live streaming state for the active turn.
 *
 * Mirrors `tui/controllers/streaming-ui.ts`. The v1 controller built pi-tui
 * components (AssistantMessageComponent, ThinkingComponent, ToolCallComponent,
 * AgentGroupComponent, ReadGroupComponent, CompactionComponent) and mounted
 * them into the transcript Container; the tui2 version writes transcript
 * entries into the response store and the opentui reconciler renders them.
 *
 * The flush throttle is kept: deltas accumulate in drafts and are committed
 * to the store in batches, so a burst of `assistant.delta` events does not
 * churn the store per token.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import { currentWorkingTip } from '../components/chrome/working-tips';
import { STREAMING_UI_FLUSH_MS } from '../constant/streaming';
import type { Tui2Store } from '../state';
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  TodoItem,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import { appendStreamingArgsPreview, parseStreamingArgs } from '../utils/event-payload';
import { notifyTerminalOnce } from '../utils/terminal-notification';
import { nextTranscriptId } from '../utils/transcript-id';

export interface StreamingUIHost {
  store: Tui2Store;
  session: Session | undefined;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  updateActivityPane(): void;
  updateAgentPane(): void;
  updateDiffReviewPane(): void;
  updateQueueDisplay(): void;
  requireSession(): Session;
  deferUserMessages: boolean;
  shiftQueuedMessage(): QueuedMessage | undefined;
  pushTranscriptEntry(entry: TranscriptEntry): void;
  mergeCurrentTurnSteps(): void;
  mergeCompletedTurnAssistants(): void;
  /** Write bytes to the terminal (notifications). */
  write(data: string): void;
}

/** In-store transcript entry updates keyed by entry id. */
type EntryPatch = Partial<TranscriptEntry>;

export class StreamingUIController {
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushAt: number | undefined;
  private pendingAssistantFlush = false;
  private pendingThinkingFlush = false;
  readonly pendingToolCallFlushIds = new Set<string>();

  // ---------------------------------------------------------------------------
  // Streaming runtime state (private — accessed via semantic methods below)
  // ---------------------------------------------------------------------------

  private _currentTurnId: string | undefined = undefined;
  private _currentStep = 0;
  private _assistantDraft = '';
  private _thinkingDraft = '';
  private _streamingBlock: { entryId: string } | null = null;
  private _activeThinkingEntryId: string | undefined = undefined;
  private _activeCompactionEntryId: string | undefined = undefined;
  private _activeToolCalls = new Map<string, ToolCallBlockData>();
  private _streamingToolCallArguments = new Map<
    string,
    { name?: string; argumentsText: string; startedAtMs: number }
  >();
  private _pendingToolEntryIds = new Map<string, string>();
  private _pendingAgentGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: string;
    groupKey?: string;
  } | null = null;
  private _pendingReadGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: string;
    groupKey?: string;
  } | null = null;

  constructor(private readonly host: StreamingUIHost) {}

  // ---------------------------------------------------------------------------
  // Turn context — read/write accessors
  // ---------------------------------------------------------------------------

  getTurnContext(): { turnId: string | undefined; step: number } {
    return { turnId: this._currentTurnId, step: this._currentStep };
  }

  setTurnId(turnId: string | undefined): void {
    this._currentTurnId = turnId;
  }

  setStep(step: number): void {
    this._currentStep = step;
  }

  hasActiveTurn(): boolean {
    return this._currentTurnId !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Text streaming — semantic write accessors
  // ---------------------------------------------------------------------------

  appendThinkingDelta(delta: string): void {
    this._thinkingDraft += delta;
    this.pendingThinkingFlush = true;
  }

  appendAssistantDelta(delta: string): void {
    if (this._streamingBlock === null) {
      this.onStreamingTextStart();
    }
    this._assistantDraft += delta;
    this.pendingAssistantFlush = true;
  }

  hasThinkingDraft(): boolean {
    return this._thinkingDraft.length > 0;
  }

  hasActiveThinkingComponent(): boolean {
    return this._activeThinkingEntryId !== undefined;
  }

  hasStreamingBlock(): boolean {
    return this._streamingBlock !== null;
  }

  getStreamingBlockComponent(): undefined {
    // The v1 accessor returned the AssistantMessageComponent instance; tui2
    // components read the store directly, so this is a compatibility no-op.
    return undefined;
  }

  clearAssistantDraft(): void {
    this._assistantDraft = '';
  }

  // ---------------------------------------------------------------------------
  // Tool call state — semantic accessors
  // ---------------------------------------------------------------------------

  getActiveToolCall(id: string): ToolCallBlockData | undefined {
    return this._activeToolCalls.get(id);
  }

  hasActiveToolCall(id: string): boolean {
    return this._activeToolCalls.has(id);
  }

  setActiveToolCall(id: string, toolCall: ToolCallBlockData): void {
    this._activeToolCalls.set(id, toolCall);
  }

  removeActiveToolCall(id: string): void {
    this._activeToolCalls.delete(id);
  }

  getToolComponent(id: string): string | undefined {
    return this._pendingToolEntryIds.get(id);
  }

  removeToolComponent(id: string): void {
    this._pendingToolEntryIds.delete(id);
  }

  hasPendingAgentGroup(): boolean {
    return this._pendingAgentGroup !== null;
  }

  hasPendingReadGroup(): boolean {
    return this._pendingReadGroup !== null;
  }

  removeToolComponentIfInactive(toolCallId: string): void {
    if (!this._activeToolCalls.has(toolCallId)) {
      this._pendingToolEntryIds.delete(toolCallId);
    }
  }

  /**
   * Push the actual terminal status of a background agent task into the
   * matching `Agent` tool-call entry so its snapshot phase no longer trusts
   * the spawn-success ToolResult (which would otherwise label every
   * terminated bg agent — including `lost` ones — as `✓ Completed`).
   *
   * Resolution policy: an `args.agentId` is treated as authoritative — we
   * either find an entry whose parsed `agent_id` matches (in-memory metadata
   * for live foreground, parsed from the spawn-success `agent_id: ...` line
   * for live backgrounded and replayed cards) or we skip. Description
   * fallback is kept as a best-effort path only when `agentId` is unknown.
   *
   * Returns true iff an entry was found and updated.
   */
  applyBackgroundTaskTerminalStatus(args: {
    agentId?: string | undefined;
    description: string;
    status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
    errorText?: string | undefined;
  }): boolean {
    const useAgentIdOnly = args.agentId !== undefined;
    let agentIdMatch: string | undefined;
    let descMatch: string | undefined;
    let descAmbiguous = false;
    const visit = (entry: TranscriptEntry): void => {
      if (agentIdMatch !== undefined) return;
      const data = entry.toolCallData;
      if (data === undefined) return;
      if (useAgentIdOnly) {
        if (data.subagent?.id === args.agentId) agentIdMatch = entry.id;
        return;
      }
      if (data.description !== args.description) return;
      if (descMatch !== undefined) {
        descAmbiguous = true;
        return;
      }
      descMatch = entry.id;
    };

    for (const entryId of this._pendingToolEntryIds.values()) {
      const entry = this.findEntry(entryId);
      if (entry !== undefined) visit(entry);
      if (agentIdMatch !== undefined) break;
    }
    if (agentIdMatch === undefined) {
      for (const entry of this.host.store.state.transcript) {
        if (entry.kind !== 'tool_call') continue;
        visit(entry);
        if (agentIdMatch !== undefined) break;
      }
    }
    const target = useAgentIdOnly ? agentIdMatch : descAmbiguous ? undefined : descMatch;
    if (target === undefined) return false;
    this.patchEntry(target, {
      toolCallData: {
        ...this.entryToolCallData(target),
        backgroundStatus: {
          status: args.status,
          errorText: args.errorText,
        },
      },
    });
    return true;
  }

  /**
   * Mark a foreground subagent card as detached-to-background (`◐ backgrounded`).
   * Routed from a `task.started` event whose `info.kind === 'agent'`,
   * keyed by `agentId`. Returns true iff a matching entry was found.
   */
  markSubagentBackgrounded(agentId: string | undefined): boolean {
    if (agentId === undefined) return false;
    const visit = (entry: TranscriptEntry): boolean => {
      const data = entry.toolCallData;
      if (data?.subagent?.id !== agentId) return false;
      if (data.backgrounded === true) return false;
      this.patchEntry(entry.id, {
        toolCallData: { ...data, backgrounded: true },
      });
      return true;
    };
    for (const entryId of this._pendingToolEntryIds.values()) {
      const entry = this.findEntry(entryId);
      if (entry !== undefined && visit(entry)) return true;
    }
    for (const entry of this.host.store.state.transcript) {
      if (entry.kind !== 'tool_call') continue;
      if (visit(entry)) return true;
    }
    return false;
  }

  /** Registers a tool call that arrived via tool.call.started.
   *  Clears any pending streaming state for this id, updates or creates the
   *  entry, and returns whether the call was new (no previous entry). */
  registerToolCall(toolCall: ToolCallBlockData): boolean {
    const existing = this._activeToolCalls.get(toolCall.id);
    this._activeToolCalls.set(toolCall.id, toolCall);
    this.pendingToolCallFlushIds.delete(toolCall.id);
    this._streamingToolCallArguments.delete(toolCall.id);
    const existingEntryId = this._pendingToolEntryIds.get(toolCall.id);
    if (existingEntryId !== undefined) {
      this.patchEntry(existingEntryId, { toolCallData: toolCall });
    } else if (existing === undefined) {
      this.finalizeLiveTextBuffers('tool');
      if (toolCall.name !== 'Agent' && toolCall.name !== 'AgentSwarm') {
        this.onToolCallStart(toolCall);
      }
    }
    return existing === undefined;
  }

  /** Accumulates a streaming tool-call argument delta. */
  accumulateToolCallDelta(
    id: string,
    eventName: string | undefined,
    argumentsPart: string | null | undefined,
  ): void {
    const existing = this._streamingToolCallArguments.get(id);
    const argumentsText = appendStreamingArgsPreview(existing?.argumentsText, argumentsPart);
    const name = eventName ?? existing?.name ?? this._activeToolCalls.get(id)?.name ?? 'Tool';
    const startedAtMs = existing?.startedAtMs ?? Date.now();
    this._streamingToolCallArguments.set(id, { name, argumentsText, startedAtMs });
    this.pendingToolCallFlushIds.add(id);
  }

  getStreamingToolCallPreview(
    id: string,
  ):
    | { name: string; args: Record<string, unknown>; argumentsText: string; startedAtMs: number }
    | undefined {
    const streaming = this._streamingToolCallArguments.get(id);
    if (streaming === undefined) return undefined;
    return {
      name: streaming.name ?? this._activeToolCalls.get(id)?.name ?? 'Tool',
      args: parseStreamingArgs(streaming.argumentsText),
      argumentsText: streaming.argumentsText,
      startedAtMs: streaming.startedAtMs,
    };
  }

  /** Completes a tool call: delivers the result and removes tracking state.
   *  Returns the matched ToolCallBlockData, or undefined if no call was tracked. */
  completeToolResult(
    toolCallId: string,
    result: ToolResultBlockData,
  ): ToolCallBlockData | undefined {
    const matchedCall = this._activeToolCalls.get(toolCallId);
    if (matchedCall !== undefined) {
      this.onToolCallEnd(toolCallId, result);
    }
    this._activeToolCalls.delete(toolCallId);
    this._streamingToolCallArguments.delete(toolCallId);
    return matchedCall;
  }

  /** Marks in-flight tool calls as truncated when a step hits max_tokens.
   *  Returns the count of tool calls that were truncated. */
  markStepTruncated(turnId: string, step: number): number {
    let count = 0;
    for (const toolCall of this._activeToolCalls.values()) {
      if (toolCall.result !== undefined) continue;
      if (toolCall.streamingArguments === undefined) continue;
      if (toolCall.turnId !== turnId) continue;
      if (toolCall.step !== step) continue;
      toolCall.truncated = true;
      const entryId = this._pendingToolEntryIds.get(toolCall.id);
      if (entryId !== undefined) {
        this.patchEntry(entryId, { toolCallData: toolCall });
      }
      count += 1;
    }
    this._streamingToolCallArguments.clear();
    return count;
  }

  /** Tears down replay-specific state after session history has been rendered. */
  cleanupAfterReplay(completedToolCallIds: Set<string>): void {
    this._activeToolCalls.clear();
    for (const toolCallId of completedToolCallIds) {
      this._pendingToolEntryIds.delete(toolCallId);
    }
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    this._currentTurnId = undefined;
    this._currentStep = 0;
    this._streamingToolCallArguments.clear();
    this.pendingToolCallFlushIds.clear();
  }

  // ---------------------------------------------------------------------------
  // Dispose helpers (moved from KimiTUI)
  // ---------------------------------------------------------------------------

  disposeActiveThinkingComponent(): void {
    this._activeThinkingEntryId = undefined;
  }

  disposeAndClearPendingToolComponents(): void {
    this._pendingToolEntryIds.clear();
  }

  disposeActiveCompactionBlock(): void {
    this._activeCompactionEntryId = undefined;
  }

  // ---------------------------------------------------------------------------
  // Flush control
  // ---------------------------------------------------------------------------

  hasPending(): boolean {
    return (
      this.pendingAssistantFlush ||
      this.pendingThinkingFlush ||
      this.pendingToolCallFlushIds.size > 0
    );
  }

  clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private clearFlushTimerIfIdle(): void {
    if (this.hasPending()) return;
    this.clearFlushTimer();
  }

  discardPending(): void {
    this.clearFlushTimer();
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.pendingToolCallFlushIds.clear();
  }

  scheduleFlush(): void {
    if (!this.hasPending()) return;
    if (this.flushTimer !== undefined) return;
    const delay =
      this.lastFlushAt === undefined
        ? 0
        : Math.max(0, STREAMING_UI_FLUSH_MS - (Date.now() - this.lastFlushAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, delay);
  }

  flushNow(): void {
    this.clearFlushTimer();
    this.flush();
  }

  private flush(): void {
    if (!this.hasPending()) return;
    this.lastFlushAt = Date.now();
    const shouldFlushThinking = this.pendingThinkingFlush;
    const shouldFlushAssistant = this.pendingAssistantFlush;
    const toolCallIds = [...this.pendingToolCallFlushIds];
    this.pendingThinkingFlush = false;
    this.pendingAssistantFlush = false;
    this.pendingToolCallFlushIds.clear();

    if (shouldFlushThinking && this._thinkingDraft.length > 0) {
      this.onThinkingUpdate(this._thinkingDraft);
    }
    if (shouldFlushAssistant) {
      this.onStreamingTextUpdate(this._assistantDraft);
    }
    for (const id of toolCallIds) {
      this.flushToolCallPreview(id);
    }
  }

  markAssistantDirty(): void {
    this.pendingAssistantFlush = true;
  }

  markThinkingDirty(): void {
    this.pendingThinkingFlush = true;
  }

  // ---------------------------------------------------------------------------
  // Text streaming
  // ---------------------------------------------------------------------------

  flushThinkingToTranscript(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushNow();
    this._thinkingDraft = '';
    this.onThinkingEnd();
    this.host.patchLivePane({ mode: nextMode });
  }

  finalizeAssistantStream(): void {
    this.flushNow();
    if (this._streamingBlock !== null) {
      this.onStreamingTextEnd();
    }
    this._assistantDraft = '';
    this.host.updateActivityPane();
  }

  resetLiveText(): void {
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.clearFlushTimerIfIdle();
    this._assistantDraft = '';
    this._streamingBlock = null;
    this._thinkingDraft = '';
    this.disposeActiveThinkingComponent();
  }

  resetToolUi(): void {
    this.pendingToolCallFlushIds.clear();
    this.clearFlushTimerIfIdle();
    this._streamingToolCallArguments.clear();
    this.disposeAndClearPendingToolComponents();
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    this.resetToolCallState();
  }

  resetToolCallState(): void {
    this._activeToolCalls.clear();
  }

  finalizeLiveTextBuffers(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushThinkingToTranscript(nextMode);
    this.finalizeAssistantStream();
  }

  finalizeTurn(sendQueued: (item: QueuedMessage) => void): void {
    const { store } = this.host;
    if (store.state.streamingPhase === 'idle') return;
    this.host.deferUserMessages = false;
    const completedTurnKey =
      this._currentTurnId ?? `local:${String(store.state.streamingStartTime)}`;
    this.finalizeLiveTextBuffers('idle');
    // The finished turn keeps only its conclusion-bearing tail; intermediate
    // chatter folds into the step summary.
    this.host.mergeCompletedTurnAssistants();
    this.resetToolCallState();
    this._currentTurnId = undefined;

    const next = this.host.shiftQueuedMessage();
    if (next !== undefined) {
      // The message is out of the queue but not yet sent. Mark the dispatch
      // pending *before* setAppState — that call synchronously retries
      // queued-goal promotion, which would otherwise see an empty queue and an
      // idle phase and start a goal ahead of this message.
      store.setState('queuedMessageDispatchPending', true);
      this.host.setAppState({ streamingPhase: 'idle' });
      this.host.resetLivePane();
      setTimeout(() => {
        store.setState('queuedMessageDispatchPending', false);
        sendQueued(next);
      }, 0);
      return;
    }

    this.host.setAppState({ streamingPhase: 'idle' });
    this.host.resetLivePane();
    notifyTerminalOnce(
      {
        notifications: store.state.notifications,
        terminalState: store.state.terminalState,
        write: (data) => this.host.write(data),
      },
      `turn-complete:${completedTurnKey}`,
      {
        title: t('tui.messages.streamingTaskComplete'),
        body: store.state.sessionTitle ?? undefined,
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Live render hooks
  // ---------------------------------------------------------------------------

  onStreamingTextStart(): void {
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'assistant',
      turnId: this._currentTurnId,
      renderMode: 'markdown',
      content: '',
      modelText: true,
    };
    this._streamingBlock = { entryId: entry.id };
    this.host.pushTranscriptEntry(entry);
  }

  onStreamingTextUpdate(fullText: string): void {
    const block = this._streamingBlock;
    if (block !== null) {
      this.patchEntry(block.entryId, { content: fullText });
    }
  }

  onStreamingTextEnd(): void {
    this._streamingBlock = null;
  }

  onThinkingUpdate(fullText: string): void {
    // Skip thinking that carries nothing visible — empty (e.g. encrypted
    // reasoning) or whitespace-only (a model occasionally streams a single
    // space as thinking). Session replay funnels through here as well, so a
    // stored whitespace-only think part never becomes a bare bullet line.
    if (fullText.trim().length === 0 && this._activeThinkingEntryId === undefined) return;
    if (this._activeThinkingEntryId === undefined) {
      this._pendingAgentGroup = null;
      this._pendingReadGroup = null;
      const entry: TranscriptEntry = {
        id: nextTranscriptId(),
        kind: 'thinking',
        turnId: this._currentTurnId,
        renderMode: 'plain',
        content: fullText,
        expanded: this.host.store.state.toolOutputExpanded,
      };
      this._activeThinkingEntryId = entry.id;
      this.host.pushTranscriptEntry(entry);
    } else {
      this.patchEntry(this._activeThinkingEntryId, { content: fullText });
    }
  }

  onThinkingEnd(): void {
    if (this._activeThinkingEntryId === undefined) return;
    this._activeThinkingEntryId = undefined;
    this.host.mergeCurrentTurnSteps();
  }

  onToolCallStart(toolCall: ToolCallBlockData): void {
    if (toolCall.name === 'AskUserQuestion') return;

    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'tool_call',
      turnId: toolCall.turnId ?? this._currentTurnId,
      renderMode: 'plain',
      content: '',
      toolCallData: toolCall,
      expanded: this.host.store.state.toolOutputExpanded,
    };
    this._pendingToolEntryIds.set(toolCall.id, entry.id);

    // Subagent state changes refresh the right-side agent pane.
    if (toolCall.name === 'Agent') {
      this.host.updateAgentPane();
    }
    // File-change display data feeds the diff review pane.
    if (toolCall.display?.kind === 'diff' || toolCall.display?.kind === 'file_io') {
      this.host.updateDiffReviewPane();
    }

    if (toolCall.name !== 'Agent') this._pendingAgentGroup = null;
    if (toolCall.name !== 'Read') this._pendingReadGroup = null;

    let handled = this.tryAttachAgentToolCall(toolCall, entry);
    if (!handled) handled = this.tryAttachReadToolCall(toolCall, entry);
    if (!handled) {
      this.host.pushTranscriptEntry(entry);
    }

    if (toolCall.name === 'ExitPlanMode' && typeof toolCall.args['plan'] !== 'string') {
      const session = this.host.requireSession();
      const toolCallId = toolCall.id;
      void (async () => {
        try {
          const plan = await session.getPlan();
          // Drop the write if the tool UI was reset (step boundary, error,
          // /clear, session switch) while getPlan() was in flight.
          if (this._pendingToolEntryIds.get(toolCallId) !== entry.id) return;
          this.patchEntry(entry.id, {
            toolCallData: {
              ...toolCall,
              ...(plan === null ? {} : { plan: plan.content, path: plan.path }),
            },
          });
        } catch {
          if (this._pendingToolEntryIds.get(toolCallId) !== entry.id) return;
          this.patchEntry(entry.id, { toolCallData: toolCall });
        }
      })();
    }
  }

  onToolCallEnd(toolCallId: string, result: ToolResultBlockData): void {
    const matchedCall = this._activeToolCalls.get(toolCallId);
    const entryId = this._pendingToolEntryIds.get(toolCallId);
    if (entryId !== undefined) {
      const data = this.entryToolCallData(entryId);
      this.patchEntry(entryId, {
        toolCallData: { ...data, result },
      });
      this._pendingToolEntryIds.delete(toolCallId);
      this.host.mergeCurrentTurnSteps();
      return;
    }

    if (matchedCall?.name === 'AskUserQuestion') {
      const entry: TranscriptEntry = {
        id: nextTranscriptId(),
        kind: 'tool_call',
        turnId: matchedCall.turnId ?? this._currentTurnId,
        renderMode: 'plain',
        content: '',
        toolCallData: { ...matchedCall, result },
        expanded: this.host.store.state.toolOutputExpanded,
      };
      this.host.pushTranscriptEntry(entry);
    }
    this.host.mergeCurrentTurnSteps();
  }

  setTodoList(todos: readonly TodoItem[]): void {
    this.host.store.setState('todoItems', todos);
  }

  beginCompaction(instruction?: string): void {
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this._currentTurnId,
      renderMode: 'plain',
      content: '',
      compactionData: {
        instruction,
        summary: currentWorkingTip()?.text,
      },
      expanded: this.host.store.state.toolOutputExpanded,
    };
    this._activeCompactionEntryId = entry.id;
    this.host.pushTranscriptEntry(entry);
  }

  endCompaction(tokensBefore?: number, tokensAfter?: number, summary?: string): void {
    const entryId = this._activeCompactionEntryId;
    if (entryId === undefined) return;
    this.patchEntry(entryId, {
      compactionData: { tokensBefore, tokensAfter, summary },
    });
    this._activeCompactionEntryId = undefined;
  }

  cancelCompaction(): void {
    const entryId = this._activeCompactionEntryId;
    if (entryId === undefined) return;
    this.patchEntry(entryId, {
      compactionData: { result: 'cancelled' },
    });
    this._activeCompactionEntryId = undefined;
  }

  // ---------------------------------------------------------------------------
  // Tool call grouping
  // ---------------------------------------------------------------------------

  private flushToolCallPreview(id: string): void {
    const streaming = this._streamingToolCallArguments.get(id);
    if (streaming === undefined) return;
    const toolCall: ToolCallBlockData = {
      id,
      name: streaming.name ?? this._activeToolCalls.get(id)?.name ?? 'Tool',
      args: parseStreamingArgs(streaming.argumentsText),
      streamingArguments: streaming.argumentsText,
      streamingStartedAtMs: streaming.startedAtMs,
      step: this._currentStep,
      turnId: this._currentTurnId,
    };
    this._activeToolCalls.set(id, toolCall);

    if (this._thinkingDraft.length > 0 || this._streamingBlock !== null) {
      this.finalizeLiveTextBuffers('tool');
    }

    const existingEntryId = this._pendingToolEntryIds.get(id);
    if (existingEntryId !== undefined) {
      this.patchEntry(existingEntryId, { toolCallData: toolCall });
    } else if (toolCall.name !== 'Agent' && toolCall.name !== 'AgentSwarm') {
      this.onToolCallStart(toolCall);
    }
  }

  private tryAttachAgentToolCall(toolCall: ToolCallBlockData, entry: TranscriptEntry): boolean {
    if (toolCall.name !== 'Agent') {
      this._pendingAgentGroup = null;
      return false;
    }

    const step = toolCall.step ?? this._currentStep;
    const turnId = toolCall.turnId ?? this._currentTurnId;
    const pending = this._pendingAgentGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this._pendingAgentGroup = null;
    }

    const cur = this._pendingAgentGroup;
    if (cur === null) {
      this._pendingAgentGroup = { step, turnId, solo: entry.id };
      this.host.pushTranscriptEntry(entry);
      return true;
    }

    if (cur.groupKey !== undefined) {
      this.patchEntry(entry.id, { groupKey: cur.groupKey });
      this.host.pushTranscriptEntry(entry);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this._pendingAgentGroup = { step, turnId, solo: entry.id };
      this.host.pushTranscriptEntry(entry);
      return true;
    }
    const groupKey = `agent:${String(turnId ?? '')}:${String(step)}`;
    this.patchEntry(solo, { groupKey });
    this.patchEntry(entry.id, { groupKey });
    this._pendingAgentGroup = { step, turnId, groupKey };
    this.host.pushTranscriptEntry(entry);
    return true;
  }

  private tryAttachReadToolCall(toolCall: ToolCallBlockData, entry: TranscriptEntry): boolean {
    if (toolCall.name !== 'Read') {
      this._pendingReadGroup = null;
      return false;
    }

    const step = toolCall.step ?? this._currentStep;
    const turnId = toolCall.turnId ?? this._currentTurnId;
    const pending = this._pendingReadGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this._pendingReadGroup = null;
    }

    const cur = this._pendingReadGroup;
    if (cur === null) {
      this._pendingReadGroup = { step, turnId, solo: entry.id };
      this.host.pushTranscriptEntry(entry);
      return true;
    }

    if (cur.groupKey !== undefined) {
      this.patchEntry(entry.id, { groupKey: cur.groupKey });
      this.host.pushTranscriptEntry(entry);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this._pendingReadGroup = { step, turnId, solo: entry.id };
      this.host.pushTranscriptEntry(entry);
      return true;
    }
    const groupKey = `read:${String(turnId ?? '')}:${String(step)}`;
    this.patchEntry(solo, { groupKey });
    this.patchEntry(entry.id, { groupKey });
    this._pendingReadGroup = { step, turnId, groupKey };
    this.host.pushTranscriptEntry(entry);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Store helpers
  // ---------------------------------------------------------------------------

  private findEntry(entryId: string): TranscriptEntry | undefined {
    return this.host.store.state.transcript.find((entry) => entry.id === entryId);
  }

  private entryToolCallData(entryId: string): ToolCallBlockData {
    return this.findEntry(entryId)?.toolCallData ?? { id: entryId, name: 'Tool', args: {} };
  }

  private patchEntry(entryId: string, patch: EntryPatch): void {
    this.host.store.setState('transcript', (entries) =>
      entries.map((entry) => (entry.id === entryId ? { ...entry, ...patch } : entry)),
    );
  }
}
