import type { AgentRef } from '../model/frame';
import type { InteractionKind, InteractionState } from '../model/interaction';
import type { TaskState, TranscriptTask } from '../model/task';
import type { StepUsage, TurnState } from '../model/turn';

export function mapTurnEndState(reason: 'completed' | 'cancelled' | 'failed' | 'blocked'): TurnState;
export function mapTurnEndState(reason: unknown): TurnState | undefined;
export function mapTurnEndState(reason: unknown): TurnState | undefined {
  switch (reason) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'blocked':
      return 'failed';
    default:
      return undefined;
  }
}

export function mapTaskKind(kind: unknown): TranscriptTask['kind'] {
  switch (kind) {
    case 'process':
      return 'shell';
    case 'agent':
      return 'subagent';
    default:
      return 'other';
  }
}

export function mapInteractionEndState(
  kind: InteractionKind,
  response: unknown,
): InteractionState {
  if (kind === 'question') return response === null ? 'dismissed' : 'answered';
  const decision = (response as { decision?: unknown } | null | undefined)?.decision;
  if (decision === 'approved' || decision === 'rejected' || decision === 'cancelled') {
    return decision;
  }
  return 'cancelled';
}

export type SubagentRunEventType =
  | 'subagent.started'
  | 'subagent.completed'
  | 'subagent.failed'
  | 'subagent.cancelled'
  | 'subagent.suspended';

export function subagentRunTaskState(type: SubagentRunEventType): TaskState {
  switch (type) {
    case 'subagent.completed':
      return 'completed';
    case 'subagent.failed':
      return 'failed';
    case 'subagent.cancelled':
      return 'killed';
    case 'subagent.started':
    case 'subagent.suspended':
      return 'running';
  }
}

export interface SubagentRunPatch {
  readonly resultSummary?: string;
  readonly usage?: StepUsage;
  readonly error?: string;
  readonly reason?: string;
}

export function applySubagentRunToTask(
  prev: TranscriptTask,
  type: SubagentRunEventType,
  patch: SubagentRunPatch,
  at: string | undefined,
): TranscriptTask {
  const state = subagentRunTaskState(type);
  return {
    ...prev,
    state,
    endedAt: state === 'running' ? undefined : at,
    resultSummary: patch.resultSummary ?? prev.resultSummary,
    usage: patch.usage ?? prev.usage,
    error: patch.error ?? prev.error,
    stateReason: patch.reason ?? prev.stateReason,
  };
}

export interface SubagentSpawnFields {
  readonly subagentId: string;
  readonly description?: string;
  readonly runInBackground: boolean;
  readonly model?: string;
  readonly thinkingEffort?: string;
}

export function buildSubagentSpawnTask(
  taskId: string,
  fields: SubagentSpawnFields,
  at: string | undefined,
): TranscriptTask {
  return {
    taskId,
    kind: 'subagent',
    state: 'running',
    detached: fields.runInBackground,
    description: fields.description,
    agentId: fields.subagentId,
    outputTail: '',
    startedAt: at,
    model: fields.model,
    thinkingEffort: fields.thinkingEffort,
  };
}

export function subagentAgentRef(subagentId: string, swarmIndex: number | undefined): AgentRef {
  return { agentId: subagentId, role: swarmIndex === undefined ? 'child' : 'member' };
}
