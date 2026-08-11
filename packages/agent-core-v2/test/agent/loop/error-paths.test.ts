/**
 * `loop` domain — error propagation contract.
 *
 * Ported from v1 `packages/agent-core/test/loop/error-paths.e2e.test.ts` and
 * the hook-failure portions of `hooks.e2e.test.ts`. AbortError-shaped
 * failures converge to `cancelled` and never fail the caller; every other
 * step failure surfaces through `turn.ended{reason:'failed'}` with exactly
 * one `turn.step.interrupted{reason:'error'}` before it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { permissionModeServices, type TestAgentContext } from '../../harness';

import { createLoopTestAgent, nextTurnMessage } from './helpers';

function rpcEvents(ctx: TestAgentContext, event: string): Array<Record<string, unknown>> {
  return ctx.allEvents
    .filter((entry) => entry.type === '[rpc]' && entry.event === event)
    .map((entry) => entry.args as Record<string, unknown>);
}

function interruptedReasons(ctx: TestAgentContext): unknown[] {
  return rpcEvents(ctx, 'turn.step.interrupted').map((e) => e['reason']);
}

describe('Agent loop — error paths', () => {
  let ctx: TestAgentContext;

  beforeEach(() => {
    ctx = createLoopTestAgent();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('fails the turn on an LLM error with one turn.step.interrupted{reason:"error"}', async () => {
    const loop = ctx.get(IAgentLoopService);

    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'failed' });

    expect(rpcEvents(ctx, 'turn.ended')[0]).toMatchObject({ reason: 'failed' });
    expect(interruptedReasons(ctx)).toEqual(['error']);
    const interrupted = rpcEvents(ctx, 'turn.step.interrupted')[0];
    expect(interrupted?.['step']).toBe(1);
    expect(String(interrupted?.['message'])).toContain('Unexpected generate call');
  });

  it('emits turn.step.interrupted exactly once per failure', async () => {
    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('Hello')).assigned)
      .turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'failed' });

    expect(interruptedReasons(ctx)).toEqual(['error']);
  });

  it('does not emit turn.step.interrupted for a normal end_turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('Hello')).assigned)
      .turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    expect(interruptedReasons(ctx)).toEqual([]);
    expect(rpcEvents(ctx, 'turn.ended')[0]).toMatchObject({ reason: 'completed' });
  });

  it('converges an AbortError thrown by a step hook to cancelled (no failed turn)', async () => {
    const loop = ctx.get(IAgentLoopService);
    loop.hooks.onWillBeginStep.register('test-abort-from-hook', async () => {
      const error = new Error('aborted from hook');
      error.name = 'AbortError';
      throw error;
    });

    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

    expect(ctx.llmCalls).toHaveLength(0);
    expect(rpcEvents(ctx, 'turn.ended')[0]).toMatchObject({
      reason: 'cancelled',
      interruptReason: 'aborted',
    });
  });

  it('fails the turn when a step hook throws a non-abort error', async () => {
    const loop = ctx.get(IAgentLoopService);
    loop.hooks.onWillBeginStep.register('test-hook-crash', async () => {
      throw new Error('hook crashed');
    });

    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'failed' });

    expect(ctx.llmCalls).toHaveLength(0);
    expect(interruptedReasons(ctx)).toEqual(['error']);
    expect(String(rpcEvents(ctx, 'turn.step.interrupted')[0]?.['message'])).toContain(
      'hook crashed',
    );
  });

  it('lets a loop error handler recover a non-context loop error by retrying', async () => {
    const loop = ctx.get(IAgentLoopService);
    let recoveries = 0;
    loop.registerLoopErrorHandler({
      id: 'test-recover-generate-error',
      match: () => true,
      handle: async (hookCtx) => {
        recoveries += 1;
        if (recoveries === 1) {
          ctx.mockNextResponse({ type: 'text', text: 'Recovered.' });
          if (hookCtx.failedDriver !== undefined) {
            hookCtx.retry(hookCtx.failedDriver, { at: 'head' });
            return true;
          }
        }
        return;
      },
    });

    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

    expect(recoveries).toBe(1);
    expect(ctx.llmCalls).toHaveLength(1);
    expect(interruptedReasons(ctx)).toEqual([]);
  });

  it('fails with the error handler error when recovery throws', async () => {
    const loop = ctx.get(IAgentLoopService);
    const recoveryError = new Error('recovery failed');
    loop.registerLoopErrorHandler({
      id: 'test-throw-recovery-error',
      match: () => true,
      handle: async () => {
        throw recoveryError;
      },
    });

    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'failed' });
  });
});
