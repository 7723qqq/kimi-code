import {
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPromptService,
  IAgentTaskService,
  IConfigService,
  type AgentTaskInfo,
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

import { V2Session } from '../../../src/cli/v2/v2-session';

interface FakeTask {
  readonly taskId: string;
  readonly kind?: AgentTaskInfo['kind'];
  /** ms until this task completes once `wait` is called on it. */
  readonly completesInMs: number;
  /** Optional task to spawn (append to the active list) when this task completes. */
  readonly spawnsOnComplete?: FakeTask;
  active: boolean;
}

class FakeTaskService {
  readonly suppressed: string[] = [];
  readonly waitCalls: Array<{ taskId: string; timeoutMs: number | undefined }> = [];

  constructor(private readonly tasks: FakeTask[]) {}

  list(activeOnly?: boolean): readonly AgentTaskInfo[] {
    return this.tasks
      .filter((task) => !activeOnly || task.active)
      .map(
        (task) =>
          ({
            taskId: task.taskId,
            kind: task.kind ?? 'process',
            status: 'running',
          }) as unknown as AgentTaskInfo,
      );
  }

  suppressTerminalNotification(taskId: string): Promise<void> {
    this.suppressed.push(taskId);
    return Promise.resolve();
  }

  wait(taskId: string, timeoutMs?: number): Promise<AgentTaskInfo | undefined> {
    this.waitCalls.push({ taskId, timeoutMs });
    const task = this.tasks.find((entry) => entry.taskId === taskId);
    const completesInMs = task?.completesInMs ?? 0;
    const completed =
      task !== undefined && completesInMs <= (timeoutMs ?? Number.POSITIVE_INFINITY);
    const waitMs = timeoutMs === undefined ? completesInMs : Math.min(completesInMs, timeoutMs);
    return new Promise((resolve) => {
      setTimeout(() => {
        if (completed && task !== undefined) {
          task.active = false;
          if (task.spawnsOnComplete !== undefined) this.tasks.push(task.spawnsOnComplete);
        }
        resolve({
          taskId,
          status: completed ? 'completed' : 'running',
        } as unknown as AgentTaskInfo);
      }, waitMs);
    });
  }
}

function fakeAccessor(map: Map<unknown, unknown>) {
  return { get: (token: unknown) => map.get(token) };
}

class FakeAfterStepSlot {
  registration:
    | {
        id: string;
        handler: (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void>;
        options: unknown;
      }
    | undefined;

  register(
    id: string,
    handler: (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void>,
    options?: unknown,
  ) {
    this.registration = { id, handler, options };
    return { dispose: () => {} };
  }

  async run(ctx: Record<string, unknown>): Promise<void> {
    if (this.registration === undefined) return;
    await this.registration.handler(ctx, async () => {});
  }
}

class FakeLoopService {
  readonly afterStep = new FakeAfterStepSlot();
  readonly hooks = {
    beforeStep: { register: () => ({ dispose: () => {} }) },
    afterStep: this.afterStep,
    onError: { register: () => ({ dispose: () => {} }) },
  };
}

function buildSession(options: {
  ceilingS?: number;
  keepAliveOnExit?: boolean;
  taskServices: FakeTaskService[];
  drainAgentTasksOnStop?: boolean;
  loop?: FakeLoopService;
}): V2Session {
  const taskConfig =
    options.ceilingS !== undefined || options.keepAliveOnExit !== undefined
      ? {
          keepAliveOnExit: options.keepAliveOnExit,
          printWaitCeilingS: options.ceilingS,
        }
      : undefined;
  const coreMap = new Map<unknown, unknown>([
    [
      IConfigService,
      {
        get: (section: string) => (section === 'task' ? taskConfig : undefined),
      },
    ],
  ]);

  const agentHandles: IAgentScopeHandle[] = options.taskServices.map((service) => {
    const agentMap = new Map<unknown, unknown>([[IAgentTaskService, service]]);
    return { accessor: fakeAccessor(agentMap) } as unknown as IAgentScopeHandle;
  });

  const mainAgentMap = new Map<unknown, unknown>();
  if (options.taskServices[0] !== undefined) {
    mainAgentMap.set(IAgentTaskService, options.taskServices[0]);
  }
  if (options.loop !== undefined) {
    mainAgentMap.set(IAgentLoopService, options.loop);
    mainAgentMap.set(IAgentPromptService, {});
  }

  const sessionMap = new Map<unknown, unknown>([
    [
      IAgentLifecycleService,
      {
        list: () => agentHandles,
      },
    ],
  ]);

  return new V2Session({
    core: { accessor: fakeAccessor(coreMap) } as unknown as Scope,
    session: { id: 'sess-1', accessor: fakeAccessor(sessionMap) } as unknown as ISessionScopeHandle,
    agent: { id: 'main', accessor: fakeAccessor(mainAgentMap) } as unknown as IAgentScopeHandle,
    drainAgentTasksOnStop: options.drainAgentTasksOnStop,
  });
}

describe('V2Session.waitForBackgroundTasksOnPrint', () => {
  it('returns immediately when there are no active background tasks', async () => {
    const service = new FakeTaskService([]);
    const session = buildSession({ keepAliveOnExit: true, taskServices: [service] });

    await session.waitForBackgroundTasksOnPrint();

    expect(service.waitCalls).toHaveLength(0);
  });

  it('returns immediately when keepAliveOnExit is not enabled', async () => {
    const service = new FakeTaskService([{ taskId: 'a', completesInMs: 20, active: true }]);
    const session = buildSession({ taskServices: [service] });

    await session.waitForBackgroundTasksOnPrint();

    expect(service.waitCalls).toHaveLength(0);
    expect(service.suppressed).toHaveLength(0);
  });

  it('waits for a background task to complete and bounds the wait by the default ceiling, not 30s', async () => {
    const service = new FakeTaskService([{ taskId: 'a', completesInMs: 20, active: true }]);
    const session = buildSession({ keepAliveOnExit: true, taskServices: [service] });

    await session.waitForBackgroundTasksOnPrint();

    expect(service.waitCalls).toHaveLength(1);
    expect(service.waitCalls[0]?.taskId).toBe('a');
    // The old implementation hardcoded a 30s cap; the drain must use the 1h
    // default ceiling so long tasks are allowed to finish.
    expect(service.waitCalls[0]?.timeoutMs).toBeGreaterThan(30_000);
    expect(service.suppressed).toContain('a');
  });

  it('honors [task].print_wait_ceiling_s as the wait bound', async () => {
    const service = new FakeTaskService([
      { taskId: 'stuck', completesInMs: Number.POSITIVE_INFINITY, active: true },
    ]);
    const session = buildSession({ ceilingS: 1, keepAliveOnExit: true, taskServices: [service] });

    const startedAt = Date.now();
    await session.waitForBackgroundTasksOnPrint();
    const elapsed = Date.now() - startedAt;

    expect(service.waitCalls[0]?.timeoutMs).toBeLessThanOrEqual(1000);
    expect(service.waitCalls[0]?.timeoutMs).toBeGreaterThan(0);
    // Returns near the 1s ceiling, never hangs until the (infinite) task.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('re-enumerates to drain tasks spawned by a completing task', async () => {
    const spawned: FakeTask = { taskId: 'b', completesInMs: 20, active: true };
    const service = new FakeTaskService([
      { taskId: 'a', completesInMs: 20, active: true, spawnsOnComplete: spawned },
    ]);
    const session = buildSession({ keepAliveOnExit: true, taskServices: [service] });

    await session.waitForBackgroundTasksOnPrint();

    const waitedIds = service.waitCalls.map((call) => call.taskId);
    expect(waitedIds).toContain('a');
    expect(waitedIds).toContain('b');
    expect(service.suppressed).toEqual(expect.arrayContaining(['a', 'b']));
  });
});

describe('V2Session print drain hook', () => {
  it('waits for active background subagents before the print turn ends', async () => {
    const loop = new FakeLoopService();
    const spawned: FakeTask = {
      taskId: 'agent-b',
      kind: 'agent',
      completesInMs: 20,
      active: true,
    };
    const service = new FakeTaskService([
      {
        taskId: 'agent-a',
        kind: 'agent',
        completesInMs: 20,
        active: true,
        spawnsOnComplete: spawned,
      },
    ]);
    buildSession({
      taskServices: [service],
      drainAgentTasksOnStop: true,
      loop,
    });

    expect(loop.afterStep.registration?.id).toBe('print-drain-agent-tasks');
    expect(loop.afterStep.registration?.options).toEqual({ after: 'prompt-service-steer' });
    const ctx = {
      signal: new AbortController().signal,
      finishReason: 'completed',
      continue: false,
    };

    await loop.afterStep.run(ctx);

    expect(service.waitCalls.map((call) => call.taskId)).toEqual(['agent-a', 'agent-b']);
    expect(ctx.continue).toBe(true);
  });

  it('does not hold the print turn for non-agent background tasks', async () => {
    const loop = new FakeLoopService();
    const service = new FakeTaskService([
      { taskId: 'proc-a', kind: 'process', completesInMs: 20, active: true },
    ]);
    buildSession({
      taskServices: [service],
      drainAgentTasksOnStop: true,
      loop,
    });
    const ctx = {
      signal: new AbortController().signal,
      finishReason: 'completed',
      continue: false,
    };

    await loop.afterStep.run(ctx);

    expect(service.waitCalls).toHaveLength(0);
    expect(ctx.continue).toBe(false);
  });
});
