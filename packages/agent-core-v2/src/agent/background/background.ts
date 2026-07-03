import { createDecorator } from "#/_base/di";
import type { ITaskHandle } from '#/app/task';
import type { Hooks } from '#/hooks';
import type {
  BackgroundTask,
  BackgroundTaskInfo,
  BackgroundTaskInfoBase,
  BackgroundTaskStatus,
} from './task';

export { AgentBackgroundTask } from './agent-task';
export { createAgentExecutor } from './agent-task';
export type { AgentBackgroundTaskInfo, AgentTaskHandle } from './agent-task';
export { ProcessBackgroundTask, createProcessExecutor, ProcessExitError } from './process-task';
export type { ProcessBackgroundTaskInfo, ProcessTaskResult } from './process-task';
export { QuestionBackgroundTask, createQuestionExecutor, QuestionTaskError } from './question-task';
export type { QuestionBackgroundTaskInfo } from './question-task';
export { BackgroundTaskPersistence } from './persist';
export type {
  BackgroundTask,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
} from './task';

export interface BackgroundLoadOptions {
  readonly replace?: boolean;
}

export interface BackgroundTaskOutputSnapshot {
  readonly outputPath?: string;
  readonly outputSizeBytes: number;
  readonly previewBytes: number;
  readonly truncated: boolean;
  readonly fullOutputAvailable: boolean;
  readonly preview: string;
}

export interface RegisterBackgroundTaskOptions {
  /**
   * When false, the task is tracked by the manager while a foreground tool call
   * still waits for it. It can later be detached through RPC.
   */
  readonly detached?: boolean;
  /** Deadline owned by the background manager. `0` and `undefined` do not arm a timer. */
  readonly timeoutMs?: number;
  /** Deadline to apply if a foreground task is detached. `0` and `undefined` do not arm a timer. */
  readonly detachTimeoutMs?: number;
  /** Foreground caller signal. Ignored for tasks created already detached. */
  readonly signal?: AbortSignal;
}

export type ForegroundTaskReleaseReason = 'detached' | 'terminal';

/**
 * Options for tracking a TaskHandle with the BackgroundService.
 * Callers create the handle via `taskService.run()`, then pass it here.
 */
export interface BackgroundTrackOptions {
  readonly idPrefix?: string;
  readonly description: string;
  /** If `true`, the task is immediately detached (background). Default: `true`. */
  readonly detached?: boolean;
  /** Deadline after which the handle is cancelled. */
  readonly timeoutMs?: number;
  /** Deadline to apply if a foreground task is detached. */
  readonly detachTimeoutMs?: number;
  /** Foreground caller signal (ignored for detached tasks). */
  readonly signal?: AbortSignal;
  /** Callback to force-stop the underlying work (e.g., SIGKILL). */
  readonly forceStop?: () => Promise<void>;
  /** Hook called when a foreground task is detached. */
  readonly onDetach?: () => void;
  /** Produce the typed `BackgroundTaskInfo` from the base fields. */
  readonly toInfo: (base: BackgroundTaskInfoBase) => BackgroundTaskInfo;
}

/** Returned by `track()` so callers can race `handle.result` against detach. */
export interface IBackgroundEntry {
  readonly taskId: string;
  /** Resolves with `'detached'` when the RPC layer detaches this task. */
  readonly onDidDetach: Promise<ForegroundTaskReleaseReason>;
}

export interface BackgroundNotificationContext {
  readonly notificationType: string;
  readonly title: string;
  readonly body: string;
  readonly severity: 'info' | 'warning';
  readonly sourceKind: string;
  readonly sourceId: string;
}

export interface IAgentBackgroundService {
  readonly _serviceBrand: undefined;

  readonly hooks: Hooks<{
    onDidNotify: BackgroundNotificationContext;
  }>;

  /** Track a `ITaskHandle` (from `taskService.run()`). */
  track(handle: ITaskHandle, options: BackgroundTrackOptions): IBackgroundEntry;

  /** @deprecated Use `taskService.run()` + `track()` instead. */
  registerTask(task: BackgroundTask, options?: RegisterBackgroundTaskOptions): string;

  getTask(taskId: string): BackgroundTaskInfo | undefined;
  list(activeOnly?: boolean, limit?: number): readonly BackgroundTaskInfo[];
  persistOutput(taskId: string): void;
  getOutputSnapshot(
    taskId: string,
    maxPreviewBytes: number,
  ): Promise<BackgroundTaskOutputSnapshot>;
  readOutput(taskId: string, tail?: number): Promise<string>;
  suppressTerminalNotification(taskId: string): Promise<void>;
  detach(taskId: string): BackgroundTaskInfo | undefined;
  stop(taskId: string, reason?: string): Promise<BackgroundTaskInfo | undefined>;
  stopAll(reason?: string): Promise<readonly BackgroundTaskInfo[]>;
  wait(taskId: string, timeoutMs?: number): Promise<BackgroundTaskInfo | undefined>;
  waitForForegroundRelease(
    taskId: string,
  ): Promise<ForegroundTaskReleaseReason | undefined>;
}

export const IAgentBackgroundService =
  createDecorator<IAgentBackgroundService>('agentBackgroundService');
