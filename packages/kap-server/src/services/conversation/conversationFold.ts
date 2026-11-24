import {
  PROVIDER_FILTERED_ERROR_CODE,
  isUndoAnchor,
  type ContextMessage,
} from '@moonshot-ai/agent-core-v2';
import { isUserPromptSubmitHookPart } from '@moonshot-ai/agent-core-v2/agent/contextMemory/hookParts';
import type { LoopRecordedEvent } from '@moonshot-ai/agent-core-v2/agent/contextMemory/loopEventFold';
import { LOOP_MAX_STEPS_EXCEEDED_ERROR_CODE } from '@moonshot-ai/agent-core-v2/human/agent/errors';
import { stripBundledSkillBlocks } from '@moonshot-ai/agent-core-v2/human/agent/origin';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/human/llm/message';
import type { WireRecord } from '@moonshot-ai/agent-core-v2/wire/record';
import { turnModelStepSchema, type TurnModelStep, type TurnReplyModel } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';

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
  agentRefOf,
  errorInfoOf,
  promptIdsOf,
  requestDebug,
  retryStateOf,
  stepOutcome,
  stepSummary,
  totalUsage,
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

export interface FeedbackTurnAttribution {
  readonly requestId?: string;
  readonly replyModel?: TurnReplyModel & { readonly isKfc?: boolean };
  readonly modelSteps?: readonly TurnModelStep[];
}

const modelStepsSchema = turnModelStepSchema.array();

export interface ToolTrack {
  turnId?: string;
  turnIndex?: number;
  itemIndex?: number;
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
  readonly feedbackAttribution: Map<string, FeedbackTurnAttribution>;
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
  trailingRejectedPrompt: boolean;
  awaitingContinuationTurnNumber?: number;
  latestPromptId?: string;
  stepParts: Record<string, number>;
  compaction?: CompactionDetails;
}

export function createConversationState(
  agentId: string,
  fork?: ConversationFork,
  debug = false,
): ConversationState {
  return {
    agentId,
    debug,
    fork,
    inheriting: fork !== undefined,
    clock: 0,
    turns: [],
    feedbackAttribution: new Map(),
    steps: {},
    tools: {},
    interactions: {},
    nextOrdinal: 0,
    pendingSteers: 0,
    anchors: [],
    implicitlyEnded: {},
    provisionalEnds: {},
    recordsTurnEnds: false,
    trailingRejectedPrompt: false,
    stepParts: {},
  };
}

export const COMPLETED: TurnEnd = { outcome: 'completed' };
const HIDDEN_ORIGIN_KINDS: ReadonlySet<string> = new Set(['injection']);
const TASK_ORIGIN_KINDS: ReadonlySet<string> = new Set([
  'task',
  'background_task',
  'task_notification',
]);
const TURN_OPENING_SYSTEM_TRIGGERS: ReadonlySet<string> = new Set([
  'goal_continuation',
  'subagent',
]);

export function applyConversationRecord(state: ConversationState, record: WireRecord): void {
  const time = numberField(record.time) ?? state.clock;
  state.clock = time;
  if (state.fork !== undefined) {
    const turn = addTurn(state, time, 'system');
    turn.items.push({
      type: 'system',
      kind: 'fork_boundary',
      item_id: nextItemId(turn),
      status: 'ended',
      outcome: 'completed',
      created_at: isoTime(time),
      source: state.fork.source,
      forked_from: { agent_id: state.fork.forkedFrom },
    });
    endTurn(state, turn, COMPLETED, time);
    state.fork = undefined;
  }
  if (state.inheriting) {
    if (record.type !== 'turn.prompt') return;
    state.inheriting = false;
  }
  switch (record.type) {
    case 'turn.prompt': {
      if (typeof record['trigger'] === 'string') state.recordsTurnEnds = true;
      state.trailingRejectedPrompt = false;
      const promptId = stringField(record['promptId']);
      const turnNumber = numberField(record['turnId']);
      state.awaitingContinuationTurnNumber =
        record['trigger'] === 'continue' && promptId === undefined ? (turnNumber ?? -1) : undefined;
      if (promptId !== undefined) state.latestPromptId = promptId;
      state.pendingPrompt = {
        turnNumber,
        promptId,
        originKind: stringField((record['origin'] as { kind?: unknown } | undefined)?.kind),
      };
      return;
    }
    case 'context.append_message':
      applyMessage(state, record['message'] as ContextMessage | undefined, time);
      return;
    case 'context.append_loop_event':
      applyLoopEvent(state, record['event'] as LoopRecordedEvent | undefined, time);
      return;
    case 'turn.steer':
      applySteer(state, record);
      return;
    case 'turn.cancel': {
      const turn =
        findTurnByNumber(state, numberField(record['turnId'])) ?? unnumberedOpenTurn(state);
      if (turn?.status === 'running')
        state.provisionalEnds[turn.turn_id] = {
          outcome: 'interrupted',
          reason: record['reason'] === 'aborted' ? 'aborted' : 'user_cancelled',
        };
      return;
    }
    case 'turn.step.interrupted':
      applyStepInterrupted(state, record);
      return;
    case 'turn.step.started': {
      const turn =
        findTurnByNumber(state, numberField(record['turnId'])) ?? unnumberedOpenTurn(state);
      if (turn !== undefined) turn.retry = undefined;
      return;
    }
    case 'turn.step.retrying':
      applyStepRetrying(state, record);
      return;
    case 'turn.ended':
      applyTurnEnded(state, record, time);
      return;
    case 'prompt.completed':
      if (record['reason'] === 'blocked' || record['reason'] === 'failed') {
        applyPromptRejected(
          state,
          stringField(record['promptId']),
          record['reason'] === 'blocked',
          time,
        );
      } else {
        state.awaitingContinuationTurnNumber = undefined;
      }
      return;
    case 'prompt.aborted':
      state.awaitingContinuationTurnNumber = undefined;
      return;
    case 'interaction.request':
      applyInteractionRequest(state, record, time);
      return;
    case 'interaction.resolved':
      applyInteractionResolved(state, record);
      return;
    case 'subagent.spawned': {
      const callId = stringField(record['parentToolCallId']);
      const agentId = stringField(record['subagentId']);
      if (callId === undefined || agentId === undefined) return;
      const found = findToolCall(state, callId);
      if (found === undefined) return;
      const ref = agentRefOf(
        agentId,
        numberField(record['swarmIndex']),
        stringField(record['taskId']),
      );
      found.item.agent_refs = [
        ...(found.item.agent_refs ?? []).filter((existing) => existing.agent_id !== agentId),
        ref,
      ];
      return;
    }
    case 'task.started':
    case 'task.terminated_notice': {
      const info = record['info'];
      if (info === null || typeof info !== 'object') return;
      const value = info as Record<string, unknown>;
      const taskId = stringField(value['taskId']);
      const callId = stringField(value['parentToolCallId']) ?? stringField(value['toolCallId']);
      if (taskId === undefined || callId === undefined) return;
      const found = findToolCall(state, callId);
      if (found !== undefined) found.item.task_id = taskId;
      return;
    }
    case 'full_compaction.begin':
      state.compaction = {
        trigger: record['source'] === 'manual' ? 'manual' : 'auto',
        instruction: stringField(record['instruction']),
      };
      return;
    case 'context.apply_compaction':
      applyCompactionSummary(state, record, time);
      return;
    case 'full_compaction.complete': {
      const compaction = state.compaction;
      state.compaction = undefined;
      if (compaction !== undefined) appendCompaction(state, compaction, time);
      return;
    }
    case 'full_compaction.cancel':
      state.compaction = undefined;
      return;
    case 'context.clear':
      Object.assign(state, createConversationState(state.agentId, undefined, state.debug));
      state.openTurnId = undefined;
      state.pendingPrompt = undefined;
      state.latestPromptId = undefined;
      state.awaitingContinuationTurnNumber = undefined;
      state.compaction = undefined;
      state.clock = time;
      return;
  }
}

export function undoConversationTurns(state: ConversationState, count: number): ConversationState {
  if (!Number.isInteger(count) || count <= 0) return state;
  const anchor = state.anchors.at(-count);
  if (anchor === undefined) return state;
  const index = state.turns.findIndex((turn) => turn.turn_id === anchor.turnId);
  if (index === -1) return state;
  state.anchors.splice(state.anchors.length - count);
  if (anchor.itemCount > 0) {
    const turn = state.turns[index]!;
    const steps = state.steps[turn.turn_id] ?? [];
    turn.items.splice(anchor.itemCount);
    steps.splice(anchor.stepCount);
    turn.steps = turn.steps.filter((summary) =>
      steps.some((step) => step.ended && step.index === summary.index),
    );
    turn.usage = totalUsage(turn.steps);
    const modelSteps = state.feedbackAttribution.get(turn.turn_id)?.modelSteps;
    if (modelSteps === undefined) {
      state.feedbackAttribution.delete(turn.turn_id);
    } else {
      const retained = new Set(steps.map((step) => step.index));
      state.feedbackAttribution.set(turn.turn_id, { modelSteps: modelSteps.filter((entry) => retained.has(entry.step)) });
    }
  }
  const removed = new Set(
    state.turns.splice(anchor.itemCount > 0 ? index + 1 : index).map((turn) => turn.turn_id),
  );
  state.nextOrdinal = (state.turns.at(-1)?.ordinal ?? -1) + 1;
  for (const turnId of removed) {
    delete state.steps[turnId];
    state.feedbackAttribution.delete(turnId);
    delete state.implicitlyEnded[turnId];
    delete state.provisionalEnds[turnId];
  }
  reindexTools(state);
  for (const [id, callId] of Object.entries(state.interactions)) {
    if (state.tools[callId] === undefined) delete state.interactions[id];
  }
  const stepIds = new Set(
    Object.values(state.steps)
      .flat()
      .map((step) => step.id),
  );
  for (const id of Object.keys(state.stepParts)) if (!stepIds.has(id)) delete state.stepParts[id];
  if (state.openTurnId !== undefined && removed.has(state.openTurnId)) state.openTurnId = undefined;
  state.pendingPrompt = undefined;
  state.latestPromptId = undefined;
  state.pendingSteers = 0;
  state.trailingRejectedPrompt = false;
  state.awaitingContinuationTurnNumber = undefined;
  return state;
}

export interface RunningWork {
  readonly turnNumber?: number;
}

export function settleOrphanTurns(
  state: ConversationState,
  running: RunningWork = {},
): ConversationState {
  const orphaned = (turn: ConversationTurn): boolean =>
    turn.status === 'running' &&
    (turn.turn_number === undefined || turn.turn_number !== running.turnNumber);
  const staleContinuation =
    state.awaitingContinuationTurnNumber !== undefined &&
    (running.turnNumber === undefined || state.awaitingContinuationTurnNumber !== running.turnNumber);
  if (!state.turns.some(orphaned)) {
    return staleContinuation ? { ...state, awaitingContinuationTurnNumber: undefined } : state;
  }
  const next: ConversationState = {
    ...state,
    turns: [...state.turns],
    tools: { ...state.tools },
    provisionalEnds: { ...state.provisionalEnds },
    awaitingContinuationTurnNumber: staleContinuation ? undefined : state.awaitingContinuationTurnNumber,
  };
  next.turns.forEach((turn, index) => {
    if (!orphaned(turn)) return;
    const settled = structuredClone(turn);
    for (const item of settled.items) {
      const track = item.type === 'tool_call' ? next.tools[item.item_id] : undefined;
      if (track !== undefined) next.tools[item.item_id] = structuredClone(track);
    }
    next.turns[index] = settled;
    endTurn(
      next,
      settled,
      state.recordsTurnEnds ? { outcome: 'interrupted', reason: 'aborted' } : COMPLETED,
      state.clock,
    );
  });
  return next;
}

export function applyMessage(
  state: ConversationState,
  message: ContextMessage | undefined,
  time: number,
): void {
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
    ((pending.promptId !== undefined &&
      message.id !== undefined &&
      pending.promptId !== message.id) ||
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
  if (
    (origin?.kind === 'skill_activation' || origin?.kind === 'plugin_command') &&
    origin.trigger !== 'user-slash'
  )
    return;
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
      state.anchors.push({
        turnId: turn.turn_id,
        itemCount: turn.items.length,
        stepCount: state.steps[turn.turn_id]?.length ?? 0,
      });
    }
    turn.items.push(
      userMessage(message.id ?? nextItemId(turn), 'steer', message.id, message, time),
    );
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
  if (isUndoAnchor(message))
    state.anchors.push({ turnId: turn.turn_id, itemCount: 0, stepCount: 0 });
  if (notification) turn.items.push(...notificationItems(turn, message, time));
  else
    turn.items.push(userMessage(promptId ?? nextItemId(turn), 'opener', promptId, message, time));
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
  const hidden =
    origin?.kind === 'retry' || (origin?.kind === 'system_trigger' && origin.name !== 'subagent');
  const content = hidden
    ? []
    : stripBundledSkillBlocks(message).filter((part) => !isUserPromptSubmitHookPart(part));
  return userMessageItem(id, placement, promptId, origin, content, time);
}

function notificationItems(
  turn: ConversationTurn,
  message: ContextMessage,
  time: number,
): NotificationItem[] {
  const baseId = message.id ?? nextItemId(turn);
  const text = textOf(message.content, '\n');
  const parsed = parseTaskNotifications(text);
  const origin = message.origin as
    | { readonly kind?: string; readonly taskId?: unknown }
    | undefined;
  const notifications =
    parsed.length > 0 || text.trim() === ''
      ? parsed
      : [
          plainTaskNotification(
            origin?.kind ?? 'task',
            stringField(origin?.taskId) ?? '',
            text.trim(),
          ),
        ];
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
    const item = contentItem(
      part,
      nextItemId(turn),
      undefined,
      timing?.startedAt ?? time,
      timing?.durationMs,
    );
    if (item !== undefined) turn.items.push(item);
  }
  for (const call of message.toolCalls ?? []) {
    upsertToolCall(
      state,
      turn,
      toolCallItem(
        call.id,
        call.name,
        undefined,
        time,
        parseArguments(call.arguments),
        message.toolCallDisplays?.[call.id],
      ),
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
  if (found !== undefined)
    finishToolCall(state, found, message.content, message.isError === true, message.note, time);
}

function applyLoopEvent(
  state: ConversationState,
  event: LoopRecordedEvent | undefined,
  time: number,
): void {
  if (event === undefined) return;
  switch (event.type) {
    case 'step.begin': {
      const turn = turnForNumber(state, numberField(event.turnId), time);
      turn.retry = undefined;
      const steps = (state.steps[turn.turn_id] ??= []);
      const index = event.step ?? steps.length + 1;
      const previous = steps.at(-1);
      if (previous?.failed === true && previous.index === index) {
        turn.items = turn.items.filter((item) => !item.item_id.startsWith(`${previous.id}:`));
        reindexTools(state);
      }
      steps.push({ id: event.uuid, index, startedAt: time, ended: false });
      return;
    }
    case 'step.end': {
      delete state.stepParts[event.uuid];
      const found = findStep(state, event.uuid);
      if (found === undefined) return;
      const { turn, step } = found;
      turn.retry = undefined;
      step.ended = true;
      step.failed = event.finishReason === 'error';
      const summary = stepSummary(step.index, step.startedAt, time, step.interruptReason, event);
      turn.steps = [
        ...turn.steps.filter((existing) => existing.index !== step.index),
        summary,
      ].toSorted((a, b) => a.index - b.index);
      turn.usage = totalUsage(turn.steps);
      if (state.debug) {
        const last = turn.items.findLast((item) => item.step_index === step.index);
        if (last !== undefined) last.debug = requestDebug(event);
      }
      return;
    }
    case 'content.part': {
      const turn = turnForNumber(state, numberField(event.turnId), time);
      const position = state.stepParts[event.stepUuid] ?? 0;
      state.stepParts[event.stepUuid] = position + 1;
      const startedAt = event.startedAt ?? findStep(state, event.stepUuid)?.step.startedAt ?? time;
      const item = contentItem(
        event.part,
        `${event.stepUuid}:${event.block ?? position}`,
        event.step,
        startedAt,
        event.durationMs,
      );
      if (item !== undefined) upsertItem(turn, item);
      return;
    }
    case 'tool.call': {
      const turn = turnForNumber(state, numberField(event.turnId), time);
      upsertToolCall(
        state,
        turn,
        toolCallItem(event.toolCallId, event.name, event.step, time, event.args, event.display),
      );
      return;
    }
    case 'tool.result': {
      const found = findToolCall(state, event.toolCallId);
      if (found !== undefined)
        finishToolCall(
          state,
          found,
          event.result.output,
          event.result.isError === true,
          event.result.note,
          time,
        );
      return;
    }
  }
}

function applySteer(state: ConversationState, record: WireRecord): void {
  const messageId = stringField(record['messageId']);
  const promptIds = record['promptIds'];
  if (messageId !== undefined && Array.isArray(promptIds)) {
    for (let index = state.turns.length - 1; index >= 0; index--) {
      const item = state.turns[index]!.items.find((candidate) => candidate.item_id === messageId);
      if (item?.type !== 'user_message') continue;
      item.prompt_ids = promptIdsOf(
        item.origin,
        promptIds.filter((id): id is string => typeof id === 'string'),
      );
      return;
    }
  }
  state.pendingSteers += 1;
}

function applyStepInterrupted(state: ConversationState, record: WireRecord): void {
  const reason = stringField(record['reason']);
  const turn = findTurnByNumber(state, numberField(record['turnId'])) ?? unnumberedOpenTurn(state);
  if (reason === undefined || turn === undefined) return;
  const stepId = stringField(record['stepId']);
  const index = numberField(record['step']);
  const step = state.steps[turn.turn_id]?.findLast((candidate) =>
    stepId === undefined ? candidate.index === index : candidate.id === stepId,
  );
  if (step !== undefined) {
    step.interruptReason = reason;
    const summary = step.ended
      ? turn.steps.find((candidate) => candidate.index === step.index)
      : undefined;
    if (summary !== undefined) summary.outcome = stepOutcome(reason, summary.finish_reason);
  }
  if (turn.status !== 'running') return;
  state.provisionalEnds[turn.turn_id] ??=
    reason === 'error'
      ? { outcome: 'failed', reason: 'error' }
      : { outcome: 'interrupted', reason: 'user_cancelled' };
}

function applyStepRetrying(state: ConversationState, record: WireRecord): void {
  const turn = findTurnByNumber(state, numberField(record['turnId'])) ?? unnumberedOpenTurn(state);
  const attempt = numberField(record['failedAttempt']);
  const nextAttempt = numberField(record['nextAttempt']);
  const maxAttempts = numberField(record['maxAttempts']);
  const delayMs = numberField(record['delayMs']);
  if (
    turn?.status !== 'running' ||
    attempt === undefined ||
    nextAttempt === undefined ||
    maxAttempts === undefined ||
    delayMs === undefined
  )
    return;
  const stepId = stringField(record['stepId']);
  const step = state.steps[turn.turn_id]?.findLast((candidate) =>
    stepId === undefined
      ? candidate.index === numberField(record['step'])
      : candidate.id === stepId,
  );
  if (step !== undefined) {
    turn.items = turn.items.filter((item) => !item.item_id.startsWith(`${step.id}:`));
    reindexTools(state);
  }
  turn.retry = retryStateOf({
    attempt,
    nextAttempt,
    maxAttempts,
    delayMs,
    errorName: stringField(record['errorName']) ?? '',
    errorMessage: stringField(record['errorMessage']) ?? '',
    statusCode: numberField(record['statusCode']),
  });
}

function applyTurnEnded(state: ConversationState, record: WireRecord, time: number): void {
  state.recordsTurnEnds = true;
  if (record['reason'] !== 'failed' && record['reason'] !== 'blocked') {
    state.awaitingContinuationTurnNumber = undefined;
  }
  const turnNumber = numberField(record['turnId']);
  if (turnNumber !== undefined && state.pendingPrompt?.turnNumber === turnNumber)
    state.pendingPrompt = undefined;
  const turn = findTurnByNumber(state, turnNumber) ?? unnumberedOpenTurn(state);
  if (turn === undefined) return;
  if (turn.turn_number === undefined && turnNumber !== undefined) turn.turn_number = turnNumber;
  const requestId = stringField(record['requestId']);
  const replyModel = feedbackReplyModel(record['replyModel']);
  const modelSteps = record['modelSteps'] === undefined ? undefined : modelStepsSchema.safeParse(record['modelSteps']).data;
  if (requestId !== undefined || replyModel !== undefined || modelSteps !== undefined) {
    state.feedbackAttribution.set(turn.turn_id, { requestId, replyModel, modelSteps });
  }
  const error = errorInfoOf(record['error'], requestId);
  endTurn(
    state,
    turn,
    turnEndOf(record['reason'], error, state.provisionalEnds[turn.turn_id]),
    time,
  );
  delete state.implicitlyEnded[turn.turn_id];
  const duration = numberField(record['durationMs']);
  if (duration !== undefined) turn.duration_ms = duration;
}

function feedbackReplyModel(value: unknown): TurnReplyModel | undefined {
  if (typeof value !== 'object' || value === null || !('model' in value) || !('provider' in value)) return undefined;
  const model = stringField(value.model);
  const provider = stringField(value.provider);
  return model === undefined || provider === undefined ? undefined : { model, provider };
}

function applyPromptRejected(
  state: ConversationState,
  promptId: string | undefined,
  blocked: boolean,
  time: number,
): void {
  if (promptId === undefined) return;
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const turn = state.turns[index]!;
    const hasPrompt = turn.items.some(
      (item) =>
        (item.type === 'user_message' &&
          (item.item_id === promptId || item.prompt_ids.includes(promptId))) ||
        (item.type === 'notification' &&
          (item.item_id === promptId || item.item_id.startsWith(`${promptId}:`))),
    );
    if (!hasPrompt) continue;
    if (blocked && turn.items[0]?.type === 'user_message' && turn.items[0].item_id === promptId) {
      endTurn(state, turn, { outcome: 'failed', reason: 'blocked' }, time);
    }
    return;
  }
  if (!blocked && state.awaitingContinuationTurnNumber !== undefined) {
    state.awaitingContinuationTurnNumber = undefined;
    return;
  }
  state.trailingRejectedPrompt = true;
}

function applyInteractionRequest(state: ConversationState, record: WireRecord, time: number): void {
  const toolCallId = stringField(record['toolCallId']);
  const id = stringField(record['id']);
  const kind = record['kind'];
  if (
    toolCallId === undefined ||
    id === undefined ||
    (kind !== 'approval' && kind !== 'question' && kind !== 'user_tool')
  )
    return;
  state.interactions[id] = toolCallId;
  const request = record['request'];
  if (findToolCall(state, toolCallId)?.item.status === 'ended') state.tools[toolCallId] = {};
  const track = (state.tools[toolCallId] ??= {});
  if (kind === 'approval' && findToolCall(state, toolCallId) === undefined) {
    const { toolName, turnId, display } = (request ?? {}) as {
      toolName?: unknown;
      turnId?: unknown;
      display?: unknown;
    };
    const turn = findTurnByNumber(state, numberField(turnId)) ?? openTurn(state);
    if (turn?.status === 'running' && typeof toolName === 'string') {
      upsertToolCall(
        state,
        turn,
        toolCallItem(
          toolCallId,
          toolName,
          state.steps[turn.turn_id]?.at(-1)?.index,
          time,
          undefined,
          display,
        ),
      );
    }
  }
  track.interaction = { id, kind, request, pending: true };
  const found = findToolCall(state, toolCallId);
  if (found !== undefined) refreshTool(state, found.item);
}

function applyInteractionResolved(state: ConversationState, record: WireRecord): void {
  const id = stringField(record['id']);
  if (id === undefined) return;
  const toolCallId = state.interactions[id];
  if (toolCallId === undefined) return;
  delete state.interactions[id];
  const track = state.tools[toolCallId];
  if (track?.interaction === undefined) return;
  track.interaction = { ...track.interaction, pending: false, response: record['response'] };
  const found = findToolCall(state, toolCallId);
  if (found !== undefined) refreshTool(state, found.item);
}

function applyCompactionSummary(state: ConversationState, record: WireRecord, time: number): void {
  const summary = record['summary'];
  const content =
    typeof summary === 'object' && summary !== null
      ? (summary as { content?: unknown }).content
      : undefined;
  const details = {
    summary:
      typeof summary === 'string'
        ? summary
        : Array.isArray(content)
          ? textOf(content as ContentPart[])
          : stringField(record['contextSummary']),
    tokens_before: numberField(record['tokensBefore']),
    tokens_after: numberField(record['tokensAfter']),
    compacted_count: numberField(record['compactedCount']) ?? numberField(record['count']),
  };
  if (state.compaction !== undefined) {
    state.compaction = { ...state.compaction, ...details };
    return;
  }
  const last = state.turns.at(-1);
  const completed = last?.items.at(-1);
  if (
    last !== undefined &&
    completed?.type === 'system' &&
    completed.kind === 'compaction' &&
    completed.summary === undefined
  ) {
    upsertItem(last, { ...completed, ...details });
    return;
  }
  appendCompaction(state, { trigger: 'auto', ...details }, time);
}

function turnForNumber(
  state: ConversationState,
  turnNumber: number | undefined,
  time: number,
): ConversationTurn {
  const open = openTurn(state);
  if (open !== undefined && (turnNumber === undefined || open.turn_number === turnNumber))
    return open;
  const known = findTurnByNumber(state, turnNumber);
  if (
    known !== undefined &&
    (known.status === 'running' || state.implicitlyEnded[known.turn_id] === true)
  ) {
    if (known.status === 'ended') {
      delete state.implicitlyEnded[known.turn_id];
      known.status = 'running';
      known.outcome = undefined;
      known.end_reason = undefined;
      known.error = undefined;
      known.ended_at = undefined;
      known.duration_ms = undefined;
      state.openTurnId = known.turn_id;
    }
    return known;
  }
  if (open !== undefined && open.turn_number === undefined) {
    open.turn_number = turnNumber;
    return open;
  }
  const turn = startTurn(state, time);
  turn.turn_number = turnNumber;
  return turn;
}

function unnumberedOpenTurn(state: ConversationState): ConversationTurn | undefined {
  const open = openTurn(state);
  return open?.turn_number === undefined ? open : undefined;
}

function findTurnByNumber(
  state: ConversationState,
  turnNumber: number | undefined,
): ConversationTurn | undefined {
  return turnNumber === undefined
    ? undefined
    : state.turns.findLast((turn) => turn.turn_number === turnNumber);
}

function findStep(
  state: ConversationState,
  stepId: string,
): { turn: ConversationTurn; step: StepTrack } | undefined {
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const turn = state.turns[index]!;
    const step = state.steps[turn.turn_id]?.findLast((candidate) => candidate.id === stepId);
    if (step !== undefined) return { turn, step };
  }
  return undefined;
}

function reindexTools(state: ConversationState): void {
  const tools: ConversationState['tools'] = {};
  for (const [turnIndex, turn] of state.turns.entries()) {
    for (const [itemIndex, item] of turn.items.entries()) {
      if (item.type !== 'tool_call') continue;
      tools[item.item_id] = {
        ...state.tools[item.item_id],
        turnId: turn.turn_id,
        turnIndex,
        itemIndex,
      };
    }
  }
  state.tools = tools;
}

function upsertItem(turn: ConversationTurn, item: ConversationItem): void {
  const index = turn.items.findIndex((candidate) => candidate.item_id === item.item_id);
  if (index === -1) turn.items.push(item);
  else turn.items[index] = item;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function turnEndOf(
  reason: unknown,
  error: ErrorInfo | undefined,
  provisional: TurnEnd | undefined,
): TurnEnd {
  switch (reason) {
    case 'cancelled':
      return provisional?.outcome === 'interrupted'
        ? provisional
        : { outcome: 'interrupted', reason: 'user_cancelled' };
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

function appendCompaction(
  state: ConversationState,
  compaction: CompactionDetails,
  time: number,
): void {
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
  state.trailingRejectedPrompt = false;
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
  const digest = new Bun.CryptoHasher('sha1')
    .update(`${agentId}\n${ordinal}\n${startedAt}`)
    .digest('hex');
  return `t_${digest.slice(0, 12)}`;
}

export function endTurn(
  state: ConversationState,
  turn: ConversationTurn,
  end: TurnEnd,
  time: number,
): void {
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
  if (
    (item.type === 'assistant_message' || item.type === 'reasoning') &&
    item.status === 'running'
  ) {
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

export function findToolCall(
  state: ConversationState,
  toolCallId: string,
): { turn: ConversationTurn; item: ToolCallItem } | undefined {
  const track = state.tools[toolCallId];
  const turn = track?.turnIndex === undefined ? undefined : state.turns[track.turnIndex];
  const item = track?.itemIndex === undefined ? undefined : turn?.items[track.itemIndex];
  if (
    turn === undefined ||
    turn.turn_id !== track?.turnId ||
    item?.type !== 'tool_call' ||
    item.item_id !== toolCallId
  )
    return undefined;
  return { turn, item };
}

function upsertToolCall(
  state: ConversationState,
  turn: ConversationTurn,
  fresh: ToolCallItem,
): void {
  const found = findToolCall(state, fresh.item_id);
  const previous = found?.turn === turn ? found.item : undefined;
  const oldTrack = state.tools[fresh.item_id];
  const index = previous === undefined ? turn.items.length : oldTrack!.itemIndex!;
  const track = found?.item.status === 'ended' ? {} : (oldTrack ?? {});
  state.tools[fresh.item_id] = track;
  if (isPlanTool(fresh.name)) track.planDisplay = fresh.display ?? track.planDisplay;
  const item: ToolCallItem = {
    ...fresh,
    created_at: previous?.created_at ?? fresh.created_at,
    started_at: previous?.started_at ?? fresh.started_at,
    display: fresh.display ?? previous?.display,
    agent_refs: previous?.agent_refs,
    task_id: previous?.task_id,
  };
  track.turnId = turn.turn_id;
  track.turnIndex = turn.ordinal;
  track.itemIndex = index;
  refreshToolCall(item, track.interaction, track.planDisplay);
  if (previous === undefined) turn.items.push(item);
  else turn.items[index] = item;
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
  endToolCall(
    found.item,
    output,
    !isError ? 'completed' : cancelled ? 'interrupted' : 'failed',
    note,
    time,
  );
  refreshTool(state, found.item);
}

function refreshTool(state: ConversationState, item: ToolCallItem): void {
  const track = state.tools[item.item_id];
  refreshToolCall(item, track?.interaction, track?.planDisplay);
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

