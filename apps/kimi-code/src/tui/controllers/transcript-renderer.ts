import type { ApprovalRequest, ApprovalResponse } from '@moonshot-ai/kimi-code-sdk';
import { deleteAllKittyImages, getCapabilities, type Component } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';

import { WelcomeComponent } from '../components/chrome/welcome';
import { CompactionComponent } from '../components/dialogs/compaction';
import { AssistantMessageComponent } from '../components/messages/assistant-message';
import { BackgroundAgentStatusComponent } from '../components/messages/background-agent-status';
import { CronMessageComponent } from '../components/messages/cron-message';
import { buildGoalMarker } from '../components/messages/goal-markers';
import {
  GoalCompletionMessageComponent,
  GoalSetMessageComponent,
} from '../components/messages/goal-panel';
import { PluginCommandComponent } from '../components/messages/plugin-command';
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

  appendTranscriptEntry(entry: TranscriptEntry): void {
    this.host.state.transcriptEntries.push(entry);
    const component = this.createTranscriptComponent(entry);
    if (component) {
      markTranscriptComponent(component, entry);
      this.host.state.transcriptContainer.addChild(component);
    }
    const trimmed = this.trimTranscriptWindow();
    const merged = this.mergeCurrentTurnSteps();
    if (component || trimmed || merged) {
      this.host.state.ui.requestRender();
    }
  }

  appendApprovalTranscriptEntry(request: ApprovalRequest, response: ApprovalResponse): void {
    if (
      request.toolName === 'ExitPlanMode' ||
      request.display.kind === 'plan_review' ||
      request.display.kind === 'goal_start'
    )
      return;
    const parts: string[] = [];
    switch (response.decision) {
      case 'approved':
        parts.push(
          response.scope === 'session' ? t('tui.statusMessages.approvedForSession') : 'Approved',
        );
        break;
      case 'rejected':
        parts.push('Rejected');
        break;
      case 'cancelled':
        parts.push('Cancelled');
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
    this.host.state.todoPanel.clear();
    this.host.state.todoPanelContainer.clear();
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
   * plus the cron card. A cron-fired turn mounts no user message, so without
   * the card as a boundary its output would share the previous user turn's
   * fold segment — and the completed-turn assistant cap would fold that turn's
   * final answer into the step summary.
   */
  private isFoldSegmentBoundaryComponent(child: Component): boolean {
    return this.isTurnBoundaryComponent(child) || child instanceof CronMessageComponent;
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

    let boundariesToRemove = 0;
    for (const entry of toRemove) {
      if (
        (entry.kind === 'user' ||
          entry.kind === 'skill_activation' ||
          entry.kind === 'plugin_command') &&
        entry.turnId === undefined
      ) {
        boundariesToRemove++;
      }
    }
    if (boundariesToRemove === 0) {
      this.host.state.transcriptEntries = this.host.state.transcriptEntries.filter(
        (e) => !toRemove.has(e),
      );
      return true;
    }

    // Trim whole turns by *position* in the child list rather than by entry
    // lookup — otherwise only the (registered) user message would be removed and
    // the rest of the turn would be left behind.
    let boundariesSeen = 0;
    let cutoff = 0;
    for (let i = 0; i < children.length; i++) {
      if (this.isTurnBoundaryComponent(children[i]!)) {
        if (boundariesSeen === boundariesToRemove) {
          cutoff = i;
          break;
        }
        boundariesSeen++;
      }
    }

    const componentsToRemove: Component[] = [];
    for (let i = 0; i < cutoff; i++) {
      const child = children[i]!;
      if (child instanceof WelcomeComponent) continue;
      componentsToRemove.push(child);
    }
    for (const child of componentsToRemove) {
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

    // Locate an existing summary, the assistant messages, and the mergeable steps.
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
      stepIndices.push(i);
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
      else if (child instanceof ToolCallComponent) toolCount++;
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
        else stepIndices.push(i);
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
          else if (child instanceof ToolCallComponent) toolCount++;
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
