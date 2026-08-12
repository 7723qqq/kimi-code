/**
 * Compaction stuck-guard tests (ported from Reasonix's
 * `TestCacheHitSurvivesTooSmallWindow`).
 *
 * When the context window is too small for the fold to bring the context back
 * under the trigger threshold, every subsequent step re-triggers compaction —
 * each round rewrites the prompt-cache prefix and craters the hit rate. The
 * guard detects "compaction did not solve the pressure" (context still over
 * the trigger right after a compaction), emits `compaction.stuck` and pauses
 * auto-compaction until a manual compaction succeeds.
 */

import { describe, expect, it } from 'vitest';

import { IEventBus } from '#/app/event/eventBus';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import type { CompactionStuckEvent } from '#/agent/fullCompaction/compactionOps';
import { testAgent } from '../../harness';

const CATALOGUED_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  baseUrl: 'https://api.example/v1',
  model: 'kimi-code',
} as const;
// The window must stay above the harness's fixed full-request overhead
// (system prompt + tool schemas): the post-compaction size is measured on
// the full-request basis, so a smaller window could never drop below the
// trigger and the guard could never disarm (see the same note in
// fullCompaction.test.ts around the one-round full-history case).
const STUCK_GUARD_MAX_CONTEXT_TOKENS = 26_000;
const SMALL_WINDOW_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: STUCK_GUARD_MAX_CONTEXT_TOKENS,
} as const;
const SNAPSHOT_VISIBLE_TOOLS = [
  'Agent',
  'AgentSwarm',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EnterPlanMode',
  'ExitPlanMode',
] as const;

function stuckFlag(ctx: ReturnType<typeof testAgent>): boolean {
  const svc = ctx.get(IAgentFullCompactionService) as unknown as {
    autoCompactionStuck?: boolean;
  };
  return svc.autoCompactionStuck === true;
}

function nextStuck(ctx: ReturnType<typeof testAgent>): Promise<CompactionStuckEvent> {
  const bus = ctx.get(IEventBus);
  return new Promise((resolve) => {
    const disposable = bus.subscribe('compaction.stuck', (event) => {
      disposable.dispose();
      resolve(event as CompactionStuckEvent);
    });
  });
}

describe('compaction stuck guard', () => {
  it('emits compaction.stuck and pauses auto-compaction when a round leaves the context over the trigger', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: SMALL_WINDOW_CAPABILITIES,
      tools: SNAPSHOT_VISIBLE_TOOLS,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);

    // A summary as large as the history: after this round the context is
    // still over the trigger -> stuck.
    const stuck = nextStuck(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'huge summary that does not shrink the context '.repeat(2000) });
    await ctx.rpc.beginCompaction({});
    const stuckEvent = await stuck;

    expect(stuckEvent).toMatchObject({
      type: 'compaction.stuck',
      tokensBefore: expect.any(Number),
      tokensAfter: expect.any(Number),
      progressTokens: expect.any(Number),
    });
    // The event fields share the full-request basis (system prompt + tool
    // schemas + messages): the fold replaced the history with a summary at
    // least as large, so the post-compaction request cannot have shrunk
    // below the pre-compaction one.
    expect(stuckEvent.tokensAfter).toBeGreaterThanOrEqual(stuckEvent.tokensBefore);
    // On the shared basis, progress is exactly the before/after delta.
    expect(stuckEvent.progressTokens).toBe(stuckEvent.tokensBefore - stuckEvent.tokensAfter);
    // The guard fires exactly when the context is still over the trigger
    // after the round.
    expect(stuckEvent.tokensAfter).toBeGreaterThanOrEqual(STUCK_GUARD_MAX_CONTEXT_TOKENS * 0.85);
    expect(stuckFlag(ctx)).toBe(true);
  });

  it('clears the stuck flag when a later compaction succeeds', async () => {
    const ctx = testAgent();
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: SMALL_WINDOW_CAPABILITIES,
      tools: SNAPSHOT_VISIBLE_TOOLS,
    });
    ctx.appendExchange(1, 'old user one', 'old assistant one', 20);
    ctx.appendExchange(2, 'old user two', 'old assistant two', 40);
    ctx.appendExchange(3, 'recent user three', 'recent assistant three', 120);

    // Round 1: no-progress compaction (huge summary) -> stuck.
    const stuck = nextStuck(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'huge summary that does not shrink the context '.repeat(2000) });
    await ctx.rpc.beginCompaction({});
    await stuck;
    expect(stuckFlag(ctx)).toBe(true);

    // Round 2: a concise summary fits the window, the context drops below the
    // trigger again -> the guard disarms.
    const completed = ctx.once('compaction.completed');
    ctx.mockNextResponse({ type: 'text', text: 'Concise summary.' });
    await ctx.rpc.beginCompaction({});
    await completed;
    expect(stuckFlag(ctx)).toBe(false);
  });
});