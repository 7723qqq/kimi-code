/**
 * Wire → model narrowing for transcript values decoded with the package schemas.
 *
 * The package schema is deliberately wider than the transcript model in one
 * spot: `goalMetaSchema` accepts the goal domain's `budget_limited` and
 * `usage_limited` statuses, while the model's `GoalStatus` carries only the
 * four statuses that can reach the transcript channel — kap-server folds both
 * budget statuses into `paused` before projecting a goal into transcript ops
 * (`onGoalUpdated` in coreEventMap). No transcript snapshot or op on the wire
 * therefore carries them. Values that crossed the schema boundary are narrowed
 * back here, mirroring the server's projection, before the app stores them in
 * model-typed structures.
 */

import {
  type agentTranscriptSnapshotSchema,
  type transcriptMetaMergeSchema,
  type transcriptMetaSchema,
  type transcriptOperationSchema,
  type AgentTranscriptSnapshot,
  type GoalMeta,
  type GoalStatus,
  type TranscriptMeta,
  type TranscriptMetaMerge,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';

/** Output type of a package schema's `safeParse`. */
type ParsedData<T> = Extract<T, { success: true }> extends { data: infer D } ? D : never;

type WireMeta = ParsedData<ReturnType<typeof transcriptMetaSchema.safeParse>>;
type WireMetaMerge = ParsedData<ReturnType<typeof transcriptMetaMergeSchema.safeParse>>;
type WireSnapshot = ParsedData<ReturnType<typeof agentTranscriptSnapshotSchema.safeParse>>;
type WireOperation = ParsedData<ReturnType<typeof transcriptOperationSchema.safeParse>>;
type WireGoalStatus = NonNullable<WireMeta['goal']>['status'];

/** Project a wire goal status onto the transcript model's status set. */
function narrowGoalStatus(status: WireGoalStatus): GoalStatus {
  switch (status) {
    case 'active':
    case 'paused':
    case 'blocked':
    case 'complete':
      return status;
    case 'budget_limited':
    case 'usage_limited':
      // The server's own projection of these two goal-domain statuses.
      return 'paused';
  }
}

function narrowGoal(goal: NonNullable<WireMeta['goal']>): GoalMeta {
  return { ...goal, status: narrowGoalStatus(goal.status) };
}

/** Narrow a parsed transcript meta to the model type. */
export function toModelMeta(meta: WireMeta): TranscriptMeta {
  const { goal, ...rest } = meta;
  return goal === undefined ? rest : { ...rest, goal: narrowGoal(goal) };
}

/** Narrow a parsed `meta.merge` payload (`goal: null` clears the goal). */
export function toModelMetaMerge(meta: WireMetaMerge): TranscriptMetaMerge {
  const { goal, ...rest } = meta;
  if (goal === undefined) return rest;
  return { ...rest, goal: goal === null ? null : narrowGoal(goal) };
}

/** Narrow a parsed reset snapshot to the model type. */
export function toModelSnapshot(snapshot: WireSnapshot): AgentTranscriptSnapshot {
  return { ...snapshot, meta: toModelMeta(snapshot.meta) };
}

/** Narrow one parsed transcript op; only `reset` and `meta.merge` carry meta. */
export function toModelOperation(op: WireOperation): TranscriptOperation {
  switch (op.op) {
    case 'reset':
      return { ...op, snapshot: toModelSnapshot(op.snapshot) };
    case 'meta.merge':
      return { ...op, meta: toModelMetaMerge(op.meta) };
    default:
      // Every other op variant is shaped exactly like its model counterpart.
      return op;
  }
}
