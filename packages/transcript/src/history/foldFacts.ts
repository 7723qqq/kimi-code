import { isUndoAnchorTurnOrigin, isVisibleTurnOrigin, mapTurnOrigin } from '../contract/origin';
import {
  applySubagentRunToTask,
  buildSubagentSpawnTask,
  mapInteractionEndState,
  mapTaskKind,
  mapTurnEndState,
  subagentAgentRef,
  type SubagentRunEventType,
} from '../contract/projections';
import type { AgentRef } from '../model/frame';
import { turnId as exportTurnKey } from '../model/ids';
import type { TranscriptInteraction } from '../model/interaction';
import type { TranscriptItem, TranscriptMarker, TranscriptTaskRef } from '../model/item';
import type { GoalMeta, GoalStatus, TranscriptMeta } from '../model/meta';
import type { TranscriptTask } from '../model/task';
import type { TodoItem, TranscriptTodo } from '../model/todo';
import type { StepUsage, TranscriptStep, TranscriptTurn } from '../model/turn';
import type { AgentTranscriptSnapshot } from '../ops/operation';

export interface HistoryWireRecord {
  readonly type: string;
  readonly time?: number;
  readonly [key: string]: unknown;
}

interface UpdateStorePayload {
  readonly key?: unknown;
  readonly value?: unknown;
}

interface GoalPayload {
  readonly objective?: unknown;
  readonly completionCriterion?: unknown;
  readonly status?: unknown;
  readonly tokensUsed?: unknown;
  readonly budgetLimits?: { readonly tokenBudget?: unknown };
}

interface TaskInfoPayload {
  readonly taskId?: unknown;
  readonly kind?: unknown;
  readonly status?: unknown;
  readonly detached?: unknown;
  readonly description?: unknown;
  readonly agentId?: unknown;
  readonly startedAt?: unknown;
  readonly endedAt?: unknown;
}

interface InteractionRequestPayload {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly toolCallId?: unknown;
  readonly request?: unknown;
}

interface InteractionResolvedPayload {
  readonly id?: unknown;
  readonly response?: unknown;
}

interface PlanRevisionPayload {
  readonly id?: unknown;
  readonly version?: unknown;
  readonly key?: unknown;
  readonly path?: unknown;
  readonly sha256?: unknown;
  readonly bytes?: unknown;
}

interface TurnEndedPayload {
  readonly turnId?: unknown;
  readonly reason?: unknown;
  readonly error?: unknown;
  readonly durationMs?: unknown;
}

interface TurnStepInterruptedPayload {
  readonly turnId?: unknown;
  readonly step?: unknown;
  readonly reason?: unknown;
  readonly message?: unknown;
}

interface TurnPromptPayload {
  readonly origin?: unknown;
  readonly promptId?: unknown;
  readonly turnId?: unknown;
}
interface ContextUndoPayload {
  readonly count?: unknown;
}
interface ContextAppendMessagePayload {
  readonly message?: {
    readonly id?: unknown;
    readonly role?: unknown;
    readonly origin?: unknown;
  };
}
interface TurnCancelPayload {
  readonly turnId?: unknown;
  readonly target?: unknown;
  readonly reason?: unknown;
}

const TASK_STATES = new Set<TranscriptTask['state']>([
  'running',
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);

const GOAL_STATUSES = new Set<GoalStatus>(['active', 'paused', 'blocked', 'complete']);

function readTurnErrorMessage(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

function recordTimeIso(record: HistoryWireRecord): string | undefined {
  const time: unknown = record.time;
  if (typeof time === 'number' && Number.isFinite(time)) return new Date(time).toISOString();
  if (typeof time === 'string') return time;
  return undefined;
}

function readFiniteNumber(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function readStepUsage(raw: unknown): StepUsage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const inputOther = readFiniteNumber(usage['inputOther']);
  const output = readFiniteNumber(usage['output']);
  const inputCacheRead = readFiniteNumber(usage['inputCacheRead']);
  const inputCacheCreation = readFiniteNumber(usage['inputCacheCreation']);
  if (
    inputOther === undefined ||
    output === undefined ||
    inputCacheRead === undefined ||
    inputCacheCreation === undefined
  ) {
    return undefined;
  }
  return { inputOther, output, inputCacheRead, inputCacheCreation };
}

function epochMsToIso(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

function payloadOf(record: HistoryWireRecord): Record<string, unknown> {
  const { type: _type, time: _time, ...payload } = record;
  return payload;
}

function readTodoItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const items: TodoItem[] = [];
  for (const entry of raw) {
    const title = (entry as { title?: unknown } | undefined)?.title;
    const status = (entry as { status?: unknown } | undefined)?.status;
    if (typeof title !== 'string') continue;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'done') continue;
    items.push({ title, status });
  }
  return items;
}

export interface WireRecordFactsProjector {
  syncBase(base: AgentTranscriptSnapshot): void;
  add(record: HistoryWireRecord): void;
  result(base: AgentTranscriptSnapshot): AgentTranscriptSnapshot;
}

export interface WireRecordFactsProjectionOptions {
  readonly agentId?: string;
  readonly resolvePlanRevisionKey?: (key: string) => string;
  readonly activeWireTurnId?: number;
}

export function foldWireRecordFacts(
  records: Iterable<HistoryWireRecord>,
  base: AgentTranscriptSnapshot,
  options?: WireRecordFactsProjectionOptions,
): AgentTranscriptSnapshot {
  const projector = createWireRecordFactsProjector(options);
  projector.syncBase(base);
  for (const record of records) projector.add(record);
  return projector.result(base);
}

export function createWireRecordFactsProjector(
  options?: WireRecordFactsProjectionOptions,
): WireRecordFactsProjector {
  const tasks = new Map<string, TranscriptTask>();
  const interactions = new Map<string, TranscriptInteraction>();
  const endedTurns = new Map<number, HistoryWireRecord>();
  const interruptedSteps = new Map<number, Map<number, HistoryWireRecord>>();
  const turnPromptIds = new Map<number, string>();
  const turnOrigins = new Map<number, unknown>();
  const turnStartedTimes = new Map<number, string>();
  const turnPromptTimes = new Map<number, string>();
  let hasExplicitTurnId = false;
  let nextTurnId = 0;
  const cancelledTurnIds = new Set<number>();
  const hiddenTurnIds = new Set<number>();
  const undoAnchors: { firstRawTurnId: number }[] = [];
  const pendingUndoAnchorTurnIds: number[] = [];
  let undoAnchorFloor = 0;
  const skipCancelledTurnIds = (): void => {
    while (cancelledTurnIds.delete(nextTurnId)) {
      hiddenTurnIds.add(nextTurnId);
      nextTurnId += 1;
    }
  };
  let todo: TranscriptTodo | undefined;
  let goal: GoalMeta | undefined;
  let goalTouched = false;
  let planActive: boolean | undefined;
  let planRevision: { readonly reviewPath?: string; readonly version?: number } | undefined;
  let swarmActive: boolean | undefined;
  let helloWorldActive: boolean | undefined;
  let helloWorldStage: string | undefined;
  let towerActive: boolean | undefined;

  const appended: TranscriptItem[] = [];
  const activeCancelTurnIds = new Set<number>();
  let markerSeq = 0;
  const usedRefIds = new Set<string>();
  const syncBase = (base: AgentTranscriptSnapshot): void => {
    for (const item of base.items) {
      if (item.kind === 'marker') {
        const match = /^m(\d+)$/.exec(item.markerId);
        if (match !== null) markerSeq = Math.max(markerSeq, Number(match[1]));
      } else if (item.kind === 'taskref') {
        usedRefIds.add(item.refId);
      }
    }
  };
  const pushMarker = (marker: string, record: HistoryWireRecord): void => {
    markerSeq += 1;
    const item: TranscriptMarker = {
      kind: 'marker',
      markerId: `m${markerSeq}`,
      marker,
      payload: payloadOf(record),
      at: recordTimeIso(record),
    };
    appended.push(item);
  };

  const subagentTasks = new Map<string, string>();
  const subagentRefs = new Map<string, Map<string, { ref: AgentRef; index?: number }>>();

  const adoptSpawnPlaceholder = (agentId: string, taskId: string): TranscriptTask | undefined => {
    subagentTasks.set(agentId, taskId);
    if (agentId === taskId) return undefined;
    const placeholder = tasks.get(agentId);
    if (placeholder === undefined || placeholder.kind !== 'subagent') return undefined;
    tasks.delete(agentId);
    return placeholder;
  };

  const upsertTask = (record: HistoryWireRecord): void => {
    const info = record['info'] as TaskInfoPayload | undefined;
    if (info === undefined || typeof info.taskId !== 'string') return;
    const taskId = info.taskId;
    const adopted =
      record.type === 'task.started' &&
      info.kind === 'agent' &&
      typeof info.agentId === 'string' &&
      info.agentId.length > 0
        ? adoptSpawnPlaceholder(info.agentId, taskId)
        : undefined;
    const prev = tasks.get(taskId) ?? adopted;
    const status = info.status;
    const task: TranscriptTask = {
      ...prev,
      taskId,
      kind: mapTaskKind(info.kind),
      state:
        typeof status === 'string' && TASK_STATES.has(status as TranscriptTask['state'])
          ? (status as TranscriptTask['state'])
          : (prev?.state ?? 'running'),
      detached: typeof info.detached === 'boolean' ? info.detached : (prev?.detached ?? true),
      description: typeof info.description === 'string' ? info.description : prev?.description,
      agentId: typeof info.agentId === 'string' ? info.agentId : prev?.agentId,
      outputTail:
        typeof record['outputTail'] === 'string' ? record['outputTail'] : (prev?.outputTail ?? ''),
      startedAt: prev?.startedAt ?? epochMsToIso(info.startedAt),
      endedAt: epochMsToIso(info.endedAt) ?? prev?.endedAt,
    };
    tasks.set(taskId, task);
    if (record.type === 'task.started') {
      const refId = `ref-${taskId}`;
      if (!usedRefIds.has(refId)) {
        usedRefIds.add(refId);
        const ref: TranscriptTaskRef = {
          kind: 'taskref',
          refId,
          taskId,
          at: recordTimeIso(record),
        };
        appended.push(ref);
      }
    }
  };

  const add = (record: HistoryWireRecord): void => {
    switch (record.type) {
      case 'subagent.spawned': {
        if (options?.agentId !== undefined && record['parentAgentId'] !== options.agentId) break;
        const agentId = record['subagentId'];
        const toolCallId = record['parentToolCallId'];
        if (typeof agentId !== 'string' || typeof toolCallId !== 'string') break;
        const taskId = typeof record['taskId'] === 'string' ? record['taskId'] : agentId;
        subagentTasks.set(agentId, taskId);
        const index = typeof record['swarmIndex'] === 'number' ? record['swarmIndex'] : undefined;
        const refs = subagentRefs.get(toolCallId) ?? new Map();
        refs.set(agentId, {
          ref: subagentAgentRef(agentId, index),
          index,
        });
        subagentRefs.set(toolCallId, refs);
        tasks.set(
          taskId,
          buildSubagentSpawnTask(
            taskId,
            {
              subagentId: agentId,
              description:
                typeof record['description'] === 'string' ? record['description'] : undefined,
              runInBackground: record['runInBackground'] === true,
              model: typeof record['model'] === 'string' ? record['model'] : undefined,
              thinkingEffort:
                typeof record['thinkingEffort'] === 'string' ? record['thinkingEffort'] : undefined,
            },
            recordTimeIso(record),
          ),
        );
        break;
      }
      case 'subagent.started':
      case 'subagent.completed':
      case 'subagent.failed':
      case 'subagent.cancelled': {
        const agentId = record['subagentId'];
        if (typeof agentId !== 'string') break;
        const taskId = subagentTasks.get(agentId) ?? agentId;
        const at = recordTimeIso(record);
        const patch = {
          resultSummary:
            typeof record['resultSummary'] === 'string' ? record['resultSummary'] : undefined,
          usage: readStepUsage(record['usage']),
          error: typeof record['error'] === 'string' ? record['error'] : undefined,
        };
        const terminalise = (key: string): void => {
          const task = tasks.get(key);
          if (task === undefined) return;
          tasks.set(
            key,
            applySubagentRunToTask(task, record.type as SubagentRunEventType, patch, at),
          );
        };
        terminalise(taskId);
        if (taskId !== agentId) terminalise(agentId);
        break;
      }
      case 'tools.update_store': {
        const payload = record as UpdateStorePayload;
        if (payload.key !== 'todo') break;
        todo = {
          todoId: 'todo',
          items: readTodoItems(payload.value),
          updatedAt: recordTimeIso(record),
        };
        break;
      }
      case 'goal.create': {
        const payload = record as GoalPayload;
        goalTouched = true;
        goal = {
          objective: typeof payload.objective === 'string' ? payload.objective : '',
          status: 'active',
          completionCriterion:
            typeof payload.completionCriterion === 'string'
              ? payload.completionCriterion
              : undefined,
          budgetUsed: 0,
        };
        pushMarker('goal', record);
        break;
      }
      case 'goal.update': {
        const payload = record as GoalPayload;
        goalTouched = true;
        if (goal !== undefined) {
          const tokenBudget = payload.budgetLimits?.tokenBudget;
          goal = {
            ...goal,
            status:
              typeof payload.status === 'string' && GOAL_STATUSES.has(payload.status as GoalStatus)
                ? (payload.status as GoalStatus)
                : goal.status,
            budgetUsed:
              typeof payload.tokensUsed === 'number' ? payload.tokensUsed : goal.budgetUsed,
            budgetLimit: typeof tokenBudget === 'number' ? tokenBudget : goal.budgetLimit,
          };
        }
        pushMarker('goal', record);
        break;
      }
      case 'goal.clear': {
        goalTouched = true;
        goal = undefined;
        break;
      }
      case 'plan_mode.enter': {
        planActive = true;
        planRevision = undefined;
        pushMarker('plan.enter', record);
        break;
      }
      case 'plan_mode.exit':
      case 'plan_mode.cancel': {
        planActive = false;
        planRevision = undefined;
        pushMarker('plan.exit', record);
        break;
      }
      case 'plan.revision': {
        const payload = record as PlanRevisionPayload;
        const path =
          typeof payload.key === 'string'
            ? (options?.resolvePlanRevisionKey?.(payload.key) ?? payload.key)
            : typeof payload.path === 'string'
              ? payload.path
              : undefined;
        planActive = true;
        planRevision = {
          reviewPath: path,
          version: typeof payload.version === 'number' ? payload.version : undefined,
        };
        if (path === undefined) {
          pushMarker('plan.revision', record);
        } else {
          const { key: _key, ...rest } = record;
          pushMarker('plan.revision', { ...rest, path });
        }
        break;
      }
      case 'swarm_mode.enter': {
        if (record['trigger'] !== 'tool') swarmActive = true;
        pushMarker('swarm.enter', record);
        break;
      }
      case 'swarm_mode.exit': {
        swarmActive = false;
        pushMarker('swarm.exit', record);
        break;
      }
      case 'hello_world_mode.enter': {
        helloWorldActive = true;
        helloWorldStage = 'requirements';
        pushMarker('hello-world.enter', record);
        break;
      }
      case 'hello_world_mode.exit': {
        helloWorldActive = false;
        helloWorldStage = undefined;
        pushMarker('hello-world.exit', record);
        break;
      }
      case 'hello_world_run.updated': {
        const stage = record['stage'];
        if (typeof stage !== 'string' || stage === helloWorldStage) break;
        helloWorldStage = stage;
        pushMarker('hello-world.stage', record);
        break;
      }
      case 'tower_mode.enter': {
        towerActive = true;
        break;
      }
      case 'tower_mode.exit': {
        towerActive = false;
        break;
      }
      case 'task.started':
      case 'task.terminated': {
        upsertTask(record);
        break;
      }
      case 'turn.cancel': {
        const payload = record as TurnCancelPayload;
        if (
          payload.target === 'queued' &&
          typeof payload.turnId === 'number' &&
          payload.turnId >= nextTurnId
        ) {
          cancelledTurnIds.add(payload.turnId);
          skipCancelledTurnIds();
          break;
        }
        if (
          payload.target !== 'active' ||
          typeof payload.turnId !== 'number' ||
          !Number.isInteger(payload.turnId) ||
          payload.turnId < 0 ||
          activeCancelTurnIds.has(payload.turnId)
        ) {
          break;
        }
        activeCancelTurnIds.add(payload.turnId);
        if (payload.reason !== 'user_cancelled') break;
        pushMarker('interruption', record);
        break;
      }
      case 'context.undo': {
        const count = (record as ContextUndoPayload).count;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) break;
        let firstUndoneTurnId: number | undefined;
        for (let i = 0; i < count && undoAnchors.length > undoAnchorFloor; i++) {
          const anchor = undoAnchors.pop();
          if (anchor !== undefined) firstUndoneTurnId = anchor.firstRawTurnId;
        }
        if (firstUndoneTurnId !== undefined) {
          for (let turnId = firstUndoneTurnId; turnId < nextTurnId; turnId++) {
            hiddenTurnIds.add(turnId);
          }
        }
        break;
      }
      case 'context.clear':
      case 'context.apply_compaction': {
        undoAnchorFloor = undoAnchors.length;
        break;
      }
      case 'context.append_message': {
        const message = (record as ContextAppendMessagePayload).message;
        if (message?.role !== 'user' || !isUndoAnchorTurnOrigin(message.origin)) break;
        const matchingIndex =
          typeof message.id === 'string'
            ? pendingUndoAnchorTurnIds.findIndex(
                (turnId) => turnPromptIds.get(turnId) === message.id,
              )
            : -1;
        const legacyIndex =
          matchingIndex < 0 && typeof message.id === 'string'
            ? pendingUndoAnchorTurnIds.findIndex((turnId) => !turnPromptIds.has(turnId))
            : -1;
        const matchedTurnId =
          matchingIndex >= 0
            ? pendingUndoAnchorTurnIds.splice(matchingIndex, 1)[0]
            : legacyIndex >= 0
              ? pendingUndoAnchorTurnIds.splice(legacyIndex, 1)[0]
              : typeof message.id !== 'string'
                ? pendingUndoAnchorTurnIds.shift()
                : undefined;
        if (
          matchedTurnId !== undefined &&
          !turnPromptIds.has(matchedTurnId) &&
          typeof message.id === 'string'
        ) {
          turnPromptIds.set(matchedTurnId, message.id);
        }
        undoAnchors.push({ firstRawTurnId: matchedTurnId ?? nextTurnId });
        break;
      }
      case 'interaction.request': {
        const payload = record as InteractionRequestPayload;
        if (payload.kind !== 'approval' && payload.kind !== 'question') break;
        if (typeof payload.id !== 'string') break;
        const requestToolCallId = (payload.request as { toolCallId?: unknown } | undefined)
          ?.toolCallId;
        const toolCallId =
          typeof payload.toolCallId === 'string'
            ? payload.toolCallId
            : typeof requestToolCallId === 'string'
              ? requestToolCallId
              : undefined;
        interactions.set(payload.id, {
          interactionId: payload.id,
          interactionKind: payload.kind,
          toolCallId,
          state: 'pending',
          request: payload.request,
        });
        break;
      }
      case 'interaction.resolved': {
        const payload = record as InteractionResolvedPayload;
        if (typeof payload.id !== 'string') break;
        const entity = interactions.get(payload.id);
        if (entity === undefined) break;
        interactions.set(payload.id, {
          ...entity,
          state: mapInteractionEndState(entity.interactionKind, payload.response),
          response: payload.response,
        });
        break;
      }
      case 'turn.ended': {
        const payload = record as TurnEndedPayload;
        if (typeof payload.turnId === 'number') {
          endedTurns.set(payload.turnId, record);
          const pendingIndex = pendingUndoAnchorTurnIds.indexOf(payload.turnId);
          if (pendingIndex >= 0) pendingUndoAnchorTurnIds.splice(pendingIndex, 1);
        }
        break;
      }
      case 'agent.turn.started': {
        const turnId = record['turnId'];
        const at = recordTimeIso(record);
        if (typeof turnId === 'number' && Number.isInteger(turnId) && at !== undefined) {
          turnStartedTimes.set(turnId, at);
        }
        break;
      }
      case 'turn.step.interrupted': {
        const payload = record as TurnStepInterruptedPayload;
        if (
          typeof payload.turnId !== 'number' ||
          typeof payload.step !== 'number' ||
          typeof payload.reason !== 'string'
        ) {
          break;
        }
        let steps = interruptedSteps.get(payload.turnId);
        if (steps === undefined) {
          steps = new Map();
          interruptedSteps.set(payload.turnId, steps);
        }
        steps.set(payload.step, record);
        break;
      }
      case 'turn.prompt': {
        skipCancelledTurnIds();
        const payload = record as TurnPromptPayload;
        const turnId = typeof payload.turnId === 'number' ? payload.turnId : nextTurnId;
        hasExplicitTurnId ||= typeof payload.turnId === 'number';
        nextTurnId = Math.max(nextTurnId, turnId + 1);
        turnOrigins.set(turnId, payload.origin);
        const promptAt = recordTimeIso(record);
        if (promptAt !== undefined) turnPromptTimes.set(turnId, promptAt);
        if (typeof payload.promptId === 'string') turnPromptIds.set(turnId, payload.promptId);
        if (isUndoAnchorTurnOrigin(payload.origin)) pendingUndoAnchorTurnIds.push(turnId);
        if (!isVisibleTurnOrigin(payload.origin)) hiddenTurnIds.add(turnId);
        break;
      }
      default:
        break;
    }
  };

  const result = (base: AgentTranscriptSnapshot): AgentTranscriptSnapshot => {
    const projectedInteractions = new Map(interactions);
    for (const [id, entity] of projectedInteractions) {
      if (entity.state === 'pending') {
        projectedInteractions.set(id, { ...entity, state: 'cancelled' });
      }
    }

    const baseTurns = base.items.filter((item): item is TranscriptTurn => item.kind === 'turn');
    const ordinalByPromptId = new Map(
      baseTurns.flatMap((turn) =>
        turn.triggerPromptId === undefined ? [] : [[turn.triggerPromptId, turn.ordinal] as const],
      ),
    );
    const claimedOrdinals = new Set<number>();
    const ordinalByRawTurnId = new Map<number, number>();
    const claimBaseOrdinal = (
      predicate: (turn: TranscriptTurn) => boolean = () => true,
    ): number | undefined => {
      const turn = baseTurns.find(
        (candidate) => !claimedOrdinals.has(candidate.ordinal) && predicate(candidate),
      );
      if (turn === undefined) return undefined;
      claimedOrdinals.add(turn.ordinal);
      return turn.ordinal;
    };
    const lastRawTurnId = Math.max(
      nextTurnId - 1,
      ...endedTurns.keys(),
      ...interruptedSteps.keys(),
    );
    const rawTurnIds = Array.from({ length: lastRawTurnId + 1 }, (_, turnId) => turnId).filter(
      (turnId) =>
        !hiddenTurnIds.has(turnId) &&
        (!hasExplicitTurnId ||
          turnOrigins.has(turnId) ||
          endedTurns.has(turnId) ||
          interruptedSteps.has(turnId)),
    );
    for (const turnId of rawTurnIds) {
      const promptId = turnPromptIds.get(turnId);
      const matchedOrdinal = promptId === undefined ? undefined : ordinalByPromptId.get(promptId);
      if (matchedOrdinal !== undefined && !claimedOrdinals.has(matchedOrdinal)) {
        claimedOrdinals.add(matchedOrdinal);
        ordinalByRawTurnId.set(turnId, matchedOrdinal);
      }
    }
    for (const turnId of rawTurnIds) {
      if (ordinalByRawTurnId.has(turnId)) continue;
      const origin = turnOrigins.get(turnId);
      const strictOrigin = turnOrigins.has(turnId) && !isUndoAnchorTurnOrigin(origin);
      if (!strictOrigin) continue;
      const originKind = mapTurnOrigin(origin).kind;
      const fallbackOrdinal = claimBaseOrdinal(
        (candidate) =>
          candidate.triggerPromptId === undefined && candidate.origin.kind === originKind,
      );
      if (fallbackOrdinal !== undefined) ordinalByRawTurnId.set(turnId, fallbackOrdinal);
    }
    for (const turnId of rawTurnIds) {
      if (ordinalByRawTurnId.has(turnId)) continue;
      const promptId = turnPromptIds.get(turnId);
      const origin = turnOrigins.get(turnId);
      const strictOrigin = turnOrigins.has(turnId) && !isUndoAnchorTurnOrigin(origin);
      if (promptId === undefined || strictOrigin) continue;
      const emptyPromptOrdinal = claimBaseOrdinal(
        (candidate) => candidate.triggerPromptId === undefined && candidate.origin.kind === 'other',
      );
      if (emptyPromptOrdinal !== undefined) {
        ordinalByRawTurnId.set(turnId, emptyPromptOrdinal);
      }
    }
    for (const turnId of rawTurnIds) {
      if (ordinalByRawTurnId.has(turnId)) continue;
      const promptId = turnPromptIds.get(turnId);
      const origin = turnOrigins.get(turnId);
      const strictOrigin = turnOrigins.has(turnId) && !isUndoAnchorTurnOrigin(origin);
      if (promptId !== undefined || strictOrigin) continue;
      const fallbackOrdinal = claimBaseOrdinal();
      if (fallbackOrdinal !== undefined) ordinalByRawTurnId.set(turnId, fallbackOrdinal);
    }

    const endedByOrdinal = new Map<number, HistoryWireRecord>();
    for (const [turnId, record] of endedTurns) {
      const ordinal = ordinalByRawTurnId.get(turnId);
      if (ordinal !== undefined) endedByOrdinal.set(ordinal, record);
    }

    const interruptedByOrdinal = new Map<number, Map<number, HistoryWireRecord>>();
    for (const [turnId, steps] of interruptedSteps) {
      const ordinal = ordinalByRawTurnId.get(turnId);
      if (ordinal !== undefined) interruptedByOrdinal.set(ordinal, steps);
    }

    const items =
      endedByOrdinal.size > 0 || interruptedByOrdinal.size > 0
        ? base.items.map((item) => {
            if (item.kind !== 'turn') return item;
            const record = endedByOrdinal.get(item.ordinal);
            const interrupted = interruptedByOrdinal.get(item.ordinal);
            if (record === undefined && interrupted === undefined) return item;
            const steps = ((): TranscriptTurn['steps'] => {
              if (interrupted === undefined) return item.steps;
              const hitOrdinals = new Set<number>();
              const patched = item.steps.map((step) => {
                const hit = interrupted.get(step.ordinal);
                if (hit === undefined) return step;
                const stepPayload = hit as TurnStepInterruptedPayload;
                if (typeof stepPayload.reason !== 'string') return step;
                hitOrdinals.add(step.ordinal);
                return {
                  ...step,
                  state: 'interrupted' as const,
                  endedAt: recordTimeIso(hit) ?? step.endedAt,
                  endReason: stepPayload.reason,
                  endMessage:
                    typeof stepPayload.message === 'string' ? stepPayload.message : undefined,
                };
              });
              for (const [stepOrdinal, hit] of interrupted) {
                if (hitOrdinals.has(stepOrdinal)) continue;
                const stepPayload = hit as TurnStepInterruptedPayload;
                if (typeof stepPayload.reason !== 'string') continue;
                patched.push({
                  kind: 'step',
                  stepId: `${item.turnId}.${stepOrdinal}`,
                  turnId: item.turnId,
                  ordinal: stepOrdinal,
                  state: 'interrupted',
                  frames: [],
                  endedAt: recordTimeIso(hit),
                  endReason: stepPayload.reason,
                  endMessage:
                    typeof stepPayload.message === 'string' ? stepPayload.message : undefined,
                });
              }
              return patched.toSorted((a, b) => a.ordinal - b.ordinal);
            })();
            if (record === undefined) return { ...item, steps };
            const payload = record as TurnEndedPayload;
            return {
              ...item,
              steps,
              state: mapTurnEndState(payload.reason) ?? item.state,
              endedAt: recordTimeIso(record) ?? item.endedAt,
              durationMs:
                typeof payload.durationMs === 'number' ? payload.durationMs : item.durationMs,
              error: readTurnErrorMessage(payload.error) ?? item.error,
            };
          })
        : base.items;

    const wireIdByOrdinal = new Map<number, number>();
    if (hasExplicitTurnId) {
      for (const [rawTurnId, ordinal] of ordinalByRawTurnId) {
        wireIdByOrdinal.set(ordinal, rawTurnId);
      }
    }
    const wedgedTurnIds = new Set<number>();
    if (wireIdByOrdinal.size > 0) {
      let latestPromptTurnId: number | undefined;
      for (const rawTurnId of turnOrigins.keys()) {
        if (latestPromptTurnId === undefined || rawTurnId > latestPromptTurnId) {
          latestPromptTurnId = rawTurnId;
        }
      }
      for (const rawTurnId of turnOrigins.keys()) {
        if (endedTurns.has(rawTurnId) || activeCancelTurnIds.has(rawTurnId)) continue;
        if (rawTurnId === latestPromptTurnId && options?.activeWireTurnId === rawTurnId) continue;
        wedgedTurnIds.add(rawTurnId);
      }
    }
    const realignedItems =
      wireIdByOrdinal.size === 0
        ? items
        : (() => {
            const keptOrdinals = new Set<number>();
            for (const item of items) {
              if (item.kind === 'turn' && !wireIdByOrdinal.has(item.ordinal)) {
                keptOrdinals.add(item.ordinal);
              }
            }
            return items.map((item) => {
              if (item.kind !== 'turn') return item;
              const wireId = wireIdByOrdinal.get(item.ordinal);
              if (wireId === undefined) return item;
              const renumber = wireId !== item.ordinal && !keptOrdinals.has(wireId);
              const nextTurnId = renumber ? exportTurnKey(wireId) : item.turnId;
              const wedged = wedgedTurnIds.has(wireId);
              return {
                ...item,
                turnId: nextTurnId,
                ordinal: renumber ? wireId : item.ordinal,
                startedAt:
                  item.startedAt ?? turnStartedTimes.get(wireId) ?? turnPromptTimes.get(wireId),
                state: wedged ? 'failed' : item.state,
                wedged: wedged ? true : item.wedged,
                steps: renumber
                  ? item.steps.map((step) => renameTurnStep(step, item.turnId, nextTurnId))
                  : item.steps,
              };
            });
          })();

    const modesTouched =
      planActive !== undefined ||
      swarmActive !== undefined ||
      helloWorldActive !== undefined ||
      helloWorldStage !== undefined ||
      towerActive !== undefined;
    const meta: TranscriptMeta = {
      ...base.meta,
      goal: goalTouched ? goal : base.meta.goal,
      modes: modesTouched
        ? {
            ...base.meta.modes,
            plan:
              planActive === undefined
                ? base.meta.modes?.plan
                : planActive
                  ? (planRevision ?? {})
                  : undefined,
            swarm:
              swarmActive === undefined ? base.meta.modes?.swarm : swarmActive ? {} : undefined,
            'hello-world':
              helloWorldActive === false
                ? undefined
                : helloWorldActive === undefined && helloWorldStage === undefined
                  ? base.meta.modes?.['hello-world']
                  : {
                      trigger: base.meta.modes?.['hello-world']?.trigger,
                      stage: helloWorldStage,
                    },
            tower:
              towerActive === undefined ? base.meta.modes?.tower : towerActive ? {} : undefined,
          }
        : base.meta.modes,
    };

    let restoredItems = appended.length > 0 ? [...realignedItems, ...appended] : realignedItems;
    if (subagentRefs.size > 0) {
      restoredItems = restoredItems.map((item) => {
        if (item.kind !== 'turn') return item;
        return {
          ...item,
          steps: item.steps.map((step) => ({
            ...step,
            frames: step.frames.map((frame) => {
              if (frame.kind !== 'tool') return frame;
              const refs = subagentRefs.get(frame.toolCallId);
              if (refs === undefined) return frame;
              return {
                ...frame,
                agentRefs: [...refs.values()]
                  .toSorted((a, b) => (a.index ?? 0) - (b.index ?? 0))
                  .map(({ ref }) => ref),
              };
            }),
          })),
        };
      });
    }

    return {
      ...base,
      items: restoredItems,
      tasks: [...tasks.values()],
      interactions: [...projectedInteractions.values()],
      todos: todo !== undefined ? [todo] : base.todos,
      meta,
    };
  };

  return { syncBase, add, result };
}

function renameTurnStep(
  step: TranscriptStep,
  fromTurnId: string,
  toTurnId: string,
): TranscriptStep {
  const stepId = step.stepId.startsWith(`${fromTurnId}.`)
    ? `${toTurnId}.${step.stepId.slice(fromTurnId.length + 1)}`
    : step.stepId;
  return {
    ...step,
    stepId,
    turnId: toTurnId,
    frames: step.frames.map((frame) => ({
      ...frame,
      frameId: frame.frameId.startsWith(`${step.stepId}.`)
        ? `${stepId}.${frame.frameId.slice(step.stepId.length + 1)}`
        : frame.frameId,
    })),
  };
}
