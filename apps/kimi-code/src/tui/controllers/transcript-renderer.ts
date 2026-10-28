import type { ApprovalRequest, ApprovalResponse } from '@moonshot-ai/kimi-code-sdk';
import { deleteAllKittyImages, getCapabilities, type Component } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';

import { WelcomeComponent } from '../components/chrome/welcome';
import { CompactionComponent } from '../components/dialogs/compaction';
import { AgentGroupComponent } from '../components/messages/agent-group';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { BackgroundAgentStatusComponent } from '../components/messages/background-agent-status';
import { CronMessageComponent } from '../components/messages/cron-message';
import { buildGoalMarker } from '../components/messages/goal-markers';
import {
  GoalCompletionMessageComponent,
  GoalSetMessageComponent,
} from '../components/messages/goal-panel';
import { PluginCommandComponent } from '../components/messages/plugin-command';
import { ReadGroupComponent } from '../components/messages/read-group';
import { SkillActivationComponent } from '../components/messages/skill-activation';
import {
  NoticeMessageComponent,
  StatusMessageComponent,
} from '../components/messages/status-message';
import { StepSummaryComponent } from '../components/messages/step-summary';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import {
  ReplayTurnBoundaryComponent,
  UserMessageComponent,
} from '../components/messages/user-message';
import type { TUIState } from '../tui-state';
import type { TranscriptEntry } from '../types';
import { hasDispose } from '../utils/component-capabilities';
import type { ImageAttachment, ImageAttachmentStore } from '../utils/image-attachment-store';
import {
  getTranscriptComponentEntry,
  markTranscriptComponent,
} from '../utils/transcript-component-metadata';
import { nextTranscriptId } from '../utils/transcript-id';
import {
  TRANSCRIPT_KEEP_RECENT_ASSISTANT,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
  TRANSCRIPT_KEEP_RECENT_STEPS,
  TRANSCRIPT_HYSTERESIS,
  TRANSCRIPT_MAX_TURNS,
  TRANSCRIPT_WINDOW_ENABLED,
  groupTurns,
  turnsToTrim,
} from '../utils/transcript-window';
import type { BtwPanelController } from './btw-panel';
import type { SessionEventHandler } from './session-event-handler';
import { StagingLeaseTracker } from './staging-leases';
import type { StreamingUIController } from './streaming-ui';

/**
 * Everything the transcript renderer needs from the `KimiTUI` coordinator:
 * the shared UI state and the sibling controllers cleared on a transcript
 * reset. The image store and staging tracker are injected directly.
 */
export interface TranscriptRenderHost {
  readonly state: TUIState;
  readonly streamingUI: StreamingUIController;
  readonly sessionEventHandler: SessionEventHandler;
  readonly btwPanelController: BtwPanelController;
}

/**
 * Steps the in-turn fold may merge into a step summary. Everything else in a
 * turn — panels, compaction blocks, status/notice cards, goal cards, steer
 * messages, the swarm panel — must stay mounted: the fold destroys what it
 * merges, and dropping an unclassified child silently lost it from the
 * transcript while its entry stayed in `transcriptEntries`.
 */
function isFoldableStepComponent(child: Component): boolean {
  return (
    child instanceof ThinkingComponent ||
    child instanceof ToolCallComponent ||
    child instanceof AgentGroupComponent ||
    child instanceof ReadGroupComponent
  );
}

/** Tool calls a foldable step represents (a group counts its borrowed cards). */
function foldableToolCallCount(child: Component): number {
  if (child instanceof ToolCallComponent) return 1;
  if (child instanceof AgentGroupComponent || child instanceof ReadGroupComponent) {
    return child.size();
  }
  return 0;
}

/**
 * Owns the transcript: entry→component rendering, the transcript container
 * lifecycle (append/clear/dispose), and the window management (trim, fold,
 * merge) that keeps a long session's mounted component list bounded.
 */
export class TranscriptRendererController {
  private readonly host: TranscriptRenderHost;
  private readonly imageStore: ImageAttachmentStore;
  private readonly staging: StagingLeaseTracker;

  constructor(
    host: TranscriptRenderHost,
    imageStore: ImageAttachmentStore,
    staging: StagingLeaseTracker,
  ) {
    this.host = host;
    this.imageStore = imageStore;
    this.staging = staging;
  }

  private createTranscriptComponent(entry: TranscriptEntry): Component | null {
    if (entry.compactionData !== undefined) {
      const data = entry.compactionData;
      const block = new CompactionComponent(this.host.state.ui, data.instruction);
      if (data.result === 'cancelled') {
        block.markCanceled();
      } else {
        block.markDone(data.tokensBefore, data.tokensAfter, data.summary);
        if (this.host.state.toolOutputExpanded) {
          block.setExpanded(true);
        }
      }
      return block;
    }

    switch (entry.kind) {
      case 'user': {
        const images = entry.imageAttachmentIds
          ?.map((id) => this.imageStore.get(id))
          .filter((a): a is ImageAttachment => a?.kind === 'image');
        return new UserMessageComponent(entry.content, images, entry.bullet);
      }
      case 'skill_activation':
        return new SkillActivationComponent(
          entry.skillName ?? entry.content,
          entry.skillArgs,
          entry.skillTrigger,
        );
      case 'plugin_command': {
        const data = entry.pluginCommandData;
        if (data === undefined) return null;
        return new PluginCommandComponent(data.pluginId, data.commandName, data.args);
      }
      case 'cron':
        return new CronMessageComponent(entry.content, entry.cronData ?? {});
      case 'goal':
        if (entry.goalData?.kind === 'created') {
          return new GoalSetMessageComponent();
        }
        if (entry.goalData?.kind === 'lifecycle') {
          return buildGoalMarker(entry.goalData.change, this.host.state.toolOutputExpanded);
        }
        return null;
      case 'assistant': {
        if (entry.goalCompletionData === true) {
          return new GoalCompletionMessageComponent(entry.content);
        }
        const component = new AssistantMessageComponent();
        component.updateContent(entry.content);
        return component;
      }
      case 'thinking': {
        const thinking = new ThinkingComponent(entry.content, true);
        if (this.host.state.toolOutputExpanded) thinking.setExpanded(true);
        return thinking;
      }
      case 'tool_call':
        if (entry.toolCallData) {
          const tc = new ToolCallComponent(
            entry.toolCallData,
            entry.toolCallData.result,
            this.host.state.ui,
            this.host.state.appState.workDir,
          );
          if (this.host.state.toolOutputExpanded) tc.setExpanded(true);
          return tc;
        }
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(entry.backgroundAgentStatus);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'status':
        if (entry.backgroundAgentStatus !== undefined) {
          return new BackgroundAgentStatusComponent(entry.backgroundAgentStatus);
        }
        return entry.renderMode === 'notice'
          ? new NoticeMessageComponent(entry.content, entry.detail)
          : new StatusMessageComponent(entry.content, entry.color);
      case 'welcome':
        return null;
      default:
        return null;
    }
  }

  appendTranscriptEntry(entry: TranscriptEntry, component?: Component): void {
    this.host.state.transcriptEntries.push(entry);
    const resolved = component ?? this.createTranscriptComponent(entry);
    if (resolved) {
      this.mountTranscriptComponent(entry, resolved);
      return;
    }
    const trimmed = this.trimTranscriptWindow();
    const merged = this.mergeCurrentTurnSteps();
    if (trimmed || merged) this.host.state.ui.requestRender();
  }

  /**
   * Mounts a component for an entry that is already accounted for (or that has
   * no history entry at all, e.g. the invisible replay turn boundary). Marking
   * keeps the window/fold/sticky bookkeeping able to attribute the child; the
   * entry list is not touched.
   */
  mountTranscriptComponent(entry: TranscriptEntry, component: Component): void {
    markTranscriptComponent(component, entry);
    this.host.state.transcriptContainer.addChild(component);
    this.trimTranscriptWindow();
    this.mergeCurrentTurnSteps();
    this.host.state.ui.requestRender();
  }

  /**
   * Replaces a mounted child in place (agent card → group, MCP spinner →
   * final status row) so ordering survives. The container's ref-checked render
   * cache picks up the identity change; no tree-wide invalidate is needed.
   */
  replaceTranscriptChild(
    previous: Component,
    next: Component,
    entry?: TranscriptEntry,
  ): boolean {
    const children = this.host.state.transcriptContainer.children;
    const index = children.indexOf(previous);
    if (index < 0) return false;
    if (entry !== undefined) markTranscriptComponent(next, entry);
    children[index] = next;
    this.host.state.ui.requestRender();
    return true;
  }

  /** Removes the components backing the given entries and disposes them. */
  removeTranscriptEntries(entries: readonly TranscriptEntry[]): void {
    const doomed = new Set(entries);
    const componentsToRemove = this.host.state.transcriptContainer.children.filter((child) => {
      const entry = getTranscriptComponentEntry(child);
      return entry !== undefined && doomed.has(entry);
    });
    for (const child of componentsToRemove) {
      // pi-tui Container.removeChild (not a DOM node); `child.remove()` does not exist.
      // oxlint-disable-next-line unicorn/prefer-dom-node-remove
      this.host.state.transcriptContainer.removeChild(child);
      if (hasDispose(child)) child.dispose();
    }
    this.host.state.transcriptEntries = this.host.state.transcriptEntries.filter(
      (e) => !doomed.has(e),
    );
    this.host.state.ui.requestRender();
  }

  /**
   * Relocate an already-mounted transcript entry (and its component) to the
   * end of the transcript. Used to re-anchor an asynchronously mounted
   * background-task terminal card to the start of its notification turn, so
   * the card's fold-segment boundary guards that turn's output instead of
   * splitting whatever turn happened to be live when the task terminated.
   * Returns false when the entry is no longer mounted (e.g. trimmed).
   */
  moveTranscriptEntryToEnd(entry: TranscriptEntry): boolean {
    const entries = this.host.state.transcriptEntries;
    const entryIndex = entries.indexOf(entry);
    if (entryIndex < 0) return false;
    entries.splice(entryIndex, 1);
    entries.push(entry);
    const children = this.host.state.transcriptContainer.children;
    const childIndex = children.findIndex(
      (child) => getTranscriptComponentEntry(child) === entry,
    );
    if (childIndex >= 0) {
      const [component] = children.splice(childIndex, 1);
      children.push(component!);
    }
    this.host.state.ui.requestRender();
    return true;
  }

  appendApprovalTranscriptEntry(request: ApprovalRequest, response: ApprovalResponse): void {
    if (
      request.toolName === 'ExitPlanMode' ||
      request.display.kind === 'plan_review' ||
      request.toolName === 'ExitSpecMode' ||
      request.display.kind === 'spec_review' ||
      request.display.kind === 'goal_start'
    )
      return;
    const parts: string[] = [];
    switch (response.decision) {
      case 'approved':
        parts.push(
          response.scope === 'session'
            ? t('tui.statusMessages.approvedForSession')
            : t('tui.statusMessages.approved'),
        );
        break;
      case 'rejected':
        parts.push(t('tui.statusMessages.rejected'));
        break;
      case 'cancelled':
        parts.push(t('tui.statusMessages.cancelled'));
        break;
    }
    parts.push(`: ${request.action}`);
    if (response.feedback !== undefined && response.feedback.length > 0) {
      parts.push(` — "${response.feedback}"`);
    }
    this.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      turnId: request.turnId === undefined ? undefined : String(request.turnId),
      renderMode: 'notice',
      content: parts.join(''),
    });
  }

  renderWelcome(): void {
    if (
      this.host.state.transcriptContainer.children.some(
        (child) => child instanceof WelcomeComponent,
      )
    ) {
      return;
    }
    const welcome = new WelcomeComponent(this.host.state.appState);
    this.host.state.transcriptContainer.addChild(welcome);
  }

  private clearTerminalInlineImages(): void {
    if (getCapabilities().images !== 'kitty') return;
    this.host.state.terminal.write(deleteAllKittyImages());
  }

  disposeTranscriptChildren(): void {
    // Dispose disposable children (e.g. ShellRunComponent's 1s timer,
    // ThinkingComponent's spinner) before dropping them, so a /clear, session
    // switch, or shutdown can't leak intervals that keep firing requestRender
    // on a removed component.
    for (const child of this.host.state.transcriptContainer.children) {
      if (hasDispose(child)) child.dispose();
    }
  }

  clearTranscriptAndRedraw(): void {
    this.host.streamingUI.discardPending();
    this.host.state.transcriptEntries = [];
    this.host.streamingUI.disposeActiveCompactionBlock();
    this.host.streamingUI.resetLiveText();
    this.host.streamingUI.resetToolUi();
    this.host.sessionEventHandler.stopAllMcpServerStatusSpinners();
    this.disposeTranscriptChildren();
    this.host.state.transcriptContainer.clear();
    this.host.btwPanelController.clear();
    this.clearTerminalInlineImages();
    const stagingFileIds = this.imageStore.clear();
    this.staging.deleteStaged(stagingFileIds);
    this.renderWelcome();
    // No forced full render on session reset: let the differential renderer
    // converge on its own (a mass change above the viewport still makes the
    // engine repaint everything, but nothing is forced destructively here).
    this.host.state.ui.requestRender();
  }

  isTurnBoundaryComponent(child: Component): boolean {
    if (
      !(child instanceof UserMessageComponent) &&
      !(child instanceof SkillActivationComponent) &&
      !(child instanceof PluginCommandComponent) &&
      !(child instanceof ReplayTurnBoundaryComponent)
    ) {
      return false;
    }
    const entry = getTranscriptComponentEntry(child);
    if (entry === undefined) return false;
    // Live user messages / slash activations have an undefined turnId; replayed
    // ones get a `replay:N` turnId. Both start a new turn. Steer messages carry
    // a defined non-replay turnId and are not boundaries.
    return entry.turnId === undefined || entry.turnId.startsWith('replay:');
  }

  /**
   * Fold-segment boundary: everything {@link isTurnBoundaryComponent} counts,
   * plus the cron card and terminal background-task cards. Cron-fired and
   * task-notification turns mount no user message, so without one of these
   * cards as a boundary their output would share the previous user turn's
   * fold segment — and the completed-turn assistant cap would fold that turn's
   * final answer into the step summary. A task-notification turn re-anchors
   * its terminal card to the turn's start (see SessionEventHandler), because
   * the card's asynchronous mount point may sit inside an unrelated turn;
   * cards that never get a notification turn (resumed sessions, missed
   * drains) still bound whatever segment they landed in.
   */
  private isFoldSegmentBoundaryComponent(child: Component): boolean {
    return (
      this.isTurnBoundaryComponent(child) ||
      child instanceof CronMessageComponent ||
      (child instanceof BackgroundAgentStatusComponent && child.phase !== 'started')
    );
  }

  private trimTranscriptWindow(): boolean {
    if (!TRANSCRIPT_WINDOW_ENABLED || TRANSCRIPT_MAX_TURNS <= 0) return false;
    // Session replay already caps history to its own turn limit; trimming during
    // replay would shrink it further and fight that limit.
    if (this.host.state.appState.isReplaying) return false;

    const children = this.host.state.transcriptContainer.children;

    const turns = groupTurns(this.host.state.transcriptEntries);

    const toRemove = turnsToTrim(turns, TRANSCRIPT_MAX_TURNS, TRANSCRIPT_HYSTERESIS);
    if (toRemove.size === 0) return false;

    // Reclaim image bytes referenced by trimmed user messages. The transcript
    // renders historical thumbnails via imageStore.get(id), so an attachment can
    // only be dropped once its owning user message leaves the transcript.
    for (const entry of toRemove) {
      if (entry.kind === 'user' && entry.imageAttachmentIds !== undefined) {
        const stagingFileIds = this.imageStore.removeMany(entry.imageAttachmentIds);
        this.staging.deleteStaged(stagingFileIds);
      }
    }

    // Trim whole turns by *position* in the child list rather than by entry
    // lookup — otherwise only the (registered) user message would be removed
    // and the rest of the turn would be left behind. A child is dropped when
    // the latest entry seen before it is itself being dropped: turn-internal
    // components carry no entry (streaming assistant/thinking/tool calls), and
    // relying on boundary *counts* instead desynchronized the two ledgers
    // whenever a boundary entry had no mounted component.
    const removed: Component[] = [];
    let governing: TranscriptEntry | undefined;
    for (const child of children) {
      const entry = getTranscriptComponentEntry(child);
      if (entry !== undefined) governing = entry;
      if (governing === undefined || !toRemove.has(governing)) continue;
      if (child instanceof WelcomeComponent) continue;
      removed.push(child);
    }
    for (const child of removed) {
      // pi-tui Container.removeChild (not a DOM node); `child.remove()` does not exist.
      // oxlint-disable-next-line unicorn/prefer-dom-node-remove
      this.host.state.transcriptContainer.removeChild(child);
      if (hasDispose(child)) child.dispose();
    }

    this.host.state.transcriptEntries = this.host.state.transcriptEntries.filter(
      (e) => !toRemove.has(e),
    );
    return true;
  }

  mergeCurrentTurnSteps(): boolean {
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT,
    );
  }

  /**
   * Fold the just-finished turn's assistant messages down to the completed-turn
   * cap: while a turn is live it may keep TRANSCRIPT_KEEP_RECENT_ASSISTANT
   * messages mounted, but once it ends only the conclusion-bearing tail stays.
   * Called when a turn finishes; the finished turn is still the current one at
   * that point (no newer boundary exists yet).
   */
  mergeCompletedTurnAssistants(): boolean {
    return this.foldCurrentTurnContent(
      TRANSCRIPT_KEEP_RECENT_STEPS,
      TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
    );
  }

  private foldCurrentTurnContent(keepSteps: number, keepAssistants: number): boolean {
    if (keepSteps <= 0 && keepAssistants <= 0) return false;
    const children = this.host.state.transcriptContainer.children;

    // Find the start of the current fold segment.
    let turnStart = -1;
    for (let i = children.length - 1; i >= 0; i--) {
      if (this.isFoldSegmentBoundaryComponent(children[i]!)) {
        turnStart = i;
        break;
      }
    }
    if (turnStart < 0) return false;

    // Locate an existing summary, the assistant messages, and the mergeable
    // steps. Only foldable step components enter `stepIndices`; any other
    // child (panel, compaction block, status card, steer message) is kept.
    let summaryIndex = -1;
    const stepIndices: number[] = [];
    const assistantIndices: number[] = [];
    for (let i = turnStart + 1; i < children.length; i++) {
      const child = children[i]!;
      if (child instanceof StepSummaryComponent) {
        summaryIndex = i;
        continue;
      }
      if (child instanceof AssistantMessageComponent) {
        assistantIndices.push(i);
        continue;
      }
      if (isFoldableStepComponent(child)) stepIndices.push(i);
    }

    // Fold the oldest steps / assistant messages beyond their respective caps;
    // the most recent ones stay mounted. Children are chronological, so the
    // oldest of each kind sit at the front of their index lists.
    const stepMergeCount = keepSteps > 0 ? Math.max(0, stepIndices.length - keepSteps) : 0;
    const assistantMergeCount =
      keepAssistants > 0 ? Math.max(0, assistantIndices.length - keepAssistants) : 0;
    if (stepMergeCount === 0 && assistantMergeCount === 0) return false;
    const toMergeIndices = [
      ...stepIndices.slice(0, stepMergeCount),
      ...assistantIndices.slice(0, assistantMergeCount),
    ];

    let thinkingCount = 0;
    let toolCount = 0;
    for (const idx of toMergeIndices) {
      const child = children[idx]!;
      if (child instanceof ThinkingComponent) thinkingCount++;
      else toolCount += foldableToolCallCount(child);
    }
    if (thinkingCount === 0 && toolCount === 0 && assistantMergeCount === 0) return false;

    let summary: StepSummaryComponent;
    if (summaryIndex >= 0) {
      summary = children[summaryIndex] as StepSummaryComponent;
      summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
    } else {
      summary = new StepSummaryComponent();
      summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
    }

    // Rebuild children: keep everything except the merged steps, with the summary
    // sitting right after the user message.
    const toMergeSet = new Set(toMergeIndices);
    const newChildren: Component[] = [];
    for (let i = 0; i <= turnStart; i++) newChildren.push(children[i]!);
    newChildren.push(summary);
    for (let i = turnStart + 1; i < children.length; i++) {
      if (i === summaryIndex) continue;
      if (toMergeSet.has(i)) continue;
      newChildren.push(children[i]!);
    }

    for (const idx of toMergeIndices) {
      const child = children[idx]!;
      if (hasDispose(child)) child.dispose();
    }

    children.splice(0, children.length, ...newChildren);
    return true;
  }

  mergeAllTurnSteps(): void {
    if (TRANSCRIPT_KEEP_RECENT_STEPS <= 0 && TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED <= 0)
      return;
    const children = this.host.state.transcriptContainer.children;

    const boundaries: number[] = [];
    for (let i = 0; i < children.length; i++) {
      if (this.isFoldSegmentBoundaryComponent(children[i]!)) boundaries.push(i);
    }
    if (boundaries.length === 0) return;

    const newChildren: Component[] = [];
    const toDispose: Component[] = [];
    for (let i = 0; i < boundaries[0]!; i++) newChildren.push(children[i]!);

    for (let t = 0; t < boundaries.length; t++) {
      const turnStart = boundaries[t]!;
      const turnEnd = t + 1 < boundaries.length ? boundaries[t + 1]! : children.length;
      newChildren.push(children[turnStart]!);

      let summaryIndex = -1;
      const stepIndices: number[] = [];
      const assistantIndices: number[] = [];
      for (let i = turnStart + 1; i < turnEnd; i++) {
        const child = children[i]!;
        if (child instanceof StepSummaryComponent) summaryIndex = i;
        else if (child instanceof AssistantMessageComponent) assistantIndices.push(i);
        else if (isFoldableStepComponent(child)) stepIndices.push(i);
      }

      const stepMergeCount =
        TRANSCRIPT_KEEP_RECENT_STEPS > 0
          ? Math.max(0, stepIndices.length - TRANSCRIPT_KEEP_RECENT_STEPS)
          : 0;
      // Replayed turns are all completed turns, so the stricter completed-turn
      // assistant cap applies (matching what live turns fold to on turn end).
      const assistantMergeCount =
        TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED > 0
          ? Math.max(0, assistantIndices.length - TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED)
          : 0;
      if (stepMergeCount > 0 || assistantMergeCount > 0) {
        const toMergeIndices = [
          ...stepIndices.slice(0, stepMergeCount),
          ...assistantIndices.slice(0, assistantMergeCount),
        ];
        let thinkingCount = 0;
        let toolCount = 0;
        for (const idx of toMergeIndices) {
          const child = children[idx]!;
          if (child instanceof ThinkingComponent) thinkingCount++;
          else toolCount += foldableToolCallCount(child);
        }
        let summary: StepSummaryComponent;
        if (summaryIndex >= 0) {
          summary = children[summaryIndex] as StepSummaryComponent;
          summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
        } else {
          summary = new StepSummaryComponent();
          summary.addCounts(thinkingCount, toolCount, assistantMergeCount);
        }
        newChildren.push(summary);
        for (const idx of toMergeIndices) toDispose.push(children[idx]!);
        const toMergeSet = new Set(toMergeIndices);
        for (let i = turnStart + 1; i < turnEnd; i++) {
          if (i === summaryIndex) continue;
          if (toMergeSet.has(i)) continue;
          newChildren.push(children[i]!);
        }
      } else {
        for (let i = turnStart + 1; i < turnEnd; i++) newChildren.push(children[i]!);
      }
    }

    for (const child of toDispose) {
      if (hasDispose(child)) child.dispose();
    }
    children.splice(0, children.length, ...newChildren);
  }
}
