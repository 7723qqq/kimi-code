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

export const BACKGROUND_TEST_SESSION_SCOPE = 'sessions/test-workspace/test-session';

export function createBackgroundTaskPersistence(homedir: string): BackgroundTaskPersistence {
  const storage = new FileStorageService(homedir);
  return new BackgroundTaskPersistence(
    join(homedir, BACKGROUND_TEST_SESSION_SCOPE),
    BACKGROUND_TEST_SESSION_SCOPE,
    new AtomicDocumentStore(storage),
    storage,
  );
}
