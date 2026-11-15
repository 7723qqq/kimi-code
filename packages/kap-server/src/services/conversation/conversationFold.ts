import {
  PROVIDER_FILTERED_ERROR_CODE,
  isUndoAnchor,
  type ContextMessage,
} from '@moonshot-ai/agent-core-v2';
import { isUserPromptSubmitHookPart } from '@moonshot-ai/agent-core-v2/agent/contextMemory/hookParts';
import { LOOP_MAX_STEPS_EXCEEDED_ERROR_CODE } from '@moonshot-ai/agent-core-v2/human/agent/errors';
import { stripBundledSkillBlocks } from '@moonshot-ai/agent-core-v2/human/agent/origin';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/human/llm/message';

import type {
  CompactionItem,
  ConversationItem,
  ConversationOutcome,
  ConversationTurn,
  ErrorInfo,
  NotificationItem,
  ToolCallItem,
  TurnEndReason,
  UserMessageItem,
} from '../../protocol/conversation';
import {
  contentItem,
  endToolCall,
  isPlanTool,
  isoTime,
  notificationItem,
  refreshToolCall,
  toolCallItem,
  userMessageItem,
  type ToolInteraction,
} from './conversationItems';
import { parseTaskNotifications, plainTaskNotification } from './taskNotifications';

export interface TurnEnd {
  readonly outcome: ConversationOutcome;
  readonly reason?: TurnEndReason;
  readonly error?: ErrorInfo;
}

export interface ConversationFork {
  readonly source: 'btw' | 'fork';
  readonly forkedFrom: string;
}

export interface StepTrack {
  readonly id: string;
  readonly index: number;
  readonly startedAt: number;
  ended: boolean;
  failed?: boolean;
  interruptReason?: string;
}

export interface ToolTrack {
  turnId?: string;
  interaction?: ToolInteraction;
  planDisplay?: unknown;
}

type CompactionDetails = Pick<
  CompactionItem,
  'trigger' | 'instruction' | 'summary' | 'tokens_before' | 'tokens_after' | 'compacted_count'
>;

interface PendingPrompt {
  readonly turnNumber?: number;
  readonly promptId?: string;
  readonly originKind?: string;
}

interface UndoAnchor {
  readonly turnId: string;
  readonly itemCount: number;
  readonly stepCount: number;
}

export interface ConversationState {
  readonly agentId: string;
  readonly debug: boolean;
  fork?: ConversationFork;
  inheriting: boolean;
  clock: number;
  turns: ConversationTurn[];
  steps: Record<string, StepTrack[]>;
  tools: Record<string, ToolTrack>;
  interactions: Record<string, string>;
  nextOrdinal: number;
  openTurnId?: string;
  pendingPrompt?: PendingPrompt;
  pendingSteers: number;
  anchors: UndoAnchor[];
  implicitlyEnded: Record<string, true>;
  provisionalEnds: Record<string, TurnEnd>;
  recordsTurnEnds: boolean;
  stepParts: Record<string, number>;
  compaction?: CompactionDetails;
}

export function createConversationState(agentId: string, fork?: ConversationFork, debug = false): ConversationState {
  return {
    agentId,
    debug,
    fork,
    inheriting: fork !== undefined,
    clock: 0,
    turns: [],
    steps: {},
    tools: {},
    interactions: {},
    nextOrdinal: 0,
    pendingSteers: 0,
    anchors: [],
    implicitlyEnded: {},
    provisionalEnds: {},
    recordsTurnEnds: false,
    stepParts: {},
  };
}

export const COMPLETED: TurnEnd = { outcome: 'completed' };
const HIDDEN_ORIGIN_KINDS: ReadonlySet<string> = new Set(['injection']);
const TASK_ORIGIN_KINDS: ReadonlySet<string> = new Set(['task', 'background_task', 'task_notification']);
const TURN_OPENING_SYSTEM_TRIGGERS: ReadonlySet<string> = new Set(['goal_continuation', 'subagent']);

export interface RunningWork {
  readonly turnNumber?: number;
}

export function settleOrphanTurns(state: ConversationState, running: RunningWork = {}): ConversationState {
  const orphaned = (turn: ConversationTurn): boolean =>
    turn.status === 'running' && (turn.turn_number === undefined || turn.turn_number !== running.turnNumber);
  if (!state.turns.some(orphaned)) return state;
  const next: ConversationState = {
    ...state,
    turns: [...state.turns],
    tools: { ...state.tools },
    provisionalEnds: { ...state.provisionalEnds },
  };
  next.turns.forEach((turn, index) => {
    if (!orphaned(turn)) return;
    const settled = structuredClone(turn);
    for (const item of settled.items) {
      const track = item.type === 'tool_call' ? next.tools[item.item_id] : undefined;
      if (track !== undefined) next.tools[item.item_id] = structuredClone(track);
    }
    next.turns[index] = settled;
    endTurn(next, settled, state.recordsTurnEnds ? { outcome: 'interrupted', reason: 'aborted' } : COMPLETED, state.clock);
  });
  return next;
}

export function applyMessage(state: ConversationState, message: ContextMessage | undefined, time: number): void {
  if (message === undefined) return;
  if (message.role === 'assistant') {
    applyLegacyAssistant(state, message, time);
    return;
  }
  if (message.role === 'tool') {
    applyLegacyToolResult(state, message, time);
    return;
  }
  if (message.role !== 'user') return;
  const origin = message.origin;
  const kind: string | undefined = origin?.kind;
  if (kind !== undefined && HIDDEN_ORIGIN_KINDS.has(kind)) return;
  const pending = state.pendingPrompt;
  if (
    pending !== undefined &&
    ((pending.promptId !== undefined && message.id !== undefined && pending.promptId !== message.id) ||
      (pending.originKind !== undefined && pending.originKind !== (kind ?? 'user')))
  ) {
    state.pendingPrompt = undefined;
  }
  if (kind === 'compaction_summary') {
    appendCompaction(state, { trigger: 'auto', summary: textOf(message.content) }, time);
    return;
  }
  const steered = state.pendingSteers > 0;
  if (steered) state.pendingSteers -= 1;
  if ((origin?.kind === 'skill_activation' || origin?.kind === 'plugin_command') && origin.trigger !== 'user-slash') return;
  const notification = kind !== undefined && TASK_ORIGIN_KINDS.has(kind);
  const open = openTurn(state);
  if (notification && (state.pendingPrompt === undefined || steered)) {
    const turn = open ?? addTurn(state, time);
    turn.items.push(...notificationItems(turn, message, time));
    if (open === undefined) endTurn(state, turn, COMPLETED, time);
    return;
  }
  const inTurn = origin !== undefined && 'inTurn' in origin && origin.inTurn === true;
  if (inTurn || (steered && state.pendingPrompt === undefined && open !== undefined)) {
    const turn = open ?? addTurn(state, time);
    if (isUndoAnchor(message)) {
      state.anchors.push({ turnId: turn.turn_id, itemCount: turn.items.length, stepCount: state.steps[turn.turn_id]?.length ?? 0 });
    }
    turn.items.push(userMessage(message.id ?? nextItemId(turn), 'steer', message.id, message, time));
    if (open === undefined) endTurn(state, turn, COMPLETED, time);
    return;
  }
  if ((kind === 'system_trigger' || kind === 'retry') && state.pendingPrompt === undefined) {
    const name = (origin as { name?: unknown } | undefined)?.name;
    if (typeof name !== 'string' || !TURN_OPENING_SYSTEM_TRIGGERS.has(name)) return;
  }
  const owned = state.pendingPrompt !== undefined;
  const promptId = message.id ?? state.pendingPrompt?.promptId;
  const turn = owned ? startTurn(state, time) : addTurn(state, time);
  if (isUndoAnchor(message)) state.anchors.push({ turnId: turn.turn_id, itemCount: 0, stepCount: 0 });
  if (notification) turn.items.push(...notificationItems(turn, message, time));
  else turn.items.push(userMessage(promptId ?? nextItemId(turn), 'opener', promptId, message, time));
  if (!owned) endTurn(state, turn, COMPLETED, time);
}

function userMessage(
  id: string,
  placement: UserMessageItem['placement'],
  promptId: string | undefined,
  message: ContextMessage,
  time: number,
): UserMessageItem {
  const origin = message.origin;
  const hidden = origin?.kind === 'retry' || (origin?.kind === 'system_trigger' && origin.name !== 'subagent');
  const content = hidden ? [] : stripBundledSkillBlocks(message).filter((part) => !isUserPromptSubmitHookPart(part));
  return userMessageItem(id, placement, promptId, origin, content, time);
}

function notificationItems(turn: ConversationTurn, message: ContextMessage, time: number): NotificationItem[] {
  const baseId = message.id ?? nextItemId(turn);
  const text = textOf(message.content, '\n');
  const parsed = parseTaskNotifications(text);
  const origin = message.origin as { readonly kind?: string; readonly taskId?: unknown } | undefined;
  const notifications = parsed.length > 0 || text.trim() === ''
    ? parsed
    : [plainTaskNotification(origin?.kind ?? 'task', stringField(origin?.taskId) ?? '', text.trim())];
  return notifications.map((notification, index) =>
    notificationItem(index === 0 ? baseId : `${baseId}:${index}`, notification, time),
  );
}

function applyLegacyAssistant(
  state: ConversationState,
  message: ContextMessage,
  time: number,
): void {
  const open = openTurn(state);
  const ownerless = open === undefined && state.pendingPrompt === undefined;
  const turn = open ?? (ownerless ? addTurn(state, time) : startTurn(state, time));
  for (const [index, part] of message.content.entries()) {
    const timing = message.contentTimings?.[index];
    const item = contentItem(part, nextItemId(turn), undefined, timing?.startedAt ?? time, timing?.durationMs);
    if (item !== undefined) turn.items.push(item);
  }
  for (const call of message.toolCalls ?? []) {
    upsertToolCall(
      state,
      turn,
      toolCallItem(call.id, call.name, undefined, time, parseArguments(call.arguments), message.toolCallDisplays?.[call.id]),
    );
  }
  if (ownerless) endTurn(state, turn, COMPLETED, time);
}

function applyLegacyToolResult(
  state: ConversationState,
  message: ContextMessage,
  time: number,
): void {
  if (message.toolCallId === undefined) return;
  const found = findToolCall(state, message.toolCallId);
  if (found !== undefined) finishToolCall(state, found, message.content, message.isError === true, message.note, time);
}

export function turnEndOf(reason: unknown, error: ErrorInfo | undefined, provisional: TurnEnd | undefined): TurnEnd {
  switch (reason) {
    case 'cancelled':
      return provisional?.outcome === 'interrupted' ? provisional : { outcome: 'interrupted', reason: 'user_cancelled' };
    case 'failed':
      return { outcome: 'failed', reason: failureReasonOf(error), error };
    case 'blocked':
      return { outcome: 'failed', reason: 'blocked', error };
    default:
      return COMPLETED;
  }
}

function failureReasonOf(error: ErrorInfo | undefined): TurnEndReason {
  if (error?.code === LOOP_MAX_STEPS_EXCEEDED_ERROR_CODE) return 'max_steps';
  if (error?.code === PROVIDER_FILTERED_ERROR_CODE) return 'filtered';
  return 'error';
}

function appendCompaction(state: ConversationState, compaction: CompactionDetails, time: number): void {
  const open = openTurn(state);
  const turn = open ?? addTurn(state, time, 'system');
  turn.items.push({
    type: 'system',
    kind: 'compaction',
    item_id: nextItemId(turn),
    status: 'ended',
    outcome: 'completed',
    created_at: isoTime(time),
    ...compaction,
  });
  if (open === undefined) endTurn(state, turn, COMPLETED, time);
}

function startTurn(state: ConversationState, time: number): ConversationTurn {
  const previous = openTurn(state);
  if (previous !== undefined) {
    endTurn(state, previous, state.provisionalEnds[previous.turn_id] ?? COMPLETED, time);
    state.implicitlyEnded[previous.turn_id] = true;
  }
  const turn = addTurn(state, time, 'agent', state.pendingPrompt?.turnNumber);
  state.pendingPrompt = undefined;
  state.openTurnId = turn.turn_id;
  return turn;
}

function addTurn(
  state: ConversationState,
  time: number,
  kind: ConversationTurn['kind'] = 'agent',
  turnNumber?: number,
): ConversationTurn {
  const ordinal = state.nextOrdinal++;
  const turn: ConversationTurn = {
    turn_id: turnIdOf(state.agentId, ordinal, time),
    ordinal,
    kind,
    status: 'running',
    turn_number: turnNumber,
    started_at: isoTime(time),
    steps: [],
    items: [],
  };
  state.turns.push(turn);
  return turn;
}

function turnIdOf(agentId: string, ordinal: number, startedAt: number): string {
  const digest = new Bun.CryptoHasher('sha1').update(`${agentId}\n${ordinal}\n${startedAt}`).digest('hex');
  return `t_${digest.slice(0, 12)}`;
}

export function endTurn(state: ConversationState, turn: ConversationTurn, end: TurnEnd, time: number): void {
  turn.status = 'ended';
  turn.outcome = end.outcome;
  turn.end_reason = end.reason;
  turn.error = end.error;
  turn.retry = undefined;
  turn.ended_at = isoTime(time);
  turn.duration_ms = Math.max(0, time - Date.parse(turn.started_at));
  for (const item of turn.items) endItem(state, item, time);
  delete state.provisionalEnds[turn.turn_id];
  if (state.openTurnId === turn.turn_id) {
    state.openTurnId = state.turns.findLast((candidate) => candidate.status === 'running')?.turn_id;
  }
}

function endItem(state: ConversationState, item: ConversationItem, time: number): void {
  if (item.type === 'tool_call') {
    const interaction = state.tools[item.item_id]?.interaction;
    if (interaction?.pending === true) interaction.pending = false;
    if (item.status !== 'ended') {
      item.status = 'ended';
      item.outcome = 'interrupted';
      item.ended_at = isoTime(time);
    }
    refreshTool(state, item);
    return;
  }
  if ((item.type === 'assistant_message' || item.type === 'reasoning') && item.status === 'running') {
    item.status = 'ended';
    item.outcome = 'completed';
  }
}

export function openTurn(state: ConversationState): ConversationTurn | undefined {
  return state.openTurnId === undefined ? undefined : findTurn(state, state.openTurnId);
}

function findTurn(state: ConversationState, turnId: string): ConversationTurn | undefined {
  return state.turns.findLast((turn) => turn.turn_id === turnId);
}

function findToolCall(state: ConversationState, toolCallId: string): { turn: ConversationTurn; item: ToolCallItem } | undefined {
  const turnId = state.tools[toolCallId]?.turnId;
  const turn = turnId === undefined ? undefined : findTurn(state, turnId);
  const item = turn?.items.find((candidate) => candidate.item_id === toolCallId);
  if (turn === undefined || item?.type !== 'tool_call') return undefined;
  return { turn, item };
}

function callTrack(state: ConversationState, toolCallId: string): ToolTrack {
  if (findToolCall(state, toolCallId)?.item.status === 'ended') state.tools[toolCallId] = {};
  return (state.tools[toolCallId] ??= {});
}

function upsertToolCall(state: ConversationState, turn: ConversationTurn, fresh: ToolCallItem): void {
  const track = callTrack(state, fresh.item_id);
  const existing = turn.items.find((candidate) => candidate.item_id === fresh.item_id);
  const previous = existing?.type === 'tool_call' ? existing : undefined;
  if (isPlanTool(fresh.name)) track.planDisplay = fresh.display ?? track.planDisplay;
  const item: ToolCallItem = {
    ...fresh,
    created_at: previous?.created_at ?? fresh.created_at,
    started_at: previous?.started_at ?? fresh.started_at,
    display: fresh.display ?? previous?.display,
    agent_refs: previous?.agent_refs,
  };
  track.turnId = turn.turn_id;
  refreshToolCall(item, track.interaction, track.planDisplay);
  upsertItem(turn, item);
}

function finishToolCall(
  state: ConversationState,
  found: { turn: ConversationTurn; item: ToolCallItem },
  output: string | readonly ContentPart[],
  isError: boolean,
  note: string | undefined,
  time: number,
): void {
  const cancelled = state.provisionalEnds[found.turn.turn_id]?.outcome === 'interrupted';
  endToolCall(found.item, output, !isError ? 'completed' : cancelled ? 'interrupted' : 'failed', note, time);
  refreshTool(state, found.item);
}

function refreshTool(state: ConversationState, item: ToolCallItem): void {
  const track = state.tools[item.item_id];
  refreshToolCall(item, track?.interaction, track?.planDisplay);
}

function upsertItem(turn: ConversationTurn, item: ConversationItem): void {
  const index = turn.items.findIndex((candidate) => candidate.item_id === item.item_id);
  if (index === -1) turn.items.push(item);
  else turn.items[index] = item;
}

function nextItemId(turn: ConversationTurn): string {
  return `${turn.turn_id}#${turn.items.length}`;
}

function textOf(content: readonly ContentPart[], separator = ''): string {
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(separator);
}

function parseArguments(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}