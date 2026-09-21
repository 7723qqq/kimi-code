/**
 * The chat view's store, backed by the v1 transcript data model.
 *
 * The wire carries `transcript.reset` (a baseline snapshot) and
 * `transcript.ops` (op batches with a monotonic seq); folding them is
 * `@moonshot-ai/transcript`'s job, so this store holds one `AgentState`,
 * applies each batch through `applyOperation`, and projects the result into
 * the view model. Notifications are throttled trailing-edge so a per-token
 * delta stream does not re-render per token.
 */
import {
  applyOperation,
  EMPTY_AGENT_STATE,
  type AgentState,
  type AgentTranscriptSnapshot,
  type TranscriptOpBatch,
} from '@moonshot-ai/transcript';

import {
  EMPTY_CHAT_STATE,
  type ChatState,
  hasTurnId,
  newestTerminalStepId,
  oldestTurnId,
  projectChatState,
} from './model';

export {
  EMPTY_CHAT_STATE,
  hasTurnId,
  newestTerminalStepId,
  oldestTurnId,
  projectChatState,
  timelineKeyOf,
  turnIdOf,
  type AssistantMessage,
  type ChatState,
  type StepMessage,
  type SystemMessage,
  type ThinkingMessage,
  type TimelineEntry,
  type TimelineMessage,
  type ToolCallMessage,
  type TurnMessage,
  type UserMessage,
} from './model';

export class ChatStore {
  private agent: AgentState = EMPTY_AGENT_STATE;
  private state: ChatState = EMPTY_CHAT_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly notifyIntervalMs: number;
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  constructor(opts?: { notifyIntervalMs?: number }) {
    this.notifyIntervalMs = opts?.notifyIntervalMs ?? 80;
  }

  getState(): ChatState {
    return this.state;
  }

  /** The underlying transcript state (the audit panel diffs consecutive ones). */
  getAgentState(): AgentState {
    return this.agent;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Install a `transcript.reset` baseline for one agent. */
  applyReset(agentId: string, snapshot: AgentTranscriptSnapshot): void {
    const result = applyOperation(this.agent, { op: 'reset', agentId, snapshot });
    this.commit(result.state);
  }

  /**
   * Apply one `transcript.ops` batch. A reported gap (the server's seq
   * jumped past one we never saw) leaves the state untouched and is
   * surfaced to the caller, which answers it with a resubscribe from the
   * last good cursor.
   */
  applyBatch(batch: TranscriptOpBatch): { gap: boolean } {
    let state = this.agent;
    let gap = false;
    for (const op of batch.ops) {
      const result = applyOperation(state, op);
      state = result.state;
      if (result.gap !== undefined) gap = true;
    }
    this.commit(state);
    return { gap };
  }

  setHasMoreOlder(flag: boolean): void {
    if (this.state.hasMoreOlder === flag) return;
    this.state = { ...this.state, hasMoreOlder: flag };
    this.scheduleNotify();
  }

  /** Flush a pending throttled notification (teardown / explicit sync point). */
  flushNotify(): void {
    if (this.notifyTimer !== undefined) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    for (const listener of this.listeners) listener();
  }

  private commit(agent: AgentState): void {
    this.agent = agent;
    this.state = projectChatState(agent);
    this.scheduleNotify();
  }

  private scheduleNotify(): void {
    this.dirty = true;
    if (this.notifyTimer !== undefined) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      for (const listener of this.listeners) listener();
    }, this.notifyIntervalMs);
  }
}
