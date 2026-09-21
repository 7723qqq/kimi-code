/**
 * The chat view's local view model, projected from the v1 transcript data
 * model (`@moonshot-ai/transcript`).
 *
 * The rendering layer speaks these shapes and nothing else: the wire model
 * changed when the v3 flat-entity surface was dropped, but a turn card, a
 * step row, a user bubble and a tool call render the same way whichever
 * protocol carried them. Keeping the projection in one place is what lets
 * the views stay untouched across that swap.
 */
import type {
  AgentState,
  TranscriptFrame,
  TranscriptInteraction,
  TranscriptItem,
  TranscriptMeta,
  TranscriptStep,
  TranscriptTask,
  TranscriptTodo,
  TranscriptTurn,
  TurnOrigin as TranscriptTurnOrigin,
  TranscriptUserOrigin,
} from '@moonshot-ai/transcript';

export interface TurnMessage {
  readonly type: 'turn';
  readonly turn_id: string;
  readonly ordinal: number;
  readonly status: TranscriptTurn['state'];
  readonly origin: TranscriptTurnOrigin;
  readonly prompt?: string;
  readonly attachment_ids?: readonly string[];
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly usage?: TranscriptTurn['usage'];
  readonly duration_ms?: number;
  readonly error?: string;
}

export interface StepMessage {
  readonly type: 'step';
  readonly step_id: string;
  readonly turn_id: string;
  readonly ordinal: number;
  readonly status: TranscriptStep['state'];
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly usage?: TranscriptStep['usage'];
  readonly finish_reason?: string;
  readonly end_reason?: string;
  readonly end_message?: string;
  readonly retry?: TranscriptStep['retry'];
}

export interface UserMessage {
  readonly type: 'user';
  readonly id: string;
  readonly turn_id: string;
  readonly step_id: string;
  readonly text: string;
  readonly origin?: TranscriptUserOrigin;
  readonly attachment_ids?: readonly string[];
  readonly skill_activations?: readonly { readonly skillName: string; readonly skillArgs?: string }[];
  readonly status?: 'unread';
  readonly at?: string;
}

export interface AssistantMessage {
  readonly type: 'assistant';
  readonly id: string;
  readonly turn_id: string;
  readonly step_id: string;
  readonly text: string;
  readonly at?: string;
}

export interface ThinkingMessage {
  readonly type: 'thinking';
  readonly id: string;
  readonly turn_id: string;
  readonly step_id: string;
  readonly text: string;
  readonly at?: string;
}

export interface ToolCallMessage {
  readonly type: 'tool_call';
  readonly tool_call_id: string;
  readonly turn_id: string;
  readonly step_id: string;
  readonly name: string;
  readonly view?: string;
  readonly state: 'running' | 'done' | 'error';
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: string;
  readonly input_text?: string;
  readonly task_id?: string;
  readonly approval_id?: string;
  readonly todo_id?: string;
  readonly agent_refs?: readonly { readonly agentId: string; readonly role?: 'child' | 'member' }[];
  readonly progress?: { kind: string; text?: string; percent?: number };
  readonly at?: string;
}

export interface SystemMessage {
  readonly type: 'system';
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly at?: string;
}

export type TimelineMessage =
  | TurnMessage
  | StepMessage
  | UserMessage
  | AssistantMessage
  | ThinkingMessage
  | ToolCallMessage
  | SystemMessage;

export interface TimelineEntry {
  readonly key: string;
  readonly message: TimelineMessage;
}

export interface ChatState {
  readonly entries: readonly TimelineEntry[];
  readonly interactions: ReadonlyMap<string, TranscriptInteraction>;
  readonly tasks: ReadonlyMap<string, TranscriptTask>;
  readonly todos: ReadonlyMap<string, TranscriptTodo>;
  /** Session-level facts the badges read (model, permission, modes, goal). */
  readonly meta: TranscriptMeta;
  readonly hasMoreOlder: boolean;
}

export const EMPTY_CHAT_STATE: ChatState = {
  entries: [],
  interactions: new Map(),
  tasks: new Map(),
  todos: new Map(),
  meta: {},
  hasMoreOlder: false,
};

/** The turn a queued (not yet accepted) prompt is grouped under. */
export const QUEUED_TURN_ID = 'queued';

function frameText(frame: TranscriptFrame): string {
  switch (frame.kind) {
    case 'text':
    case 'thinking':
      return frame.text;
    case 'tool':
      return frame.inputText ?? '';
    case 'notice':
      return frame.message;
  }
}

function toolCallOf(turnId: string, stepId: string, frame: TranscriptFrame): ToolCallMessage | null {
  if (frame.kind !== 'tool') return null;
  return {
    type: 'tool_call',
    tool_call_id: frame.toolCallId,
    turn_id: turnId,
    step_id: stepId,
    name: frame.name,
    view: frame.view,
    state: frame.state,
    input: frame.input,
    output: frame.output,
    error: frame.error,
    input_text: frame.inputText,
    task_id: frame.taskId,
    approval_id: frame.approvalId,
    todo_id: frame.todoId,
    agent_refs: frame.agentRefs,
    progress: frame.progress,
  };
}

function framesOf(turnId: string, stepId: string, frames: readonly TranscriptFrame[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const frame of frames) {
    switch (frame.kind) {
      case 'text':
        out.push({
          key: `frame:${frame.frameId}`,
          message:
            frame.role === 'user'
              ? {
                  type: 'user',
                  id: frame.frameId,
                  turn_id: turnId,
                  step_id: stepId,
                  text: frame.text,
                  origin: frame.origin,
                  attachment_ids: frame.attachmentIds,
                  skill_activations:
                    frame.origin?.kind === 'user' ? frame.origin.skillActivations : undefined,
                }
              : {
                  type: 'assistant',
                  id: frame.frameId,
                  turn_id: turnId,
                  step_id: stepId,
                  text: frame.text,
                },
        });
        break;
      case 'thinking':
        out.push({
          key: `frame:${frame.frameId}`,
          message: {
            type: 'thinking',
            id: frame.frameId,
            turn_id: turnId,
            step_id: stepId,
            text: frame.text,
          },
        });
        break;
      case 'tool': {
        const call = toolCallOf(turnId, stepId, frame);
        if (call !== null) out.push({ key: `tool:${call.tool_call_id}`, message: call });
        break;
      }
      case 'notice':
        out.push({
          key: `frame:${frame.frameId}`,
          message: {
            type: 'system',
            id: frame.frameId,
            kind: frame.level,
            text: frameText(frame),
          },
        });
        break;
    }
  }
  return out;
}

function stepEntries(turnId: string, step: TranscriptStep): TimelineEntry[] {
  const head: TimelineEntry = {
    key: `step:${step.stepId}`,
    message: {
      type: 'step',
      step_id: step.stepId,
      turn_id: turnId,
      ordinal: step.ordinal,
      status: step.state,
      started_at: step.startedAt,
      ended_at: step.endedAt,
      usage: step.usage,
      finish_reason: step.finishReason,
      end_reason: step.endReason,
      end_message: step.endMessage,
      retry: step.retry,
    },
  };
  return [head, ...framesOf(turnId, step.stepId, step.frames)];
}

function markerEntry(item: TranscriptItem): TimelineEntry | null {
  if (item.kind !== 'marker') return null;
  const payload = item.payload as { text?: unknown } | undefined;
  const text = typeof payload?.text === 'string' ? payload.text : item.marker;
  return {
    key: `marker:${item.markerId}`,
    message: { type: 'system', id: item.markerId, kind: item.marker, text, at: item.at },
  };
}

/**
 * Flatten one agent's transcript state into the timeline the chat view
 * renders: turns in order, each with its step rows and frames, and the
 * markers / task refs that sit between them.
 */
export function projectChatState(state: AgentState): ChatState {
  const entries: TimelineEntry[] = [];
  for (const item of state.items) {
    switch (item.kind) {
      case 'turn': {
        const turn: TranscriptTurn = item;
        entries.push({
          key: `turn:${turn.turnId}`,
          message: {
            type: 'turn',
            turn_id: turn.turnId,
            ordinal: turn.ordinal,
            status: turn.state,
            origin: turn.origin,
            prompt: turn.prompt,
            attachment_ids: turn.attachmentIds,
            started_at: turn.startedAt,
            ended_at: turn.endedAt,
            usage: turn.usage,
            duration_ms: turn.durationMs,
            error: turn.error,
          },
        });
        for (const step of turn.steps) entries.push(...stepEntries(turn.turnId, step));
        break;
      }
      case 'marker': {
        const entry = markerEntry(item);
        if (entry !== null) entries.push(entry);
        break;
      }
      case 'taskref':
        entries.push({
          key: `taskref:${item.refId}`,
          message: { type: 'system', id: item.refId, kind: 'task', text: item.taskId, at: item.at },
        });
        break;
    }
  }
  return {
    entries,
    interactions: state.interactions,
    tasks: state.tasks,
    todos: state.todos,
    meta: state.meta,
    hasMoreOlder: state.hasMoreOlder,
  };
}

export function timelineKeyOf(message: TimelineMessage): string {
  switch (message.type) {
    case 'turn':
      return `turn:${message.turn_id}`;
    case 'step':
      return `step:${message.step_id}`;
    case 'user':
    case 'assistant':
    case 'thinking':
      return `frame:${message.id}`;
    case 'tool_call':
      return `tool:${message.tool_call_id}`;
    case 'system':
      return `marker:${message.id}`;
  }
}

export function turnIdOf(message: TimelineMessage): string | undefined {
  return 'turn_id' in message ? message.turn_id : undefined;
}

export function oldestTurnId(entries: readonly TimelineEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.message.type === 'turn') return entry.message.turn_id;
  }
  return undefined;
}

export function hasTurnId(entries: readonly TimelineEntry[], turnId: string): boolean {
  return entries.some((entry) => entry.message.type === 'turn' && entry.message.turn_id === turnId);
}

/** The newest step that has finished, for the reconnect catch-up anchor. */
export function newestTerminalStepId(entries: readonly TimelineEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i]!.message;
    if (message.type === 'step' && message.status !== 'running') return message.step_id;
  }
  return undefined;
}
