import { join } from 'pathe';

import {
  AgentTaskPersistence,
  type AgentTaskInfo,
  type IAgentTaskService,
} from '#/agent/task';
import { AtomicDocumentStore, FileStorageService } from '#/app/storage';

export type TaskServiceTestManager = IAgentTaskService & {
  loadFromDisk(): Promise<void>;
  reconcile(): Promise<readonly AgentTaskInfo[]>;
};

export const TASK_TEST_SESSION_SCOPE = 'sessions/test-workspace/test-session';

export function createAgentTaskPersistence(homedir: string): AgentTaskPersistence {
  const storage = new FileStorageService(homedir);
  return new AgentTaskPersistence(
    join(homedir, TASK_TEST_SESSION_SCOPE),
    TASK_TEST_SESSION_SCOPE,
    new AtomicDocumentStore(storage),
    storage,
  );
}
