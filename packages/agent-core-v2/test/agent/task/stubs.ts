import { join } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  AgentTaskPersistence,
  type AgentTaskInfo,
  IAgentTaskService,
} from '#/agent/task/task';
import { TaskStarted, TaskTerminated } from '#/agent/task/taskOps';
import type { WireRecord } from '#/wire/record';
import type { TestAgentContext } from '../../harness';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';

export type TaskServiceTestManager = IAgentTaskService & {
  loadFromDisk(): Promise<void>;
  reconcile(): Promise<readonly AgentTaskInfo[]>;
};

export const TASK_TEST_SESSION_SCOPE = 'sessions/test-workspace/test-session';

export const TASK_TEST_AGENT_SCOPE = `${TASK_TEST_SESSION_SCOPE}/agents/main`;

export function createAgentTaskPersistence(homedir: string): AgentTaskPersistence {
  const storage = new FileStorageService(homedir);
  return new AgentTaskPersistence(
    join(homedir, TASK_TEST_AGENT_SCOPE),
    TASK_TEST_AGENT_SCOPE,
    new JsonAtomicDocumentStore(storage),
    storage,
  );
}

export interface RecordingAppendWrite {
  readonly path: string;
  readonly data: string;
}

export function recordingAppendFs(writes: RecordingAppendWrite[]): IHostFileSystem {
  return {
    mkdir: async () => {},
    writeText: async (path: string, data: string) => {
      writes.push({ path, data });
    },
    appendText: async (path: string, data: string) => {
      writes.push({ path, data });
    },
  } as unknown as IHostFileSystem;
}

export function taskHistoryRecords(
  infos: readonly AgentTaskInfo[],
  agentId = 'main',
): WireRecord[] {
  return infos.flatMap((info) => {
    const started = {
      type: TaskStarted.type,
      agentId,
      info: { ...info, status: 'running', endedAt: null },
    } as unknown as WireRecord;
    if (info.status === 'running') return [started];
    return [
      started,
      { type: TaskTerminated.type, agentId, info } as unknown as WireRecord,
    ];
  });
}

export async function restoreTaskHistory(
  ctx: { restore(records: readonly WireRecord[]): Promise<void> },
  infos: readonly AgentTaskInfo[],
  agentId = 'main',
  preceding: readonly WireRecord[] = [],
): Promise<void> {
  await ctx.restore([...preceding, ...taskHistoryRecords(infos, agentId)]);
}

export interface ControlledTaskHelper {
  readonly handler: { readonly taskId: string; wait(): Promise<void> };
  readonly resolve: (value: string) => void;
}

export function installControlledTask(_ctx: TestAgentContext): void {}

export async function startControlledTaskInLoop(
  ctx: TestAgentContext,
  options: { readonly description?: string } = {},
): Promise<ControlledTaskHelper> {
  const tasks = ctx.get(IAgentTaskService);
  let resolveCompletion: (value: string) => void = () => {};
  const completion = new Promise<string>((resolve) => {
    resolveCompletion = resolve;
  });
  const taskId = tasks.registerTask(
    {
      idPrefix: 'controlled',
      kind: 'question',
      description: options.description ?? 'controlled task',
      start: async ({ settle }) => {
        await completion;
        await settle({ status: 'completed' });
      },
      toInfo: (base) => ({
        ...base,
        kind: 'question',
        questionCount: 1,
        toolCallId: 'controlled-call',
      }),
    },
    { detached: true },
  );
  const wait = async (): Promise<void> => {
    await tasks.wait(taskId);
  };
  return {
    handler: { taskId, wait },
    resolve: resolveCompletion,
  };
}
