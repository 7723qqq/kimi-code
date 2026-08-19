/**
 * TUI2 SubagentStateManager — derives subagent lifecycle state for a
 * single Agent tool call from its transcript entry data.
 *
 * Mirrors `tui/components/messages/tool-call/subagent-state.ts` in
 * purpose, but the data flow is inverted. The v1 manager was an
 * imperative state machine: the TUI pushed `subagent.*` SDK events into
 * it with ~15 mutators (onSpawned / appendText / appendSubToolCall …).
 * The tui2 controller instead flattens every child-agent event into the
 * parent tool-call transcript entry's `toolCallData.subagent`
 * (`SubagentReplayBlockData`) and `toolCallData.backgroundStatus` /
 * `backgrounded` flags (see `controllers/subagent-event-handler.ts`),
 * so this manager only *derives*: `updateToolCall` re-derives the
 * snapshot/read views from the block data on every store change.
 *
 * The snapshot surface (`getSnapshot` / `getReadSnapshot` and the state
 * getters) is kept from v1 so the single-subagent card, the group views
 * and `formatPhaseChip`-style renderers keep working; the live-event
 * mutators and the elapsed timer are gone (the tui2 views own their own
 * spinner/elapsed ticking).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { TokenUsage } from '@moonshot-ai/kimi-code-sdk';

import type { ToolCallBlockData, ToolResultBlockData } from '../../../types';

import { countNonEmptyLines } from '../tool-renderers/chip';
import { computeLatestActivity, makeWorkspaceRelativePath, str } from './formatters';
import type {
  FinishedSubCall,
  OngoingSubCall,
  SubToolActivity,
  SubagentPhase,
  ToolCallReadSnapshot,
  ToolCallSubagentSnapshot,
} from './types';

const MAX_SUB_TOOL_CALLS_SHOWN = 4;
const MAX_SUBAGENT_DESCRIPTION_LENGTH = 60;

export type StateChangeCallback = () => void;

/** Derived per-call view of the entry's subagent block data. */
interface DerivedState {
  readonly agentId: string | undefined;
  readonly agentName: string | undefined;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly text: string;
  readonly ongoingSubCalls: ReadonlyMap<string, OngoingSubCall>;
  readonly finishedSubCalls: readonly FinishedSubCall[];
  readonly subToolActivities: ReadonlyMap<string, SubToolActivity>;
  readonly hiddenSubCallCount: number;
}

export class SubagentStateManager {
  // ── External refs ──
  private toolCall: ToolCallBlockData;
  private result: ToolResultBlockData | undefined;
  private readonly workspaceDir: string | undefined;
  private onStateChange: StateChangeCallback | undefined;

  // ── Derivation cache (rebuilt on updateToolCall / setResult) ──
  private derived: DerivedState | undefined;

  constructor(
    toolCall: ToolCallBlockData,
    result: ToolResultBlockData | undefined,
    workspaceDir: string | undefined,
  ) {
    this.toolCall = toolCall;
    this.result = result;
    this.workspaceDir = workspaceDir;
  }

  // ── Setup ──

  setOnStateChange(cb: StateChangeCallback | undefined): void {
    this.onStateChange = cb;
  }

  /** Re-point the manager at a newer block snapshot and re-derive. */
  updateToolCall(toolCall: ToolCallBlockData): void {
    this.toolCall = toolCall;
    this.derived = undefined;
    this.notify();
  }

  setResult(result: ToolResultBlockData | undefined): void {
    this.result = result;
    this.derived = undefined;
    this.notify();
  }

  getResult(): ToolResultBlockData | undefined {
    return this.result;
  }

  getToolCall(): ToolCallBlockData {
    return this.toolCall;
  }

  // ── Derivation ──

  private derive(): DerivedState {
    const cached = this.derived;
    if (cached !== undefined) return cached;
    const derived = this.deriveFromData();
    this.derived = derived;
    return derived;
  }

  private deriveFromData(): DerivedState {
    const { toolCall } = this;
    const subagent = toolCall.subagent;
    const ongoingSubCalls = new Map<string, OngoingSubCall>();
    const finishedSubCalls: FinishedSubCall[] = [];
    const subToolActivities = new Map<string, SubToolActivity>();
    let hiddenSubCallCount = 0;
    let orderSeq = 0;

    for (const call of subagent?.toolCalls ?? []) {
      const activity = subToolActivities.get(call.id);
      if (activity === undefined) {
        subToolActivities.set(call.id, {
          id: call.id,
          name: call.name,
          args: call.args,
          phase: call.result === undefined ? 'ongoing' : call.result.is_error === true ? 'failed' : 'done',
          ...(call.result === undefined ? {} : { output: call.result.output }),
          orderSeq: ++orderSeq,
        });
      } else {
        activity.name = call.name;
        activity.args = call.args;
        activity.phase =
          call.result === undefined ? 'ongoing' : call.result.is_error === true ? 'failed' : 'done';
        if (call.result !== undefined) activity.output = call.result.output;
      }
      if (call.result === undefined) {
        ongoingSubCalls.set(call.id, { name: call.name, args: call.args });
        continue;
      }
      finishedSubCalls.push({
        name: call.name,
        args: call.args,
        output: call.result.output,
        isError: call.result.is_error ?? false,
      });
    }
    while (finishedSubCalls.length > MAX_SUB_TOOL_CALLS_SHOWN) {
      finishedSubCalls.shift();
      hiddenSubCallCount += 1;
    }

    return {
      agentId: subagent?.id,
      agentName: subagent?.name,
      model: subagent?.model,
      effort: undefined,
      text: subagent?.text ?? '',
      ongoingSubCalls,
      finishedSubCalls,
      subToolActivities,
      hiddenSubCallCount,
    };
  }

  // ── Snapshot queries ──

  getSnapshot(): ToolCallSubagentSnapshot {
    const state = this.derive();
    const finished = state.finishedSubCalls.length + state.hiddenSubCallCount;
    const latestActivity = computeLatestActivity(
      state.ongoingSubCalls,
      state.finishedSubCalls,
      this.getCombinedText(),
      this.workspaceDir,
    );
    const derivedPhase = this.getDerivedPhase();
    const errorText =
      this.toolCall.backgroundStatus?.errorText ??
      (derivedPhase === 'failed' ? this.result?.output : undefined);
    return {
      toolCallId: this.toolCall.id,
      toolName: this.toolCall.name,
      toolCallDescription: str(this.toolCall.args['description']) || str(this.toolCall.description),
      agentName: state.agentName,
      model: state.model,
      effort: state.effort,
      phase: derivedPhase,
      toolCount: finished,
      elapsedSeconds: this.getElapsedSeconds(),
      tokens: 0,
      isError: derivedPhase === 'failed',
      errorText,
      latestActivity,
    };
  }

  getReadSnapshot(): ToolCallReadSnapshot {
    const args = this.toolCall.args;
    const filePathRaw = args['file_path'] ?? args['path'];
    const filePath =
      typeof filePathRaw === 'string'
        ? makeWorkspaceRelativePath(filePathRaw, this.workspaceDir)
        : undefined;
    if (this.result === undefined) {
      return { toolCallId: this.toolCall.id, filePath, phase: 'pending', lines: 0 };
    }
    if (this.result.is_error === true) {
      return { toolCallId: this.toolCall.id, filePath, phase: 'failed', lines: 0 };
    }
    return {
      toolCallId: this.toolCall.id,
      filePath,
      phase: 'done',
      lines: countNonEmptyLines(this.result.output),
    };
  }

  getAgentId(): string | undefined {
    const state = this.derive();
    if (state.agentId !== undefined && state.agentId.length > 0) return state.agentId;
    if (this.toolCall.name !== 'Agent' || this.result === undefined) return undefined;
    const match = this.result.output.match(/^agent_id:\s*(agent-[A-Za-z0-9_-]+)/m);
    return match?.[1];
  }

  getAgentToolDescription(): string | undefined {
    if (this.toolCall.name !== 'Agent') return undefined;
    const desc = this.toolCall.args['description'];
    return typeof desc === 'string' ? desc : undefined;
  }

  // ── State getters for rendering ──

  get agentIdValue(): string | undefined {
    return this.derive().agentId;
  }
  get agentNameValue(): string | undefined {
    return this.derive().agentName;
  }
  get phaseValue(): SubagentPhase | undefined {
    return this.getDerivedPhase();
  }
  get textValue(): string {
    return this.derive().text;
  }
  get resultSummaryValue(): string | undefined {
    // The tui2 data model folds the result summary into `subagent.text`;
    // keep the getter for surface parity — it reports the text tail.
    const text = this.derive().text.trim();
    return text.length === 0 ? undefined : text.split('\n').at(-1);
  }
  get errorValue(): string | undefined {
    if (this.getDerivedPhase() !== 'failed') return undefined;
    return this.toolCall.backgroundStatus?.errorText ?? this.result?.output;
  }
  get contextTokensValue(): number | undefined {
    return undefined;
  }
  get usageValue(): TokenUsage | undefined {
    return undefined;
  }
  get modelValue(): string | undefined {
    return this.derive().model;
  }
  get effortValue(): string | undefined {
    return this.derive().effort;
  }
  get ongoingSubCallsMap(): ReadonlyMap<string, OngoingSubCall> {
    return this.derive().ongoingSubCalls;
  }
  get finishedSubCallsList(): readonly FinishedSubCall[] {
    return this.derive().finishedSubCalls;
  }
  get subToolActivitiesMap(): ReadonlyMap<string, SubToolActivity> {
    return this.derive().subToolActivities;
  }
  get hiddenSubCallCountValue(): number {
    return this.derive().hiddenSubCallCount;
  }
  get maxSubagentDescriptionLength(): number {
    return MAX_SUBAGENT_DESCRIPTION_LENGTH;
  }

  hasState(): boolean {
    const state = this.derive();
    return (
      state.agentId !== undefined ||
      state.ongoingSubCalls.size > 0 ||
      state.finishedSubCalls.length > 0 ||
      state.subToolActivities.size > 0 ||
      state.text.length > 0 ||
      this.toolCall.backgroundStatus !== undefined ||
      this.toolCall.backgrounded === true
    );
  }

  getCombinedText(): string {
    return this.derive().text;
  }

  getDerivedPhase(): SubagentPhase | undefined {
    const backgroundStatus = this.toolCall.backgroundStatus;
    if (backgroundStatus !== undefined) {
      return backgroundStatus.status === 'completed' ? 'done' : 'failed';
    }
    if (this.toolCall.backgrounded === true) return 'backgrounded';
    if (this.result !== undefined) return this.result.is_error ? 'failed' : 'done';
    if (this.hasState()) return 'running';
    return undefined;
  }

  getElapsedSeconds(): number | undefined {
    const startedAtMs = this.toolCall.streamingStartedAtMs;
    if (startedAtMs === undefined) return undefined;
    return Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  }

  formatContextTokens(): string | undefined {
    return undefined;
  }

  formatTokensDisplay(): string | undefined {
    return undefined;
  }

  /** Kept for surface parity with v1 — no live timer lives here anymore. */
  syncElapsedTimer(_isSingleSubagentView: boolean, _onTick: () => void): void {}
  stopElapsedTimer(): void {}
  dispose(): void {}

  // ── Private helpers ──

  private notify(): void {
    this.onStateChange?.();
  }
}
