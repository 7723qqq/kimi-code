/**
 * TUI2 subagent event handler — child-agent lifecycle + activity routing.
 *
 * Mirrors `tui/controllers/subagent-event-handler.ts`. The v1 controller
 * pushed child-agent state into pi-tui components (ToolCallComponent,
 * AgentSwarmProgressComponent); the tui2 version writes into the parent
 * tool-call transcript entry (`toolCallData.subagent`) and a store-backed
 * swarm progress summary (`agentSwarmData`), which the opentui reconciler
 * renders.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { BackgroundTaskInfo, Event } from '@moonshot-ai/kimi-code-sdk';

import { t } from '#/i18n';

import { modelDisplayName } from '../components/dialogs/model-selector';
import { MAIN_AGENT_ID } from '../constant/kimi-tui';
import type {
  BackgroundAgentMetadata,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import { formatBackgroundAgentTranscript } from '../utils/background-agent-status';
import { argsRecord, serializeToolResultOutput } from '../utils/event-payload';
import { formatHookResultPlain } from '../utils/hook-result-format';
import { nextTranscriptId } from '../utils/transcript-id';
import type { SessionEventHost } from './session-event-handler';
import { SubagentActivityStore } from './subagent-activity-store';

export interface SubagentInfo {
  readonly parentToolCallId: string;
  readonly name: string;
  readonly runInBackground: boolean;
  readonly swarmIndex?: number;
}

export type SubagentLifecycleEvent = Event & { type: `subagent.${string}` };
type SubagentLifecycleEventOf<Type extends SubagentLifecycleEvent['type']> =
  SubagentLifecycleEvent & { type: Type };

export interface SubAgentEventHandlerDependencies {
  readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
  readonly backgroundTaskTranscriptedTerminal: Set<string>;
  readonly syncBackgroundAgentBadge: () => void;
}

/** In-controller swarm progress state (rendered via `agentSwarmData`). */
interface SwarmProgressState {
  readonly toolCallId: string;
  description: string;
  args: Record<string, unknown>;
  streamingArguments?: string;
  inputComplete: boolean;
  toolCallEnded: boolean;
  cancelled: boolean;
  failed: string | undefined;
  members: Map<string, { status: string; resultSummary?: string; error?: string }>;
  modelDisplay?: string;
  effortDisplay?: string;
}

export class SubAgentEventHandler {
  readonly subagentInfo: Map<string, SubagentInfo> = new Map();
  private readonly agentSwarmProgress: Map<string, SwarmProgressState> = new Map();
  backgroundAgentMetadata: Map<string, BackgroundAgentMetadata> = new Map();
  /** Bounded per-agent activity fold feeding the background-agent detail view. */
  readonly activityStore = new SubagentActivityStore();

  constructor(
    private readonly host: SessionEventHost,
    private readonly deps: SubAgentEventHandlerDependencies,
  ) {}

  resetRuntimeState(): void {
    this.subagentInfo.clear();
    this.backgroundAgentMetadata.clear();
    this.activityStore.clear();
    this.clearAgentSwarmProgress();
  }

  routeChildAgentEvent(event: Event): boolean {
    if (isSubagentLifecycleEvent(event)) return false;

    const childAgentId = event.agentId;
    if (childAgentId === MAIN_AGENT_ID) return false;

    // Tee every child-agent event into the activity store before the routing
    // below swallows events: the BTW panel's routeEvent returns true for
    // every event it handles while the panel is mounted, and the paths
    // further down drop events whose parent card is gone (Ctrl+B) or never
    // existed (run_in_background) — that data still feeds the background
    // detail view.
    this.activityStore.applyEvent(event);

    if (this.host.btwPanelController.routeEvent(event)) return true;

    const info = this.subagentInfo.get(childAgentId);
    if (info === undefined || info.parentToolCallId.length === 0) return true;

    const { parentToolCallId } = info;
    const swarmProgress = this.agentSwarmProgress.get(parentToolCallId);
    if (swarmProgress !== undefined) {
      this.applySubagentEventToSwarmProgress(swarmProgress, event, childAgentId);
      return true;
    }

    const entryId = this.host.streamingUI.getToolComponent(parentToolCallId);
    if (entryId === undefined) return true;
    this.patchSubagentData(entryId, (subagent) => {
      if (subagent.id !== childAgentId) {
        subagent.id = childAgentId;
        subagent.name = info.name;
      }
      if (event.type === 'hook.result') {
        subagent.text = `${subagent.text ?? ''}${formatHookResultPlain(event)}`;
      } else if (event.type === 'assistant.delta') {
        subagent.text = `${subagent.text ?? ''}${event.delta}`;
      } else if (event.type === 'thinking.delta') {
        subagent.text = `${subagent.text ?? ''}${event.delta}`;
      } else if (event.type === 'tool.call.started') {
        subagent.toolCalls = [
          ...(subagent.toolCalls ?? []),
          {
            id: `${childAgentId}:${event.toolCallId}`,
            name: event.name,
            args: argsRecord(event.args),
          },
        ];
      } else if (event.type === 'tool.call.delta') {
        subagent.toolCalls = (subagent.toolCalls ?? []).map((call) =>
          call.id === `${childAgentId}:${event.toolCallId}`
            ? {
                ...call,
                ...(event.name === undefined ? {} : { name: event.name }),
                ...(event.argumentsPart === undefined
                  ? {}
                  : { args: { ...call.args, argumentsText: event.argumentsPart } }),
              }
            : call,
        );
      } else if (
        event.type === 'tool.progress' &&
        (event.update.kind === 'stdout' || event.update.kind === 'stderr') &&
        event.update.text !== undefined
      ) {
        subagent.text = `${subagent.text ?? ''}${event.update.text}`;
      } else if (event.type === 'tool.result') {
        subagent.toolCalls = (subagent.toolCalls ?? []).map((call) =>
          call.id === `${childAgentId}:${event.toolCallId}`
            ? {
                ...call,
                result: {
                  tool_call_id: call.id,
                  output: serializeToolResultOutput(event.output),
                  is_error: event.isError,
                },
              }
            : call,
        );
      } else if (event.type === 'agent.status.updated') {
        const usageObj = event.usage;
        const totalUsage = usageObj?.total ?? usageObj?.currentTurn;
        subagent.model =
          event.model === undefined
            ? subagent.model
            : modelDisplayName(event.model, this.host.store.state.availableModels[event.model]);
        subagent.text = `${subagent.text ?? ''}${formatSubagentMetrics(event.contextTokens, totalUsage)}`;
      }
    });
    return true;
  }

  handleLifecycleEvent(event: SubagentLifecycleEvent): void {
    switch (event.type) {
      case 'subagent.spawned':
        this.handleSubagentSpawned(event);
        return;
      case 'subagent.started':
        this.handleSubagentStarted(event);
        return;
      case 'subagent.suspended':
        this.handleSubagentSuspended(event);
        return;
      case 'subagent.completed':
        this.handleSubagentCompleted(event);
        return;
      case 'subagent.failed':
        this.handleSubagentFailed(event);
        return;
    }
  }

  clearAgentSwarmProgress(): void {
    this.agentSwarmProgress.clear();
    this.host.updateActivityPane();
  }

  hasAgentSwarmProgress(toolCallId: string): boolean {
    return this.agentSwarmProgress.has(toolCallId);
  }

  hasActiveAgentSwarmToolCall(): boolean {
    return Array.from(this.agentSwarmProgress.values()).some(
      (progress) => !progress.toolCallEnded,
    );
  }

  handleAgentSwarmToolCallStarted(toolCallId: string, args: Record<string, unknown>): void {
    const progress = this.ensureAgentSwarmProgress(toolCallId, args);
    progress.inputComplete = true;
    this.publishSwarmProgress(progress);
  }

  handleAgentSwarmToolCallDelta(
    toolCallId: string,
    args: Record<string, unknown>,
    options: { readonly streamingArguments?: string | undefined },
  ): void {
    this.ensureAgentSwarmProgress(toolCallId, args, options);
  }

  handleAgentSwarmToolResult(
    toolCallId: string,
    resultData: ToolResultBlockData,
    isError: boolean,
  ): void {
    const progress = this.agentSwarmProgress.get(toolCallId);
    if (progress === undefined) return;

    progress.toolCallEnded = true;
    if (isError && isUserCancelledSubagentError(resultData.output)) {
      progress.cancelled = true;
    } else if (isError) {
      progress.failed = resultData.output;
    }
    this.publishSwarmProgress(progress);
    this.host.updateActivityPane();
  }

  markActiveAgentSwarmsCancelled(): void {
    for (const progress of this.agentSwarmProgress.values()) {
      progress.cancelled = true;
      this.publishSwarmProgress(progress);
    }
  }

  private handleSubagentSpawned(event: SubagentLifecycleEventOf<'subagent.spawned'>): void {
    this.rememberSubagent(event);

    if (event.runInBackground) {
      const meta = this.buildBackgroundAgentMetadata(event);
      this.backgroundAgentMetadata.set(event.subagentId, meta);
      this.appendBackgroundAgentEntry('started', meta);
      this.deps.syncBackgroundAgentBadge();
      return;
    }

    this.handleForegroundSubagentSpawned(event);
  }

  private handleSubagentStarted(event: SubagentLifecycleEventOf<'subagent.started'>): void {
    const info = this.subagentInfo.get(event.subagentId);
    if (info === undefined) return;
    if (!info.runInBackground) this.handleForegroundSubagentStarted(event, info);
  }

  private handleSubagentSuspended(event: SubagentLifecycleEventOf<'subagent.suspended'>): void {
    const info = this.subagentInfo.get(event.subagentId);
    if (info === undefined) return;
    if (!info.runInBackground) this.handleForegroundSubagentSuspended(event, info);
  }

  private handleSubagentCompleted(event: SubagentLifecycleEventOf<'subagent.completed'>): void {
    this.activityStore.markCompleted(event.subagentId, event.resultSummary);
    this.pruneForegroundOnlyRecord(event.subagentId);
    const backgroundMeta = this.backgroundAgentMetadata.get(event.subagentId);
    if (backgroundMeta !== undefined) {
      const taskId = this.findAgentTaskId(
        event.subagentId,
        backgroundMeta,
        this.deps.backgroundTasks,
      );
      this.backgroundAgentMetadata.delete(event.subagentId);
      this.deps.syncBackgroundAgentBadge();
      if (taskId !== undefined && this.deps.backgroundTaskTranscriptedTerminal.has(taskId)) {
        return;
      }
      if (taskId !== undefined) {
        this.deps.backgroundTaskTranscriptedTerminal.add(taskId);
      }
      const extras =
        event.resultSummary === undefined ? undefined : { resultSummary: event.resultSummary };
      this.appendBackgroundAgentEntry('completed', backgroundMeta, extras);
      return;
    }

    const info = this.subagentInfo.get(event.subagentId);
    if (info === undefined || info.runInBackground) return;
    this.handleForegroundSubagentCompleted(event, info);
  }

  private handleSubagentFailed(event: SubagentLifecycleEventOf<'subagent.failed'>): void {
    this.activityStore.markFailed(event.subagentId, event.error);
    this.pruneForegroundOnlyRecord(event.subagentId);
    const backgroundMeta = this.backgroundAgentMetadata.get(event.subagentId);
    if (backgroundMeta !== undefined) {
      const taskId = this.findAgentTaskId(
        event.subagentId,
        backgroundMeta,
        this.deps.backgroundTasks,
      );
      const task = taskId === undefined ? undefined : this.deps.backgroundTasks.get(taskId);
      this.backgroundAgentMetadata.delete(event.subagentId);
      this.deps.syncBackgroundAgentBadge();
      if (task?.kind === 'agent' && task.status === 'timed_out') {
        return;
      }
      this.host.streamingUI.applyBackgroundTaskTerminalStatus({
        agentId: event.subagentId,
        description: backgroundMeta.description ?? '',
        status: 'failed',
        errorText: event.error,
      });
      if (taskId !== undefined && this.deps.backgroundTaskTranscriptedTerminal.has(taskId)) {
        return;
      }
      if (taskId !== undefined) {
        this.deps.backgroundTaskTranscriptedTerminal.add(taskId);
      }
      this.appendBackgroundAgentEntry('failed', backgroundMeta, { error: event.error });
      return;
    }

    const info = this.subagentInfo.get(event.subagentId);
    if (info === undefined || info.runInBackground) return;
    this.handleForegroundSubagentFailed(event, info);
  }

  private findAgentTaskId(
    subagentId: string,
    meta: BackgroundAgentMetadata,
    backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>,
  ): string | undefined {
    for (const info of backgroundTasks.values()) {
      if (info.kind !== 'agent') continue;
      if (info.agentId === subagentId) return info.taskId;
    }
    const description = meta.description ?? meta.agentName;
    if (description === undefined) return undefined;
    let match: string | undefined;
    for (const info of backgroundTasks.values()) {
      if (info.kind !== 'agent') continue;
      if (info.description !== description) continue;
      if (match !== undefined) return undefined;
      match = info.taskId;
    }
    return match;
  }

  /** A subagent that never became a background task (foreground-only) can
   *  never appear in /tasks, so its activity record is dropped at terminal
   *  state — otherwise records would pile up for the rest of the session. */
  private pruneForegroundOnlyRecord(subagentId: string): void {
    // A spawn-time background agent keeps its record even when the
    // background.task.started sync has not landed yet (short-lived agents).
    if (this.backgroundAgentMetadata.has(subagentId)) return;
    for (const info of this.deps.backgroundTasks.values()) {
      if (info.kind === 'agent' && info.agentId === subagentId) return;
    }
    this.activityStore.drop(subagentId);
  }

  /** Drop every foreground-only record. Called when the main turn ends: any
   *  foreground subagent of the turn is over at that point, and an aborted
   *  one emits no `subagent.completed`/`subagent.failed` to prune it. */
  dropForegroundOnlyActivityRecords(): void {
    for (const agentId of this.activityStore.agentIds()) {
      this.pruneForegroundOnlyRecord(agentId);
    }
  }

  private buildBackgroundAgentMetadata(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): BackgroundAgentMetadata {
    const parent = this.host.streamingUI.getActiveToolCall(event.parentToolCallId);
    const description = parent?.args['description'] ?? event.description;
    return {
      agentId: event.subagentId,
      parentToolCallId: event.parentToolCallId,
      agentName: event.subagentName,
      description: typeof description === 'string' ? description : undefined,
      model: this.spawnedModelDisplay(event),
      effort: this.subagentEffortDisplay(event.thinkingEffort),
    };
  }

  private appendBackgroundAgentEntry(
    phase: 'started' | 'completed' | 'failed',
    meta: BackgroundAgentMetadata,
    extras: { resultSummary?: string; error?: string } | undefined = undefined,
  ): void {
    const status = formatBackgroundAgentTranscript(phase, meta, extras);
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

  private rememberSubagent(event: SubagentLifecycleEventOf<'subagent.spawned'>): void {
    this.subagentInfo.set(event.subagentId, {
      parentToolCallId: event.parentToolCallId,
      name: event.subagentName,
      runInBackground: event.runInBackground,
      swarmIndex: event.swarmIndex,
    });
    this.activityStore.ensureRecord({
      agentId: event.subagentId,
      agentName: event.subagentName,
      description: event.description,
      parentToolCallId: event.parentToolCallId,
      model: this.spawnedModelDisplay(event),
      effort: this.subagentEffortDisplay(event.thinkingEffort),
    });
  }

  private handleForegroundSubagentSpawned(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): void {
    // The spawned event carries the display-normalized bound alias (newer
    // cores) — show it at spawn instead of waiting for the child's first
    // status frame. The `agent.status.updated` channel below stays as the
    // in-run update/fallback path.
    const modelDisplay = this.spawnedModelDisplay(event);
    const effortDisplay = this.subagentEffortDisplay(event.thinkingEffort);
    if (
      this.updateAgentSwarmProgress(event.parentToolCallId, (progress) => {
        progress.members.set(event.subagentId, { status: 'queued' });
        if (modelDisplay !== undefined) progress.modelDisplay = modelDisplay;
        if (effortDisplay !== undefined) progress.effortDisplay = effortDisplay;
      })
    ) {
      return;
    }

    let entryId = this.getOrActivateToolComponent(event.parentToolCallId);
    entryId ??= this.createStandaloneSubagentToolCall(event);
    if (entryId === undefined) return;
    this.patchSubagentData(entryId, (subagent) => {
      subagent.id = event.subagentId;
      subagent.name = event.subagentName;
      if (modelDisplay !== undefined) subagent.model = modelDisplay;
    });
  }

  /** Map the spawned event's bound alias to a display name via the loaded
   *  model catalog; falls back to the alias itself for unknown entries. */
  private spawnedModelDisplay(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): string | undefined {
    if (event.model === undefined) return undefined;
    return modelDisplayName(event.model, this.host.store.state.availableModels[event.model]);
  }

  /** Concrete effort levels are always shown; the boolean states carry no
   *  level information — 'off' (no thinking) and 'on' (generic thinking) are
   *  both hidden. */
  private subagentEffortDisplay(effort: string | undefined): string | undefined {
    if (effort === undefined || effort === 'off' || effort === 'on') return undefined;
    return effort;
  }

  private handleForegroundSubagentStarted(
    event: SubagentLifecycleEventOf<'subagent.started'>,
    info: SubagentInfo,
  ): void {
    if (
      this.updateAgentSwarmProgress(info.parentToolCallId, (progress) => {
        const member = progress.members.get(event.subagentId);
        if (member !== undefined) member.status = 'running';
      })
    ) {
      return;
    }

    const entryId = this.getOrActivateToolComponent(info.parentToolCallId);
    if (entryId === undefined) return;
    this.patchSubagentData(entryId, (subagent) => {
      subagent.id = event.subagentId;
      subagent.name = info.name;
    });
  }

  private handleForegroundSubagentSuspended(
    event: SubagentLifecycleEventOf<'subagent.suspended'>,
    info: SubagentInfo,
  ): void {
    this.updateAgentSwarmProgress(info.parentToolCallId, (progress) => {
      const member = progress.members.get(event.subagentId);
      if (member !== undefined) member.status = 'suspended';
    });
  }

  private handleForegroundSubagentCompleted(
    event: SubagentLifecycleEventOf<'subagent.completed'>,
    info: SubagentInfo,
  ): void {
    const { parentToolCallId } = info;
    if (
      this.updateAgentSwarmProgress(parentToolCallId, (progress) => {
        const member = progress.members.get(event.subagentId);
        if (member !== undefined) {
          member.status = 'completed';
          member.resultSummary = event.resultSummary;
        }
      })
    ) {
      this.host.streamingUI.removeToolComponentIfInactive(parentToolCallId);
      return;
    }

    const entryId = this.host.streamingUI.getToolComponent(parentToolCallId);
    if (entryId === undefined) return;
    this.patchSubagentData(entryId, (subagent) => {
      subagent.id = event.subagentId;
      if (event.resultSummary !== undefined) {
        subagent.text = `${subagent.text ?? ''}${event.resultSummary}`;
      }
    });
    this.host.streamingUI.removeToolComponentIfInactive(parentToolCallId);
  }

  private handleForegroundSubagentFailed(
    event: SubagentLifecycleEventOf<'subagent.failed'>,
    info: SubagentInfo,
  ): void {
    const { parentToolCallId } = info;
    if (
      this.updateAgentSwarmProgress(parentToolCallId, (progress) => {
        const member = progress.members.get(event.subagentId);
        if (member !== undefined) {
          member.status = isUserCancelledSubagentError(event.error) ? 'cancelled' : 'failed';
          member.error = event.error;
        }
      })
    ) {
      this.host.streamingUI.removeToolComponentIfInactive(parentToolCallId);
      return;
    }

    const entryId = this.host.streamingUI.getToolComponent(parentToolCallId);
    if (entryId === undefined) return;
    this.patchSubagentData(entryId, (subagent) => {
      subagent.id = event.subagentId;
      subagent.text = `${subagent.text ?? ''}${event.error}`;
    });
    this.host.streamingUI.removeToolComponentIfInactive(parentToolCallId);
  }

  private applySubagentEventToSwarmProgress(
    progress: SwarmProgressState,
    event: Event,
    subagentId: string,
  ): void {
    if (event.type === 'assistant.delta' || event.type === 'thinking.delta') {
      const member = progress.members.get(subagentId);
      if (member !== undefined) {
        member.status = 'running';
      }
    } else if (event.type === 'tool.call.started') {
      const member = progress.members.get(subagentId);
      if (member !== undefined) {
        member.status = 'running';
      }
    } else if (event.type === 'agent.status.updated' && event.model !== undefined) {
      // The bound model alias rides every child status update (emitted right
      // after spawn). Swarm members share one binding, so the panel shows it
      // once in the header instead of per cell. `modelDisplayName` falls back
      // to the alias itself when the entry is unknown.
      progress.modelDisplay = modelDisplayName(
        event.model,
        this.host.store.state.availableModels[event.model],
      );
      const effortDisplay = this.subagentEffortDisplay(event.thinkingEffort);
      if (effortDisplay !== undefined) progress.effortDisplay = effortDisplay;
    }
    this.publishSwarmProgress(progress);
  }

  private updateAgentSwarmProgress(
    parentToolCallId: string,
    update: (progress: SwarmProgressState) => void,
  ): boolean {
    const progress = this.agentSwarmProgress.get(parentToolCallId);
    if (progress === undefined) return false;
    update(progress);
    this.publishSwarmProgress(progress);
    return true;
  }

  private ensureAgentSwarmProgress(
    toolCallId: string,
    args: Record<string, unknown>,
    options: { readonly streamingArguments?: string | undefined } = {},
  ): SwarmProgressState {
    const existing = this.agentSwarmProgress.get(toolCallId);
    if (existing !== undefined) {
      existing.args = args;
      if (options.streamingArguments !== undefined) {
        existing.streamingArguments = options.streamingArguments;
      }
      this.publishSwarmProgress(existing);
      return existing;
    }

    const description = agentSwarmDescriptionFromArgs(args);
    const progress: SwarmProgressState = {
      toolCallId,
      description,
      args,
      streamingArguments: options.streamingArguments,
      inputComplete: false,
      toolCallEnded: false,
      cancelled: false,
      failed: undefined,
      members: new Map(),
    };
    this.agentSwarmProgress.set(toolCallId, progress);
    this.host.streamingUI.finalizeLiveTextBuffers('tool');
    this.host.updateActivityPane();
    this.publishSwarmProgress(progress);
    return progress;
  }

  private publishSwarmProgress(progress: SwarmProgressState): void {
    const entryId = this.host.streamingUI.getToolComponent(progress.toolCallId);
    if (entryId === undefined) return;
    let completedCount = 0;
    let failedCount = 0;
    for (const member of progress.members.values()) {
      if (member.status === 'completed') completedCount += 1;
      if (member.status === 'failed' || member.status === 'cancelled') failedCount += 1;
    }
    this.host.store.setState('transcript', (entries) =>
      entries.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              agentSwarmData: {
                toolCallId: progress.toolCallId,
                description: progress.description,
                status: progress.toolCallEnded
                  ? 'ended'
                  : progress.inputComplete
                    ? 'running'
                    : 'streaming',
                memberCount: progress.members.size,
                completedCount,
                failedCount,
              },
            }
          : entry,
      ),
    );
  }

  private getOrActivateToolComponent(parentToolCallId: string): string | undefined {
    let entryId = this.host.streamingUI.getToolComponent(parentToolCallId);
    if (entryId !== undefined) return entryId;
    const toolCall = this.host.streamingUI.getActiveToolCall(parentToolCallId);
    if (toolCall === undefined) return undefined;
    this.host.streamingUI.onToolCallStart(toolCall);
    return this.host.streamingUI.getToolComponent(parentToolCallId);
  }

  private createStandaloneSubagentToolCall(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): string | undefined {
    const description =
      event.description ?? t('tui.statusMessages.subagentRun', { name: event.subagentName });
    const { turnId, step } = this.host.streamingUI.getTurnContext();
    const toolCall: ToolCallBlockData = {
      id: event.parentToolCallId,
      name: 'Agent',
      args: {
        description,
        subagent_type: event.subagentName,
      },
      description,
      step,
      turnId,
    };
    this.host.streamingUI.onToolCallStart(toolCall);
    return this.host.streamingUI.getToolComponent(event.parentToolCallId);
  }

  // ---------------------------------------------------------------------------
  // Store helpers
  // ---------------------------------------------------------------------------

  private patchSubagentData(
    entryId: string,
    update: (subagent: NonNullable<ToolCallBlockData['subagent']>) => void,
  ): void {
    this.host.store.setState('transcript', (entries) =>
      entries.map((entry) => {
        if (entry.id !== entryId || entry.toolCallData === undefined) return entry;
        const subagent = entry.toolCallData.subagent ?? { id: '', toolCalls: [] };
        update(subagent);
        return { ...entry, toolCallData: { ...entry.toolCallData, subagent } };
      }),
    );
  }
}

function isSubagentLifecycleEvent(event: Event): event is SubagentLifecycleEvent {
  return (
    event.type === 'subagent.spawned' ||
    event.type === 'subagent.started' ||
    event.type === 'subagent.suspended' ||
    event.type === 'subagent.completed' ||
    event.type === 'subagent.failed'
  );
}

function isUserCancelledSubagentError(error: string): boolean {
  // Structured AgentSwarm results use outcome="aborted" and are parsed separately.
  switch (error.trim()) {
    case 'Aborted by the user':
    case 'The user manually interrupted this subagent batch.':
      return true;
    default:
      return false;
  }
}

function agentSwarmDescriptionFromArgs(args: Record<string, unknown>): string {
  const description = args['description'];
  return typeof description === 'string' ? description : 'AgentSwarm';
}

function formatSubagentMetrics(
  contextTokens: number | undefined,
  usage: { input?: number; output?: number } | undefined,
): string {
  const parts: string[] = [];
  if (contextTokens !== undefined) parts.push(`${contextTokens} ctx`);
  if (usage?.input !== undefined) parts.push(`${usage.input} in`);
  if (usage?.output !== undefined) parts.push(`${usage.output} out`);
  return parts.length > 0 ? `\n[${parts.join(' · ')}]` : '';
}
