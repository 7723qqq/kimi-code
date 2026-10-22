import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';

import type { IHostProcess } from '#/os/interface/hostProcess';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { IAgentTaskService, type AgentTask } from '#/agent/task/task';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import {
  configServices,
  createTestAgent,
  homeDirServices,
  taskServices,
  type TestAgentContext,
} from '../../harness';
import { createAgentTaskPersistence, type TaskServiceTestManager } from './stubs';

const DEFAULT_MAX_SETTLED_TASKS = 200;
const TERMINAL_RETAINED_OUTPUT_BYTES = 64 * 1024;

interface RetentionFixture {
  readonly ctx: TestAgentContext;
  readonly manager: TaskServiceTestManager;
  readonly persistence: ReturnType<typeof createAgentTaskPersistence>;
}

function outputtingTask(
  output: string,
  description = 'retention',
  stopReason?: string,
): AgentTask {
  return {
    idPrefix: 'test',
    kind: 'process',
    description,
    start: async (sink) => {
      if (output.length > 0) sink.appendOutput(output);
      await sink.settle({ status: 'completed', stopReason });
    },
    toInfo: (base) => ({ ...base, kind: 'process', command: 'echo', pid: 0, exitCode: 0 }),
  };
}

function createRetentionFixture(homedir: string): RetentionFixture {
  const persistence = createAgentTaskPersistence(homedir);
  const ctx = createTestAgent(homeDirServices(homedir), taskServices());
  return {
    ctx,
    manager: ctx.get(IAgentTaskService) as TaskServiceTestManager,
    persistence,
  };
}

function immediateProcess(exitCode: number, stdoutText = ''): IHostProcess {
  return {
    _serviceBrand: undefined,
    stdin: { write: mock(), end: mock() } as unknown as Writable,
    stdout: Readable.from(stdoutText ? [stdoutText] : []),
    stderr: Readable.from([]),
    pid: 50000 + exitCode,
    exitCode,
    wait: mock().mockResolvedValue(exitCode) as IHostProcess['wait'],
    kill: mock().mockResolvedValue(undefined) as IHostProcess['kill'],
    dispose: mock().mockResolvedValue(undefined) as IHostProcess['dispose'],
  };
}

function liveTaskCount(manager: TaskServiceTestManager): number {
  return (manager as unknown as { tasks: Map<string, unknown> }).tasks.size;
}

describe('AgentTaskService — terminal task retention', () => {
  let sessionDir: string;
  let fixture: RetentionFixture;

  beforeEach(async () => {
    sessionDir = mkdtempSync(join(tmpdir(), 'bpm-retention-'));
    fixture = createRetentionFixture(sessionDir);
    await fixture.manager.suppressAllTerminalNotifications();
  });

  afterEach(async () => {
    try {
      await fixture.ctx.expectResumeMatches();
    } finally {
      await fixture.ctx.dispose();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('keeps at most 200 settled tasks in memory and answers the oldest via its ghost', async () => {
    const manager = fixture.manager;
    const taskIds: string[] = [];

    const oldestId = manager.registerTask(
      outputtingTask('first\n', 'task 0', 'handoff complete'),
    );
    taskIds.push(oldestId);
    for (let i = 1; i < 300; i++) {
      taskIds.push(
        manager.registerTask(outputtingTask(`output ${String(i)}\n`, `task ${String(i)}`)),
      );
    }
    for (const taskId of taskIds) {
      await manager.wait(taskId, 5_000);
    }

    expect(liveTaskCount(manager)).toBeLessThanOrEqual(DEFAULT_MAX_SETTLED_TASKS);

    expect(manager.getTask(oldestId)).toMatchObject({
      taskId: oldestId,
      status: 'completed',
      stopReason: 'handoff complete',
    });
    expect(manager.list(false).some((info) => info.taskId === oldestId)).toBe(true);
    await expect(manager.wait(oldestId, 1_000)).resolves.toMatchObject({
      taskId: oldestId,
      status: 'completed',
    });
    await expect(fixture.persistence.readTask(oldestId)).resolves.toMatchObject({
      taskId: oldestId,
      status: 'completed',
    });

    const newest = taskIds.at(-1)!;
    expect(manager.getTask(newest)).toMatchObject({ taskId: newest, status: 'completed' });
    expect(manager.list(false).some((info) => info.taskId === newest)).toBe(true);
  });

  it('keeps persisted output fully readable after a settled task is evicted', async () => {
    const manager = fixture.manager;
    const first = manager.registerTask(
      new ProcessTask(immediateProcess(0, 'persisted output\n'), 'echo', 'first'),
    );
    await manager.wait(first, 5_000);

    for (let i = 0; i < 250; i++) {
      const extra = manager.registerTask(outputtingTask('', `filler ${String(i)}`));
      await manager.wait(extra, 5_000);
    }

    const snapshot = await manager.getOutputSnapshot(first, 1_000);
    expect(snapshot.fullOutputAvailable).toBe(true);
    expect(snapshot.outputSizeBytes).toBe(Buffer.byteLength('persisted output\n'));
    expect(snapshot.preview).toContain('persisted output');
  });

  it('bounds the retained in-memory output of a settled task to the last 64 KiB', async () => {
    const manager = fixture.manager;
    const head = 'HEAD-MARKER\n';
    const tail = 'TAIL-MARKER\n';
    const output = head + 'x'.repeat(200 * 1024) + tail;
    const taskId = manager.registerTask(
      new ProcessTask(immediateProcess(0, output), 'echo big', 'large'),
    );

    await manager.wait(taskId, 5_000);
    const retained = (
      manager as unknown as { tasks: Map<string, { outputChunks: string[] }> }
    ).tasks.get(taskId)!.outputChunks.join('');

    expect(Buffer.byteLength(retained, 'utf-8')).toBeLessThanOrEqual(
      TERMINAL_RETAINED_OUTPUT_BYTES * 2,
    );
    expect(retained).toContain(tail);
    expect(retained).not.toContain(head);

    const snapshot = await manager.getOutputSnapshot(taskId, 32 * 1024);
    expect(snapshot.fullOutputAvailable).toBe(true);
    expect(snapshot.outputSizeBytes).toBe(Buffer.byteLength(output));
  });

  it('keeps the full retained output of a settled task whose output was never persisted', async () => {
    const manager = fixture.manager;
    const output = 'foreground only\n'.repeat(8 * 1024);
    const taskId = manager.registerTask(
      new ProcessTask(immediateProcess(0, output), 'echo foreground', 'foreground'),
      { detached: false },
    );

    await manager.wait(taskId, 5_000);

    expect(await manager.readOutput(taskId)).toContain('foreground only');
    const snapshot = await manager.getOutputSnapshot(taskId, 4 * 1024);
    expect(snapshot.fullOutputAvailable).toBe(false);
  });

  it('honors the maxSettledTasks escape hatch', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'bpm-retention-cfg-'));
    const configured = createTestAgent(
      homeDirServices(configDir),
      taskServices(),
      configServices(() => ({ providers: {}, task: { maxSettledTasks: 2 } })),
    );
    const manager = configured.get(IAgentTaskService) as TaskServiceTestManager;
    try {
      await manager.suppressAllTerminalNotifications();
      const taskIds: string[] = [];
      for (let i = 0; i < 6; i++) {
        taskIds.push(manager.registerTask(outputtingTask('', `small ${String(i)}`)));
      }
      for (const taskId of taskIds) {
        await manager.wait(taskId, 5_000);
      }

      expect(liveTaskCount(manager)).toBeLessThanOrEqual(2);
      const oldestId = taskIds[0]!;
      expect(manager.getTask(oldestId)).toMatchObject({
        taskId: oldestId,
        status: 'completed',
      });
    } finally {
      await configured.dispose();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('keeps a running task out of the settled eviction window', async () => {
    const manager = fixture.manager;
    const running = manager.registerTask({
      ...outputtingTask('', 'still running'),
      start: () => {},
    });

    for (let i = 0; i < 250; i++) {
      const extra = manager.registerTask(outputtingTask('', `filler ${String(i)}`));
      await manager.wait(extra, 5_000);
    }

    expect(manager.getTask(running)).toMatchObject({ taskId: running, status: 'running' });
    await manager.stop(running, 'test cleanup');
  });
});
