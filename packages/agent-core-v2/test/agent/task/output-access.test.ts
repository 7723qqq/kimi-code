import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { join } from 'pathe';
import type { IHostProcess } from '#/os/interface/hostProcess';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { waitForAssertion } from '#test/helpers/waitFor';
import { AgentTaskPersistence, IAgentTaskService } from '#/agent/task/task';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TERMINAL_STATUSES } from '#/agent/task/types';
import { TaskOutputTool } from '#/agent/tools/task/task-output/taskOutputTool';
import { ProcessTask } from '#/agent/tools/os/bash/process-task';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import type { StorageReadRange } from '#/persistence/interface/storage';
import { createAgentTaskPersistence, type TaskServiceTestManager } from './stubs';
import { taskServices, createTestAgent, homeDirServices, type TestAgentContext } from '../../harness';
import { executeTool, type TestExecutableToolContext } from '../../tools/fixtures/execute-tool';

interface TaskServiceFixture {
  readonly ctx: TestAgentContext;
  readonly manager: TaskServiceTestManager;
  readonly persistence: ReturnType<typeof createAgentTaskPersistence>;
}

function createTaskService(homedir: string): TaskServiceFixture {
  const persistence = createAgentTaskPersistence(homedir);
  const ctx = createTestAgent(homeDirServices(homedir), taskServices());
  const manager = ctx.get(IAgentTaskService) as TaskServiceTestManager;
  return {
    ctx,
    manager,
    persistence,
  };
}

function registerProcess(
  manager: IAgentTaskService,
  proc: IHostProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessTask(proc, command, description));
}

function toolContext<Input>(
  toolCallId: string,
  args: Input,
): TestExecutableToolContext<Input> {
  return {
    turnId: 0,
    toolCallId,
    args,
    signal: new AbortController().signal,
  };
}

function outputString(result: { readonly output: string | readonly unknown[] }): string {
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
}

async function waitForOutput(
  manager: IAgentTaskService,
  taskId: string,
  expected: string,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const output = await manager.readOutput(taskId);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for output: ${expected}`);
}

async function waitForTaskNotifications(
  ctx: TestAgentContext,
  manager: TaskServiceTestManager,
): Promise<void> {
  const tasks = manager.list(false).filter(
    (task) =>
      TERMINAL_STATUSES.has(task.status) &&
      task.detached !== false &&
      task.terminalNotificationSuppressed !== true,
  );
  if (tasks.length === 0) return;

  ctx.mockNextResponse({ type: 'text', text: 'notification drain ack' });
  await waitForAssertion(() => {
    const delivered = ctx.allEvents.filter((e) => e.event === 'task.notified').length;
    expect(delivered).toBeGreaterThanOrEqual(tasks.length);
  });
  await waitForAssertion(() => {
    const loop = ctx.get(IAgentLoopService);
    expect(loop.snapshot().state).toBe('idle');
    expect(loop.snapshot().hasPendingRequests).toBe(false);
  });

  const origins = ctx.context.get().map((message) => message.origin);
  for (const task of tasks) {
    expect(origins).toContainEqual({
      kind: 'task',
      taskId: task.taskId,
      status: task.status,
      notificationId: `task:${task.taskId}:${task.status}`,
    });
  }
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

describe('AgentTaskService — readOutput / getOutputSnapshot', () => {
  let sessionDir: string;
  let ctx: TestAgentContext;
  let manager: TaskServiceTestManager;
  let persistence: ReturnType<typeof createAgentTaskPersistence>;

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), 'bpm-output-'));
    const fixture = createTaskService(sessionDir);
    ctx = fixture.ctx;
    manager = fixture.manager;
    persistence = fixture.persistence;
  });

  afterEach(async () => {
    try {
      await waitForTaskNotifications(ctx, manager);
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('getOutputSnapshot returns output.log path when persisted output exists', async () => {
    const taskId = registerProcess(manager, immediateProcess(0, 'hello\n'), 'echo', 'demo');

    await waitForOutput(manager, taskId, 'hello');
    const snapshot = await manager.getOutputSnapshot(taskId, 1_000);
    await manager.wait(taskId);

    expect(snapshot.outputPath).toBeDefined();
    expect(snapshot.outputPath).toContain(sessionDir);
    expect(snapshot.outputPath).toContain(taskId);
    expect(snapshot.outputPath!.endsWith('output.log')).toBe(true);
    expect(snapshot.fullOutputAvailable).toBe(true);
  });

  it('getOutputSnapshot truncates large persisted output to a tail preview with paging metadata', async () => {
    const head = 'HEAD-MARKER\n';
    const tail = 'TAIL-MARKER\n';
    const output = head + 'x'.repeat(200 * 1024) + tail;
    const taskId = registerProcess(manager, immediateProcess(0, output), 'echo big', 'large');

    await manager.wait(taskId);
    const snapshot = await manager.getOutputSnapshot(taskId, 32 * 1024);

    expect(snapshot.outputPath).toBeDefined();
    expect(snapshot.outputSizeBytes).toBe(Buffer.byteLength(output));
    expect(snapshot.previewBytes).toBe(32 * 1024);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.fullOutputAvailable).toBe(true);
    expect(snapshot.preview).toContain(tail);
    expect(snapshot.preview).not.toContain(head);
  });

  it('getOutputSnapshot omits outputPath when no persisted log file exists', async () => {
    const taskId = registerProcess(manager, immediateProcess(0), 'sleep 1', 'silent task');

    await manager.wait(taskId);
    const snapshot = await manager.getOutputSnapshot(taskId, 1_000);

    expect(snapshot.outputPath).toBeUndefined();
    expect(snapshot.fullOutputAvailable).toBe(false);
  });

  it('getOutputSnapshot returns an empty snapshot for unknown task ids', async () => {
    await expect(manager.getOutputSnapshot('bash-deadbeef', 1_000)).resolves.toEqual({
      outputSizeBytes: 0,
      previewBytes: 0,
      truncated: false,
      fullOutputAvailable: false,
      preview: '',
    });
  });

  it('reports a failed output write instead of claiming the log is complete', async () => {
    const stdout = new PassThrough();
    const taskId = registerProcess(
      manager,
      { ...immediateProcess(0), stdout },
      'echo',
      'failing',
    );
    stdout.write('live\n');
    await waitForOutput(manager, taskId, 'live');

    await persistence.appendTaskOutput(taskId, 'live\n');

    const owned = (manager as unknown as {
      persistence: { appendTaskOutput(id: string, chunk: string): Promise<void> };
    }).persistence;
    const original = owned.appendTaskOutput.bind(owned);
    owned.appendTaskOutput = async () => {
      throw new Error('disk full');
    };
    try {
      manager.persistOutput(taskId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      stdout.write('late\n');
      await new Promise((resolve) => setTimeout(resolve, 60));

      const snapshot = await manager.getOutputSnapshot(taskId, 4_000);
      expect(snapshot.outputPath).toBeDefined();
      expect(snapshot.fullOutputAvailable).toBe(false);

      stdout.end();
      await manager.wait(taskId);
    } finally {
      owned.appendTaskOutput = original;
    }
  });

  it('readOutput returns live ring-buffer content while task is in memory', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'live content\n'),
      'echo',
      'demo',
    );

    await waitForOutput(manager, taskId, 'live content');

    expect(await manager.readOutput(taskId)).toContain('live content');
    await manager.wait(taskId);
  });

  it('readOutput prefers disk over the live ring buffer when persisted output exists', async () => {
    const taskId = registerProcess(manager, immediateProcess(0, 'ring-only\n'), 'echo', 'demo');

    await waitForOutput(manager, taskId, 'ring-only');
    await persistence.appendTaskOutput(taskId, 'disk-only\n');

    expect(await manager.readOutput(taskId)).toContain('disk-only');
    await manager.wait(taskId);
  });

  it('readOutput falls back to disk for ghost tasks', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'persisted line\n'),
      'echo',
      'demo',
    );
    await waitForOutput(manager, taskId, 'persisted line');
    await manager.wait(taskId);

    const freshFixture = createTaskService(sessionDir);
    const fresh = freshFixture.manager;
    try {
      await fresh.loadFromDisk();
      await fresh.reconcile();

      expect(await fresh.readOutput(taskId)).toContain('persisted line');
      await freshFixture.ctx.expectResumeMatches();
    } finally {
      await freshFixture.ctx.dispose();
    }
  });

  it('TaskOutputTool reads persisted output for a ghost task loaded after restart', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'persisted output\n'),
      'echo persisted output',
      'persist output test',
    );
    await waitForOutput(manager, taskId, 'persisted output');
    await manager.wait(taskId);

    const freshFixture = createTaskService(sessionDir);
    const fresh = freshFixture.manager;
    try {
      await fresh.loadFromDisk();
      await fresh.reconcile();

      const result = await executeTool(
        new TaskOutputTool(fresh),
        toolContext('task_output_restored', { task_id: taskId }),
      );
      const output = outputString(result);

      expect(result.isError ?? false).toBe(false);
      expect(output).toContain('status: completed');
      expect(output).toContain('output_path:');
      expect(output).toContain('persisted output');
      await freshFixture.ctx.expectResumeMatches();
    } finally {
      await freshFixture.ctx.dispose();
    }
  });

  it('readOutput respects tail length', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'aaaaa-bbbbb-ccccc-ddddd'),
      'echo',
      'demo',
    );

    await waitForOutput(manager, taskId, 'ddddd');

    expect(await manager.readOutput(taskId, 5)).toBe('ddddd');
    await manager.wait(taskId);
  });

  it('readOutput returns the full output for a nonpositive tail', async () => {
    const taskId = registerProcess(
      manager,
      immediateProcess(0, 'aaaaa-bbbbb-ccccc-ddddd'),
      'echo',
      'demo',
    );

    await waitForOutput(manager, taskId, 'ddddd');

    const full = await manager.readOutput(taskId);
    expect(await manager.readOutput(taskId, 0)).toBe(full);
    expect(await manager.readOutput(taskId, -7)).toBe(full);
    await manager.wait(taskId);
  });

  it('readOutput does not split a surrogate pair at the tail boundary', async () => {
    const emoji = String.fromCodePoint(0x1f600);
    const taskId = registerProcess(
      manager,
      immediateProcess(0, `aaaaa-bbbbb-${emoji}cc`),
      'echo',
      'demo',
    );

    await waitForOutput(manager, taskId, 'cc');

    expect(await manager.readOutput(taskId, 3)).toBe('cc');
    expect(await manager.readOutput(taskId, 2)).toBe('cc');
    expect(await manager.readOutput(taskId, 4)).toBe(`${emoji}cc`);
    await manager.wait(taskId);
  });
});

class RecordingFileStorageService extends FileStorageService {
  readonly streamRanges: StorageReadRange[] = [];
  readonly wholeReads: string[] = [];

  override async *readStream(
    scope: string,
    key: string,
    range?: StorageReadRange,
  ): AsyncIterable<Uint8Array> {
    this.streamRanges.push(range ?? { start: 0, end: -1 });
    yield* super.readStream(scope, key, range);
  }

  override async read(scope: string, key: string): Promise<Uint8Array | undefined> {
    this.wholeReads.push(key);
    return super.read(scope, key);
  }
}

describe('AgentTaskPersistence — ranged tail read', () => {
  const PRIMARY_SCOPE = 'sessions/test-workspace/test-session/agents/main';
  const FALLBACK_SCOPE = 'sessions/test-workspace/test-session';
  const TASK_ID = 'bash-range001';

  let rootDir: string;
  let storage: RecordingFileStorageService;
  let primary: AgentTaskPersistence;
  let fallback: AgentTaskPersistence;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'bpm-range-'));
    storage = new RecordingFileStorageService(rootDir);
    const docs = new JsonAtomicDocumentStore(storage);
    primary = new AgentTaskPersistence(
      join(rootDir, PRIMARY_SCOPE),
      PRIMARY_SCOPE,
      docs,
      storage,
      { dir: join(rootDir, FALLBACK_SCOPE), scope: FALLBACK_SCOPE },
    );
    fallback = new AgentTaskPersistence(
      join(rootDir, FALLBACK_SCOPE),
      FALLBACK_SCOPE,
      docs,
      storage,
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('reads only the tail of a file larger than the preview limit', async () => {
    const body = 'x'.repeat(4096) + 'TAIL';
    await primary.appendTaskOutput(TASK_ID, body);

    const snapshot = await primary.readTaskOutputSnapshot(TASK_ID, 64);

    expect(snapshot?.outputSizeBytes).toBe(4100);
    expect(snapshot?.previewBytes).toBe(64);
    expect(snapshot?.truncated).toBe(true);
    expect(snapshot?.preview).toBe('x'.repeat(60) + 'TAIL');
    expect(snapshot?.preview?.endsWith('TAIL')).toBe(true);
  });

  it('returns the whole file when it is smaller than the preview limit', async () => {
    await primary.appendTaskOutput(TASK_ID, 'small output');

    const snapshot = await primary.readTaskOutputSnapshot(TASK_ID, 1024);

    expect(snapshot?.outputSizeBytes).toBe(12);
    expect(snapshot?.previewBytes).toBe(12);
    expect(snapshot?.truncated).toBe(false);
    expect(snapshot?.preview).toBe('small output');
  });

  it('starts the preview on a character boundary when a multi-byte character straddles the limit', async () => {
    await primary.appendTaskOutput(TASK_ID, `a${'😀'.repeat(3)}`);

    const snapshot = await primary.readTaskOutputSnapshot(TASK_ID, 5);

    expect(snapshot?.outputSizeBytes).toBe(13);
    expect(snapshot?.previewBytes).toBe(5);
    expect(snapshot?.preview).toBe('😀');
    expect(Buffer.byteLength(snapshot?.preview ?? '', 'utf-8')).toBeLessThanOrEqual(5);
  });

  it('returns undefined when the output log does not exist', async () => {
    expect(await primary.readTaskOutputSnapshot('bash-missing0', 64)).toBeUndefined();
  });

  it('reads the tail from the fallback root when the primary root has no output', async () => {
    await fallback.appendTaskOutput(TASK_ID, 'legacy output');

    const snapshot = await primary.readTaskOutputSnapshot(TASK_ID, 6);

    expect(snapshot?.outputPath).toBe(
      join(rootDir, FALLBACK_SCOPE, 'tasks', TASK_ID, 'output.log'),
    );
    expect(snapshot?.outputSizeBytes).toBe(13);
    expect(snapshot?.preview).toBe('output');
  });

  it('prefers the primary root output over the fallback root output', async () => {
    await fallback.appendTaskOutput(TASK_ID, 'legacy output');
    await primary.appendTaskOutput(TASK_ID, 'local output');

    const snapshot = await primary.readTaskOutputSnapshot(TASK_ID, 100);

    expect(snapshot?.outputPath).toBe(
      join(rootDir, PRIMARY_SCOPE, 'tasks', TASK_ID, 'output.log'),
    );
    expect(snapshot?.preview).toBe('local output');
  });

  it('reads the preview through a ranged stream read instead of loading the whole log', async () => {
    const body = 'y'.repeat(8192);
    await primary.appendTaskOutput(TASK_ID, body);

    const snapshot = await primary.readTaskOutputSnapshot(TASK_ID, 128);

    expect(snapshot?.previewBytes).toBe(128);
    expect(storage.wholeReads).toEqual([]);
    expect(storage.streamRanges).toHaveLength(1);
    const range = storage.streamRanges[0]!;
    expect(range.end).toBe(8191);
    expect(range.start).toBeLessThanOrEqual(8191 - 128);
    expect(range.end - range.start + 1).toBeLessThanOrEqual(128 + 4);
  });
});
