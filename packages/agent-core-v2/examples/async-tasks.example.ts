/**
 * Scenario: the **async-tasks** slice — long-running work owned by an Agent-scope service.
 *
 * Concept taught: background tasks, cron tasks, and swarm (multi-agent) runs
 * all share one shape — an *asynchronous task whose state and output are owned
 * by an Agent-scope service*, decoupled from whoever triggered it. The caller
 * fires and forgets; the service retains the task, drives its lifecycle, and
 * records the outcome.
 *
 *   - `IAgentBackgroundService` — owns running/restored background tasks and a
 *     bounded output ring.
 *   - `IAgentCronService` — owns the scheduled cron task set and its fire loop.
 *   - `IAgentSwarmService` — owns swarm-mode state for multi-agent runs and
 *     auto-exits when the turn ends.
 *
 * All three are bound at Agent scope, but background and cron each inject ~9
 * collaborators. We demonstrate the shared shape with `IAgentSwarmService`
 * because it is the lightest of the three. Its auto-exit is driven by the real
 * `IAgentTurnService` `onEnded` hook — the same path the agent loop uses.
 *
 * Wiring: the real composition root (`_harness`) provides every collaborator;
 * we spy on the real `IAgentRecordService` only to observe the task records.
 *
 * Prerequisites: example 01 (container & scope tree).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/async-tasks.example.ts
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentRecordService } from '#/agent/record';
import { IAgentSwarmService } from '#/agent/swarm';
import {
  IAgentTurnService,
  type Turn,
  type TurnResult,
} from '#/agent/turn';

import { createSliceHost, type SliceHost } from './_harness';

function fakeTurn(id = 1): Turn {
  return {
    id,
    abortController: new AbortController(),
    ready: Promise.resolve(),
    result: Promise.resolve<TurnResult>({ reason: 'completed' }),
  } as Turn;
}

describe('async-tasks slice (Agent-scope swarm task)', () => {
  let host: SliceHost;
  afterEach(() => host?.dispose());

  function setUp() {
    host = createSliceHost({ homeDir: process.env['KIMI_CODE_HOME']! });
    const records = host.agent.accessor.get(IAgentRecordService);
    const appended: Array<{ type: string }> = [];
    vi.spyOn(records, 'append').mockImplementation((r) => {
      appended.push(r as { type: string });
    });
    const swarm = host.agent.accessor.get(IAgentSwarmService);
    const turn = host.agent.accessor.get(IAgentTurnService);
    const types = () => appended.map((r) => r.type).filter((t) => t.startsWith('swarm_mode'));
    return { swarm, turn, types };
  }

  it('owns the swarm task state and records enter/exit', () => {
    const { swarm, types } = setUp();

    expect(swarm.isActive).toBe(false);
    swarm.enter('manual');
    expect(swarm.isActive).toBe(true);
    swarm.exit();
    expect(swarm.isActive).toBe(false);

    expect(types()).toEqual(['swarm_mode.enter', 'swarm_mode.exit']);
  });

  it('treats a duplicate enter as a no-op (guards task state)', () => {
    const { swarm, types } = setUp();

    swarm.enter('manual');
    swarm.enter('task');

    expect(swarm.isActive).toBe(true);
    expect(types()).toEqual(['swarm_mode.enter']);
  });

  it('auto-exits a task-triggered swarm run when the turn ends', async () => {
    const { swarm, turn, types } = setUp();

    swarm.enter('task');
    expect(swarm.isActive).toBe(true);

    await turn.hooks.onEnded.run({ turn: fakeTurn(), result: { reason: 'completed' } });

    expect(swarm.isActive).toBe(false);
    expect(types()).toEqual(['swarm_mode.enter', 'swarm_mode.exit']);
  });

  it('keeps a manual swarm run active across turn end (rule flips with trigger)', async () => {
    const { swarm, turn, types } = setUp();

    swarm.enter('manual');
    await turn.hooks.onEnded.run({ turn: fakeTurn(), result: { reason: 'completed' } });

    expect(swarm.isActive).toBe(true);
    expect(types()).toEqual(['swarm_mode.enter']);
  });
});
