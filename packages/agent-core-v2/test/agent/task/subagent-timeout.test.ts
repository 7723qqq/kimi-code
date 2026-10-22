import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { IAgentTaskService } from '#/agent/task/task';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { IHostTimers, type IHostTimerHandle } from '#/os/interface/hostTimers';
import { appService, createTestAgent, type TestAgentContext } from '../../harness';

interface FakeHostTimerHandle extends IHostTimerHandle {
  readonly id: number;
}

interface FakeHostTimers extends IHostTimers {
  advance(byMs: number): void;
  readonly pending: number;
}

function createFakeHostTimers(): FakeHostTimers {
  let nowMs = 0;
  let nextId = 1;
  const scheduled: Array<{
    readonly id: number;
    due: number;
    readonly callback: () => void;
    cancelled: boolean;
  }> = [];

  const schedule = (callback: () => void, delayMs: number): FakeHostTimerHandle => {
    const id = nextId;
    nextId += 1;
    scheduled.push({ id, due: nowMs + delayMs, callback, cancelled: false });
    return { id, unref: () => {} };
  };

  return {
    _serviceBrand: undefined,
    setClampedTimeout: (callback, timeoutMs) => schedule(callback, timeoutMs),
    setTimeout: (callback, timeoutMs) => schedule(callback, timeoutMs),
    clearTimeout: (handle) => {
      const id = (handle as FakeHostTimerHandle).id;
      const timer = scheduled.find((candidate) => candidate.id === id);
      if (timer !== undefined) timer.cancelled = true;
    },
    advance: (byMs) => {
      const limit = nowMs + byMs;
      let guard = 0;
      for (;;) {
        const next = scheduled
          .filter((timer) => !timer.cancelled && timer.due <= limit)
          .sort((left, right) => left.due - right.due || left.id - right.id)[0];
        if (next === undefined) break;
        guard += 1;
        if (guard > 1_000) throw new Error('fake host timers advanced more than 1000 timers');
        nowMs = next.due;
        next.cancelled = true;
        next.callback();
      }
      nowMs = limit;
    },
    get pending() {
      return scheduled.filter((timer) => !timer.cancelled).length;
    },
  };
}

async function flushHostWork(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function advanceHostTime(timers: FakeHostTimers, byMs: number): Promise<void> {
  await flushHostWork();
  timers.advance(byMs);
  await flushHostWork();
}

function agentTask(
  completion: Promise<{ result: string }>,
  description: string,
): SubagentTask {
  return new SubagentTask(
    { agentId: 'agent-child', profileName: 'coder', completion },
    description,
    new AbortController(),
  );
}

describe('SubagentTask — timeoutMs', () => {
  let ctx: TestAgentContext;
  let background: IAgentTaskService;
  let timers: FakeHostTimers;

  beforeEach(() => {
    timers = createFakeHostTimers();
    ctx = createTestAgent(appService(IHostTimers, timers));
    background = ctx.get(IAgentTaskService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('external deadline marks task timed_out', async () => {
    const hangForever = new Promise<{ result: string }>(() => {});
    const taskId = background.registerTask(agentTask(hangForever, 'hang'), {
      timeoutMs: 2_000,
    });

    const terminalPromise = background.wait(taskId);
    await advanceHostTime(timers, 7_100);
    const info = await terminalPromise;

    expect(info?.status).toBe('timed_out');
    expect(info?.stopReason).toBeUndefined();
  });

  it('omitting timeoutMs lets the task run to completion without a manager deadline', async () => {
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });
    const taskId = background.registerTask(agentTask(completion, 'no deadline'));

    resolveFn({ result: 'finished' });
    const info = await background.wait(taskId);
    expect(info?.status).toBe('completed');
    expect(info?.stopReason).toBeUndefined();
  });

  it('internal TimeoutError rejection = generic failure with error reason', async () => {
    const internalErr = new Error('aiohttp sock_read timeout');
    internalErr.name = 'TimeoutError';
    const rejecting = Promise.reject(internalErr);
    const taskId = background.registerTask(agentTask(rejecting, 'internal timeout'), {
      timeoutMs: 900_000,
    });

    const info = await background.wait(taskId);
    expect(info?.status).toBe('failed');
    expect(info?.stopReason).toBe('aiohttp sock_read timeout');
  });

  it('explicit timeoutMs is persisted on the task info', async () => {
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });
    const taskId = background.registerTask(
      agentTask(completion, 'persist timeout'),
      { timeoutMs: 1_800_000 },
    );
    const info = background.getTask(taskId);
    expect((info as unknown as { timeoutMs?: number }).timeoutMs).toBe(1_800_000);
    resolveFn({ result: 'finished' });
    await expect(background.wait(taskId)).resolves.toMatchObject({ status: 'completed' });
  });

  it('omitted timeoutMs leaves the task info field undefined', async () => {
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });
    const taskId = background.registerTask(agentTask(completion, 'default timeout'));
    const info = background.getTask(taskId);
    expect((info as unknown as { timeoutMs?: number }).timeoutMs).toBeUndefined();
    resolveFn({ result: 'finished' });
    await expect(background.wait(taskId)).resolves.toMatchObject({ status: 'completed' });
  });

  it('timeoutMs=0 is preserved on the task info and does not arm a deadline', async () => {
    let resolveFn!: (r: { result: string }) => void;
    const completion = new Promise<{ result: string }>((res) => {
      resolveFn = res;
    });
    const taskId = background.registerTask(agentTask(completion, 'zero timeout'), {
      timeoutMs: 0,
    });
    const initial = background.getTask(taskId);
    expect((initial as unknown as { timeoutMs?: number }).timeoutMs).toBe(0);

    const waiting = background.wait(taskId, 5);
    await advanceHostTime(timers, 5);
    const info = await waiting;
    const raced = info === undefined ? undefined : {
      status: info.status,
      stopReason: info.stopReason,
    };
    expect(raced?.status).toBe('running');
    expect(raced?.stopReason).toBeUndefined();
    resolveFn({ result: 'finished' });
    await expect(background.wait(taskId)).resolves.toMatchObject({ status: 'completed' });
  });
});
