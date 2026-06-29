import { describe, expect, it } from 'vitest';

import type { ClockSources } from '#/cron/tools/clock';
import { createCronScheduler, type CronScheduler } from '#/cron/tools/scheduler';
import type { CronTask } from '#/cron/tools/types';

interface HarnessOptions {
  readonly isIdle?: boolean;
  readonly isKilled?: boolean;
  readonly pollIntervalMs?: number | null;
  readonly onFireThrows?: boolean;
  readonly noJitter?: boolean;
}

interface Harness {
  readonly scheduler: CronScheduler;
  readonly tasks: CronTask[];
  readonly fired: Array<{ readonly task: CronTask; readonly coalescedCount: number }>;
  readonly removed: string[];
  readonly advanced: Array<{ readonly taskId: string; readonly lastFiredAt: number }>;
  advance(ms: number): void;
  setIdle(value: boolean): void;
  setKilled(value: boolean): void;
  setOnFireThrows(value: boolean): void;
  now(): number;
}

const WALL_ANCHOR = 1_700_000_000_000;

let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return idCounter.toString(16).padStart(8, '0');
}

function makeTask(overrides: Partial<CronTask> & { readonly cron: string; readonly createdAt: number }): CronTask {
  return {
    id: overrides.id ?? nextId(),
    prompt: overrides.prompt ?? 'do the thing',
    cron: overrides.cron,
    createdAt: overrides.createdAt,
    recurring: overrides.recurring,
    lastFiredAt: overrides.lastFiredAt,
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  let now = WALL_ANCHOR;
  let mono = 1_000_000;
  let idle = options.isIdle ?? true;
  let killed = options.isKilled ?? false;
  let onFireThrows = options.onFireThrows ?? false;

  const clocks: ClockSources = {
    wallNow: () => now,
    monoNowMs: () => mono,
  };
  const tasks: CronTask[] = [];
  const fired: Array<{ readonly task: CronTask; readonly coalescedCount: number }> = [];
  const removed: string[] = [];
  const advanced: Array<{ readonly taskId: string; readonly lastFiredAt: number }> = [];

  const scheduler = createCronScheduler({
    clocks,
    source: () => tasks,
    onFire: (task, ctx) => {
      if (onFireThrows) throw new Error('onFire boom');
      fired.push({ task, coalescedCount: ctx.coalescedCount });
    },
    isIdle: () => idle,
    isKilled: () => killed,
    removeOneShot: (id) => {
      removed.push(id);
      const index = tasks.findIndex((task) => task.id === id);
      if (index !== -1) tasks.splice(index, 1);
    },
    onAdvanceCursor: (taskId, lastFiredAt) => {
      advanced.push({ taskId, lastFiredAt });
    },
    pollIntervalMs: options.pollIntervalMs ?? null,
    noJitter: options.noJitter ?? true,
  });

  return {
    scheduler,
    tasks,
    fired,
    removed,
    advanced,
    advance(ms: number) {
      now += ms;
      mono += ms;
    },
    setIdle(value: boolean) {
      idle = value;
    },
    setKilled(value: boolean) {
      killed = value;
    },
    setOnFireThrows(value: boolean) {
      onFireThrows = value;
    },
    now() {
      return now;
    },
  };
}

describe('createCronScheduler tick behavior', () => {
  it('fires a recurring task once when due', () => {
    idCounter = 0;
    const h = createHarness();
    h.tasks.push(makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }));

    h.scheduler.tick();
    expect(h.fired).toHaveLength(0);

    h.advance(6 * 60_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.coalescedCount).toBe(1);
    expect(h.advanced).toHaveLength(1);
  });

  it('coalesces missed recurring fires when the scheduler sleeps', () => {
    idCounter = 0;
    const h = createHarness();
    h.tasks.push(makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }));

    h.advance(15 * 60_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.coalescedCount).toBeGreaterThanOrEqual(3);
    expect(h.fired[0]!.coalescedCount).toBeLessThanOrEqual(4);
  });

  it('removes one-shot tasks after a successful fire', () => {
    idCounter = 0;
    const h = createHarness();
    h.tasks.push(
      makeTask({
        cron: '0 12 * * *',
        createdAt: h.now() - 60_000,
        recurring: false,
      }),
    );
    const taskId = h.tasks[0]!.id;

    h.advance(25 * 60 * 60_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.coalescedCount).toBe(1);
    expect(h.removed).toEqual([taskId]);
    expect(h.tasks).toHaveLength(0);
  });

  it('does not fire while not idle and does not lose the task', () => {
    idCounter = 0;
    const h = createHarness({ isIdle: false });
    h.tasks.push(makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }));

    h.advance(6 * 60_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(0);

    h.setIdle(true);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);
  });

  it('short-circuits when killed even if due and idle', () => {
    idCounter = 0;
    const h = createHarness({ isKilled: true });
    h.tasks.push(makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }));

    h.advance(6 * 60_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(0);

    h.setKilled(false);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);
  });

  it('continues past a task with a bad cron expression', () => {
    idCounter = 0;
    const h = createHarness();
    const bad: CronTask = {
      id: nextId(),
      cron: 'not a cron at all',
      prompt: 'bad',
      createdAt: h.now(),
      recurring: true,
    };
    const good: CronTask = {
      id: nextId(),
      cron: '*/5 * * * *',
      prompt: 'good',
      createdAt: h.now(),
      recurring: true,
    };
    h.tasks.push(bad, good);

    h.advance(6 * 60_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.task.id).toBe(good.id);
  });

  it('fires only the due task when two tasks are scheduled', () => {
    idCounter = 0;
    const h = createHarness();
    h.tasks.push(
      makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }),
      makeTask({ cron: '0 0 1 1 *', createdAt: h.now(), recurring: true }),
    );
    const dueId = h.tasks[0]!.id;

    h.advance(6 * 60_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.task.id).toBe(dueId);
  });

  it('retries a recurring task when onFire throws', () => {
    idCounter = 0;
    const h = createHarness({ onFireThrows: true });
    h.tasks.push(makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }));

    h.advance(6 * 60_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(0);
    expect(h.advanced).toHaveLength(0);

    h.setOnFireThrows(false);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.coalescedCount).toBe(1);
  });

  it('does not remove a one-shot task when onFire throws', () => {
    idCounter = 0;
    const h = createHarness({ onFireThrows: true });
    h.tasks.push(makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: false }));
    const taskId = h.tasks[0]!.id;

    h.advance(6 * 60_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(0);
    expect(h.removed).toEqual([]);
    expect(h.tasks.map((task) => task.id)).toEqual([taskId]);

    h.setOnFireThrows(false);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);
    expect(h.removed).toEqual([taskId]);
  });
});

describe('createCronScheduler next-fire queries', () => {
  it('returns null when there are no tasks', () => {
    const h = createHarness();
    expect(h.scheduler.getNextFireTime()).toBeNull();
  });

  it('returns the minimum next fire across tasks', () => {
    idCounter = 0;
    const h = createHarness();
    h.tasks.push(
      makeTask({ cron: '* * * * *', createdAt: h.now(), recurring: true }),
      makeTask({ cron: '0 0 1 1 *', createdAt: h.now(), recurring: true }),
    );

    const next = h.scheduler.getNextFireTime();

    expect(next).not.toBeNull();
    expect(next! - h.now()).toBeLessThanOrEqual(65_000);
  });

  it('returns null for an unknown task id', () => {
    idCounter = 0;
    const h = createHarness();
    expect(h.scheduler.getNextFireForTask('00000000')).toBeNull();

    h.tasks.push(makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }));

    expect(h.scheduler.getNextFireForTask('ffffffff')).toBeNull();
  });

  it('returns the same value as getNextFireTime for a single-task source', () => {
    idCounter = 0;
    const h = createHarness();
    h.tasks.push(makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }));
    const taskId = h.tasks[0]!.id;

    expect(h.scheduler.getNextFireForTask(taskId)).toBe(h.scheduler.getNextFireTime());
  });

  it('preserves a pending jittered slot when the ideal fire is just past', () => {
    idCounter = 0;
    const h = createHarness({ noJitter: false });
    h.tasks.push(
      makeTask({
        id: 'ffffffff',
        cron: '*/5 * * * *',
        createdAt: h.now(),
        recurring: true,
      }),
    );
    const taskId = h.tasks[0]!.id;

    h.advance(6 * 60_000 + 30_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);

    const pendingJittered = h.scheduler.getNextFireForTask(taskId);
    expect(pendingJittered).not.toBeNull();

    h.advance(pendingJittered! - 10_000 - h.now());

    const next = h.scheduler.getNextFireForTask(taskId);
    expect(next).toBe(pendingJittered);
    expect(next! - h.now()).toBeLessThanOrEqual(15_000);
    expect(next! - h.now()).toBeGreaterThan(0);
  });

  it('seeds next-fire queries from a sane persisted lastFiredAt cursor', () => {
    const h = createHarness();
    const createdAt = h.now() - 24 * 60 * 60_000;
    const lastFiredAt = h.now() - 10 * 60_000;
    h.tasks.push(
      makeTask({
        id: 'deadbeef',
        cron: '*/5 * * * *',
        createdAt,
        lastFiredAt,
        recurring: true,
      }),
    );

    const next = h.scheduler.getNextFireForTask('deadbeef');

    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(lastFiredAt);
    expect(next! - h.now()).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe('createCronScheduler start and stop lifecycle', () => {
  it('does not auto-tick when pollIntervalMs is null', async () => {
    idCounter = 0;
    const h = createHarness({ pollIntervalMs: null });
    h.tasks.push(makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }));
    h.scheduler.start();
    h.advance(60 * 60_000);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(h.fired).toHaveLength(0);
    await h.scheduler.stop();
  });

  it('auto-ticks when pollIntervalMs is positive', async () => {
    idCounter = 0;
    const h = createHarness({ pollIntervalMs: 20 });
    h.tasks.push(makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }));
    h.advance(6 * 60_000);

    h.scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await h.scheduler.stop();

    expect(h.fired.length).toBeGreaterThanOrEqual(1);
    expect(h.fired[0]!.coalescedCount).toBe(1);
  });

  it('is safe to start and stop repeatedly', async () => {
    const h = createHarness({ pollIntervalMs: null });

    expect(() => {
      h.scheduler.start();
      h.scheduler.start();
    }).not.toThrow();
    await h.scheduler.stop();
    await h.scheduler.stop();

    h.scheduler.tick();
    expect(h.fired).toHaveLength(0);
  });
});

describe('createCronScheduler jitter integration', () => {
  it('fires a recurring task after advancing past the jitter cap', () => {
    idCounter = 0;
    const h = createHarness({ noJitter: false });
    h.tasks.push(makeTask({ cron: '*/5 * * * *', createdAt: h.now(), recurring: true }));

    h.advance(6 * 60_000 + 30_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.coalescedCount).toBe(1);
  });

  it('always reports coalescedCount 1 for a one-shot backlog', () => {
    idCounter = 0;
    const h = createHarness();
    const task = makeTask({
      cron: '0 9 * * *',
      createdAt: h.now(),
      recurring: false,
    });
    h.tasks.push(task);

    h.advance(7 * 24 * 60 * 60_000);
    h.scheduler.tick();

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.coalescedCount).toBe(1);
    expect(h.removed).toEqual([task.id]);
  });

  it('does not advance the baseline past a not-yet-jittered ideal fire', () => {
    idCounter = 0;
    const h = createHarness({ noJitter: false });
    h.tasks.push(
      makeTask({
        id: 'ffffffff',
        cron: '*/5 * * * *',
        createdAt: h.now(),
        recurring: true,
      }),
    );

    h.advance(6 * 60_000 + 30_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);

    h.advance(20_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1);

    h.advance(60_000);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]!.coalescedCount).toBe(1);
  });
});
