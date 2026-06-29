import { join } from 'pathe';

import {
  BackgroundTaskPersistence,
  type BackgroundTaskInfo,
  type IBackgroundService,
} from '#/background';
import { AtomicDocumentStore, FileStorageService } from '#/storage';

export type BackgroundServiceTestManager = IBackgroundService & {
  loadFromDisk(): Promise<void>;
  reconcile(): Promise<readonly BackgroundTaskInfo[]>;
};

export function createBackgroundTaskPersistence(homedir: string): BackgroundTaskPersistence {
  const sessionScope = 'sessions/test-workspace/test-session';
  const storage = new FileStorageService(homedir);
  return new BackgroundTaskPersistence(
    join(homedir, sessionScope),
    sessionScope,
    new AtomicDocumentStore(storage),
    storage,
  );
}
