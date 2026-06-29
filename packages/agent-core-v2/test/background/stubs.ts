import type {
  BackgroundTaskInfo,
  IBackgroundService,
} from '#/background';

export type BackgroundServiceTestManager = IBackgroundService & {
  loadFromDisk(): Promise<void>;
  reconcile(): Promise<readonly BackgroundTaskInfo[]>;
};
