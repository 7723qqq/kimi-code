/**
 * `ITaskService` — daemon-facing background task surface (Chain 8 / P1.8, W9.2).
 *
 * Wraps `IHarnessBridge.rpc.{getBackground, stopBackground}` and adapts
 * `BackgroundTaskInfo` (camelCase + ms timestamps + agent-core literal sets)
 * into SCHEMAS §7 `BackgroundTask` (snake_case + ISO + spec literal sets).
 *
 * **CoreAPI surface used**:
 *   - `bridge.rpc.getBackground({sessionId, agentId, activeOnly?, limit?})
 *      => readonly BackgroundTaskInfo[]`
 *     (packages/agent-core/src/rpc/core-api.ts:334 + WithSessionId+WithAgentId
 *      injection).
 *   - `bridge.rpc.stopBackground({sessionId, agentId, taskId, reason?})`
 *     (line 323).
 *
 * **Error model**:
 *   - `TaskNotFoundError` (→ 40406) when the task id does not exist within
 *     the session.
 *   - `TaskAlreadyFinishedError` (→ 40904) when the task has reached a
 *     terminal status (completed/failed/cancelled/timed_out/killed/lost).
 *
 * **Anti-corruption**: imports `@moonshot-ai/agent-core` only for the
 * `createDecorator` value used to mint the service identifier.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type { BackgroundTask, BackgroundTaskStatus } from '@moonshot-ai/protocol';

export interface TaskListQuery {
  readonly status?: BackgroundTaskStatus;
}

export interface ITaskService {
  /** Return the (full) list of background tasks for the session. */
  list(sessionId: string, query: TaskListQuery): Promise<readonly BackgroundTask[]>;

  /**
   * Return a single background task. Throws `TaskNotFoundError` (→ 40406)
   * when the task id is not found.
   */
  get(sessionId: string, taskId: string): Promise<BackgroundTask>;

  /**
   * Cancel a running task. Throws:
   *   - `TaskNotFoundError`        → 40406
   *   - `TaskAlreadyFinishedError` → 40904 (daemon emits custom envelope
   *      with `data:{cancelled:false}`)
   */
  cancel(sessionId: string, taskId: string): Promise<{ cancelled: true }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ITaskService = createDecorator<ITaskService>('ITaskService');

/**
 * Sentinel — daemon route maps to `code: 40406 task.not_found`.
 */
export class TaskNotFoundError extends Error {
  readonly sessionId: string;
  readonly taskId: string;
  constructor(sessionId: string, taskId: string) {
    super(`task ${taskId} does not exist in session ${sessionId}`);
    this.name = 'TaskNotFoundError';
    this.sessionId = sessionId;
    this.taskId = taskId;
  }
}

/**
 * Sentinel — daemon route maps to `code: 40904 task.already_finished`. The
 * envelope's `data` shape is `{ cancelled: false }` (REST.md §3.7 idempotent
 * shape mirroring 40903 + 40902 precedent).
 */
export class TaskAlreadyFinishedError extends Error {
  readonly sessionId: string;
  readonly taskId: string;
  readonly currentStatus: BackgroundTaskStatus;
  constructor(sessionId: string, taskId: string, currentStatus: BackgroundTaskStatus) {
    super(`task ${taskId} already finished (status: ${currentStatus})`);
    this.name = 'TaskAlreadyFinishedError';
    this.sessionId = sessionId;
    this.taskId = taskId;
    this.currentStatus = currentStatus;
  }
}
