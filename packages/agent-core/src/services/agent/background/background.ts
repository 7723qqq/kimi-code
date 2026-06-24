import { createDecorator } from '../../../di';
import { BackgroundTaskPersistence } from '../../../agent/background/persist';
import type {
  BackgroundTask,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
} from '../../../agent/background/task';

export { AgentBackgroundTask } from '../../../agent/background/agent-task';
export type { AgentBackgroundTaskInfo } from '../../../agent/background/agent-task';
export { ProcessBackgroundTask } from '../../../agent/background/process-task';
export type { ProcessBackgroundTaskInfo } from '../../../agent/background/process-task';
export { QuestionBackgroundTask } from '../../../agent/background/question-task';
export type { QuestionBackgroundTaskInfo } from '../../../agent/background/question-task';
export { BackgroundTaskPersistence } from '../../../agent/background/persist';
export type {
  BackgroundTask,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
} from '../../../agent/background/task';

export interface BackgroundServiceOptions {
  readonly persistence?: BackgroundTaskPersistence;
  readonly maxRunningTasks?: number;
}

export type BackgroundOptions = BackgroundServiceOptions;

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

declare module '../types' {
  interface WireRecordMap {
    'background.task.started': {
      info: BackgroundTaskInfo;
    };
    'background.task.terminated': {
      info: BackgroundTaskInfo;
    };
  }
}

export interface BackgroundManager {
  registerTask(task: BackgroundTask): string;
  getTask(taskId: string): BackgroundTaskInfo | undefined;
  list(activeOnly?: boolean, limit?: number): readonly BackgroundTaskInfo[];
  loadFromDisk(options?: BackgroundLoadOptions): Promise<void>;
  reconcile(): Promise<readonly BackgroundTaskInfo[]>;
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
}

export interface IBackgroundService extends BackgroundManager {
  readonly _serviceBrand: undefined;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IBackgroundService =
  createDecorator<IBackgroundService>('agentBackgroundService');
