/**
 * Scenario: the **turn-loop** slice — one execution round of an agent, owned
 * by `IAgentTurnService` and driven by `IAgentLoopService`.
 *
 * Concept taught: a *turn* is the unit of agent execution. `IAgentTurnService`
 * owns one round at a time — it mints the turn handle (`id`, `abortController`,
 * `ready`, `result`), records the launch, and exposes the lifecycle hooks that
 * collaborators hang behavior on:
 *
 *   - `onLaunched` fires when a turn is launched (with the fresh handle).
 *   - `onEnded` fires when the round finishes (with the terminal `TurnResult`).
 *   - `turn.ready` resolves once the loop reaches its first `beforeStep`.
 *   - `turn.result` resolves with the reason the round ended.
 *
 * `IAgentLoopService` is the engine *inside* the turn: its `runTurn(turn)`
 * drives the step loop (`beforeStep` → LLM → `afterStep` → …) and returns the
 * `TurnResult` the turn service then publishes through `onEnded`. The turn
 * service registers a hook on the loop's `beforeStep` to resolve `turn.ready`,
 * so the two services meet at the loop hooks rather than knowing each other's
 * internals.
 *
 * Wiring: the real composition root (`_harness`) provides every collaborator,
 * including the real `IAgentTurnService` and `IAgentRecordService`. The only
 * collaborator we substitute is `IAgentLoopService`, seeded via `agentSeeds`
 * with a tiny in-memory loop so we can launch a real turn and observe the full
 * lifecycle without booting an LLM. We spy on the real record service's
 * `append` / `signal` to observe the `turn.launch` / `turn.started` /
 * `turn.ended` traffic.
 *
 * Prerequisites: example 01 (container & scope tree); the `async-tasks` example
 * for the `onEnded` hook shape.
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/turn-loop.example.ts
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ServiceIdentifier } from '#/_base/di/instantiation';
import { IAgentLoopService } from '#/agent/loop';
import { IAgentRecordService } from '#/agent/record';
import {
  IAgentTurnService,
  type Turn,
  type TurnContextOverflowContext,
  type TurnEndedContext,
  type TurnResult,
  type TurnStepContext,
  type TurnStepUsageContext,
} from '#/agent/turn';
import { OrderedHookSlot } from '#/hooks';

import { createSliceHost, type SliceHost } from './_harness';

/**
 * Build an in-memory `IAgentLoopService` whose step-loop hooks are real
 * `OrderedHookSlot`s. The real `AgentLoopService` registers a
 * `turn-before-step-event` anchor in `beforeStep`, and `AgentTurnService`
 * orders its ready-resolving hook `{ before: 'turn-before-step-event' }` — so
 * we register the same anchor here, otherwise the turn service's constructor
 * throws on the missing ordering target.
 */
function makeLoop(runTurn: (turn: Turn) => Promise<TurnResult>): IAgentLoopService {
  const beforeStep = new OrderedHookSlot<TurnStepContext>();
  beforeStep.register('turn-before-step-event', async (_ctx, next) => {
    await next();
  });
  return {
    _serviceBrand: undefined,
    hooks: {
      beforeStep,
      onStepUsage: new OrderedHookSlot<TurnStepUsageContext>(),
      afterStep: new OrderedHookSlot<TurnStepContext>(),
      onContextOverflow: new OrderedHookSlot<TurnContextOverflowContext>(),
    },
    runTurn,
  };
}

/**
 * A loop whose `runTurn` resolves the in-flight turn only when `finish` is
 * called. `started` resolves once the turn service has actually entered
 * `runTurn` (which happens after the async user-prompt hook step), so callers
 * must await it before calling `finish`.
 */
function controlledLoop(): {
  loop: IAgentLoopService;
  started: Promise<void>;
  finish: (result: TurnResult) => void;
} {
  let finish!: (result: TurnResult) => void;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const loop = makeLoop(
    () =>
      new Promise<TurnResult>((resolve) => {
        finish = resolve;
        resolveStarted();
      }),
  );
  return { loop, started, finish: (result) => finish(result) };
}

/** A loop that drives one `beforeStep` → `afterStep` cycle, mimicking the real step loop. */
function stepDrivingLoop(): IAgentLoopService {
  let loop!: IAgentLoopService;
  loop = makeLoop(async (turn) => {
    await loop.hooks.beforeStep.run({ turn, continueTurn: false });
    await loop.hooks.afterStep.run({ turn, continueTurn: false });
    return { reason: 'completed' };
  });
  return loop;
}

describe('turn-loop slice (turn lifecycle + step loop)', () => {
  let host: SliceHost;
  afterEach(() => {
    host?.dispose();
    vi.restoreAllMocks();
  });

  function setUp(loop: IAgentLoopService) {
    // Isolate the real file-backed services (record log, storage) in a per-test
    // home so concurrent example files never contend on the same on-disk paths.
    const caseDir = join(process.env['KIMI_CODE_HOME']!, randomUUID());
    mkdirSync(caseDir, { recursive: true });
    host = createSliceHost({
      homeDir: caseDir,
      // Substitute only the loop engine; the real turn service and record
      // service run end-to-end for real.
      agentSeeds: [[IAgentLoopService as ServiceIdentifier<unknown>, loop]],
    });
    // Resolve the real record service first and instrument it; the turn service
    // is constructed lazily and will pick up the same singleton.
    const records = host.agent.accessor.get(IAgentRecordService);
    const appended: Array<{ type: string; turnId?: number }> = [];
    const signaled: Array<{ type: string; reason?: string }> = [];
    vi.spyOn(records, 'append').mockImplementation((r) => {
      appended.push(r as { type: string; turnId?: number });
    });
    vi.spyOn(records, 'signal').mockImplementation((e) => {
      signaled.push(e as { type: string; reason?: string });
    });
    const turn = host.agent.accessor.get(IAgentTurnService);
    return { turn, appended, signaled };
  }

  it('launching a turn fires onLaunched, returns the handle, and records turn.launch', async () => {
    const loop = makeLoop(async () => ({ reason: 'completed' }));
    const { turn, appended } = setUp(loop);

    const launched: Turn[] = [];
    turn.hooks.onLaunched.register('observe', async (ctx, next) => {
      launched.push(ctx.turn);
      await next();
    });

    const handle = turn.launch({ kind: 'user' });

    // The handle is exposed synchronously and the turn is now the active round.
    expect(handle.id).toBe(0);
    expect(handle.abortController).toBeInstanceOf(AbortController);
    expect(turn.getActiveTurn()).toBe(handle);

    const result = await handle.result;
    expect(result).toEqual({ reason: 'completed' });

    expect(launched).toEqual([handle]);
    expect(appended).toContainEqual(expect.objectContaining({ type: 'turn.launch', turnId: 0 }));
  });

  it('drives the step loop hooks and resolves turn.ready on the first beforeStep', async () => {
    const loop = stepDrivingLoop();
    const { turn } = setUp(loop);

    const steps: string[] = [];
    loop.hooks.beforeStep.register('observe', async (_ctx, next) => {
      steps.push('beforeStep');
      await next();
    });
    loop.hooks.afterStep.register('observe', async (_ctx, next) => {
      steps.push('afterStep');
      await next();
    });

    const handle = turn.launch({ kind: 'user' });
    await handle.result;

    // The loop drove one step cycle in order.
    expect(steps).toEqual(['beforeStep', 'afterStep']);
    // The turn service's beforeStep hook resolves `turn.ready`.
    await expect(handle.ready).resolves.toBeUndefined();
  });

  it('fires onEnded with the result and clears the active turn when the loop completes', async () => {
    const loop = makeLoop(async () => ({ reason: 'completed' }));
    const { turn, signaled } = setUp(loop);

    const ended: TurnEndedContext[] = [];
    turn.hooks.onEnded.register('observe', async (ctx, next) => {
      ended.push(ctx);
      await next();
    });

    const handle = turn.launch({ kind: 'user' });
    await handle.result;

    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ turn: handle, result: { reason: 'completed' } });

    // State transitions: the round is over, the slot is free, the reason is remembered.
    expect(turn.getActiveTurn()).toBeUndefined();
    expect(turn.lastEndedReason()).toBe('completed');

    const types = signaled.map((e) => e.type);
    expect(types).toContain('turn.started');
    expect(types).toContain('turn.ended');
    expect(signaled.find((e) => e.type === 'turn.ended')).toMatchObject({ reason: 'completed' });
  });

  it('rejects a second launch while a turn is active, then frees the slot when it ends', async () => {
    const { loop, started, finish } = controlledLoop();
    const { turn } = setUp(loop);

    const first = turn.launch({ kind: 'user' });
    expect(turn.getActiveTurn()).toBe(first);

    expect(() => turn.launch({ kind: 'user' })).toThrow(
      /Cannot launch a new turn while turn \d+ is active/,
    );

    // Wait until the loop's runTurn has actually been entered, then let the
    // in-flight turn finish so the slot is released.
    await started;
    finish({ reason: 'completed' });
    await first.result;

    expect(turn.getActiveTurn()).toBeUndefined();
  });
});
