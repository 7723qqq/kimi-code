/**
 * `TaskServiceImpl` — adapter between protocol-shaped REST surface and
 * agent-core's `getBackground` + `stopBackground` (Chain 8 / P1.8, W9.2).
 *
 * Wraps `IHarnessBridge.rpc.{getBackground, stopBackground}` and adapts
 * `BackgroundTaskInfo` shapes via `task-adapter.toProtocolTask`.
 *
 * **CoreAPI surface — agent-scoped**: both `getBackground` and `stopBackground`
 * live on the `AgentAPI` (which the SessionAPI proxy decorates with
 * `WithSessionId<WithAgentId<...>>`). We dispatch against agent id `'main'`,
 * matching the convention used by `MessageServiceImpl.getContext`.
 *
 * **Error mapping**:
 *   - `TaskNotFoundError`        — when the task id is absent from the
 *     session's background-task list.
 *   - `TaskAlreadyFinishedError` — when the task is in a wire-terminal
 *     status (`completed|failed|cancelled`).
 *
 * `cancel` performs a pre-check via `getBackground` so it can emit the
 * idempotent 40904 envelope before invoking `stopBackground`. This guards
 * against agent-core's `stopBackground` being a fire-and-forget no-op for
 * already-finished tasks (no thrown error → we'd return a fake `cancelled:true`).
 *
 * **Anti-corruption**: imports `@moonshot-ai/agent-core` only for the
 * `Disposable` base type.
 */

import { Disposable } from '@moonshot-ai/agent-core';
import type { BackgroundTask } from '@moonshot-ai/protocol';

import { IHarnessBridge } from '../bridge/harness-bridge';
import {
  ITaskService,
  TaskAlreadyFinishedError,
  TaskNotFoundError,
  type TaskListQuery,
} from '../interfaces/task-service';
import { SessionNotFoundError } from '../interfaces/session-service';
import { isTerminalStatus, toProtocolTask } from '../adapter/task-adapter';

const MAIN_AGENT_ID = 'main';

export class TaskServiceImpl extends Disposable implements ITaskService {
  constructor(@IHarnessBridge private readonly bridge: IHarnessBridge) {
    super();
  }

  async list(sessionId: string, query: TaskListQuery): Promise<readonly BackgroundTask[]> {
    await this._requireSession(sessionId);
    const raw = await this._getAllRaw(sessionId);
    const all = raw.map((info) => toProtocolTask(sessionId, info));
    if (query.status !== undefined) {
      return all.filter((t) => t.status === query.status);
    }
    return all;
  }

  async get(sessionId: string, taskId: string): Promise<BackgroundTask> {
    await this._requireSession(sessionId);
    const raw = await this._getAllRaw(sessionId);
    const found = raw.find((t) => t.taskId === taskId);
    if (found === undefined) {
      throw new TaskNotFoundError(sessionId, taskId);
    }
    return toProtocolTask(sessionId, found);
  }

  async cancel(sessionId: string, taskId: string): Promise<{ cancelled: true }> {
    await this._requireSession(sessionId);
    // Pre-fetch so we can distinguish the 40406 (not found) and 40904 (already
    // finished) cases deterministically — agent-core's `stopBackground` is a
    // fire-and-forget call that doesn't surface this.
    const raw = await this._getAllRaw(sessionId);
    const found = raw.find((t) => t.taskId === taskId);
    if (found === undefined) {
      throw new TaskNotFoundError(sessionId, taskId);
    }
    const wireStatus = toProtocolTask(sessionId, found).status;
    if (isTerminalStatus(wireStatus)) {
      throw new TaskAlreadyFinishedError(sessionId, taskId, wireStatus);
    }
    await this.bridge.rpc.stopBackground({
      sessionId,
      agentId: MAIN_AGENT_ID,
      taskId,
    });
    return { cancelled: true };
  }

  // --- internals ------------------------------------------------------------

  private async _requireSession(sessionId: string): Promise<void> {
    const all = await this.bridge.rpc.listSessions({});
    if (!all.some((s) => s.id === sessionId)) {
      throw new SessionNotFoundError(sessionId);
    }
  }

  private async _getAllRaw(
    sessionId: string,
  ): Promise<ReadonlyArray<Awaited<ReturnType<typeof this.bridge.rpc.getBackground>>[number]>> {
    try {
      return await this.bridge.rpc.getBackground({
        sessionId,
        agentId: MAIN_AGENT_ID,
      });
    } catch {
      // Session not loaded; treat as empty.
      return [];
    }
  }
}

void ITaskService;
