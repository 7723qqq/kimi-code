/**
 * `loop` domain — turn-level lifecycle invariants.
 *
 * Ported from v1 `packages/agent-core/test/loop/turn-lifecycle.e2e.test.ts`
 * plus the lifecycle portions of `error-paths.e2e.test.ts` / `api-shape.e2e.test.ts`.
 * Drives the loop through its public contract (scripted LLM responses) and
 * asserts against public outputs (`turn.ended` / `turn.step.completed`
 * events, persisted `usage.record`, tool invocation records).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentProfileService, IAgentUsageService } from '#/index';
import type { generate as kosongGenerate } from '#/kosong/contract/generate';
import { permissionModeServices, type TestAgentContext } from '../../harness';

import { createLoopTestAgent, makeEchoTool, nextTurnMessage } from './helpers';

type GenerateFn = typeof kosongGenerate;

function stepEvents(ctx: TestAgentContext, event: string): Array<Record<string, unknown>> {
  return ctx.allEvents
    .filter((entry) => entry.type === '[rpc]' && entry.event === event)
    .map((entry) => entry.args as Record<string, unknown>);
}

function rpcEvent(ctx: TestAgentContext, event: string): Record<string, unknown> | undefined {
  const entry = ctx.allEvents.find(
    (candidate) => candidate.type === '[rpc]' && candidate.event === event,
  );
  return entry?.args as Record<string, unknown> | undefined;
}

describe('Agent loop — turn lifecycle', () => {
  let ctx: TestAgentContext;

  beforeEach(() => {
    ctx = createLoopTestAgent();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('returns end_turn after a single non-tool step', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'hello' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(rpcEvent(ctx, 'turn.ended')).toMatchObject({ reason: 'completed' });
    const completed = stepEvents(ctx, 'turn.step.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      step: 1,
      finishReason: 'end_turn',
      providerFinishReason: 'completed',
    });
  });

  it('continues across tool_use steps until end_turn', async () => {
    const echo = makeEchoTool();
    ctx = createLoopTestAgent(permissionModeServices('yolo'));
    ctx.get(IAgentToolRegistryService).register(echo);
    ctx.get(IAgentProfileService).update({ activeToolNames: ['echo'] });

    ctx.mockNextResponse(
      { type: 'text', text: 'calling echo' },
      { type: 'function', id: 'tc-1', name: 'echo', arguments: '{"text":"hi"}' },
    );
    ctx.mockNextResponse(
      { type: 'function', id: 'tc-2', name: 'echo', arguments: '{"text":"again"}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'echo twice' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(3);
    expect(rpcEvent(ctx, 'turn.ended')).toMatchObject({ reason: 'completed' });
    expect(stepEvents(ctx, 'turn.step.completed').map((e) => e['step'])).toEqual([1, 2, 3]);
    expect(echo.calls.map((call) => call.id)).toEqual(['tc-1', 'tc-2']);
  });

  it('reports max_tokens when the provider signals truncation', async () => {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'partial answer' }],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(rpcEvent(ctx, 'turn.ended')).toMatchObject({ reason: 'completed' });
    expect(stepEvents(ctx, 'turn.step.completed')[0]).toMatchObject({
      step: 1,
      finishReason: 'max_tokens',
      providerFinishReason: 'truncated',
      rawFinishReason: 'length',
    });
  });

  it('fails the turn when the provider reports a filtered response', async () => {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'blocked' }],
      finishReason: 'filtered',
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(rpcEvent(ctx, 'turn.ended')).toMatchObject({
      reason: 'failed',
      error: { code: 'provider.filtered' },
    });
    expect(stepEvents(ctx, 'turn.step.completed')[0]).toMatchObject({
      finishReason: 'filtered',
      providerFinishReason: 'filtered',
    });
  });

  it('treats provider tool_calls without tool call structure as other', async () => {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'done' }],
      finishReason: 'tool_calls',
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(rpcEvent(ctx, 'turn.ended')).toMatchObject({ reason: 'completed' });
    expect(stepEvents(ctx, 'turn.step.completed')[0]).toMatchObject({
      finishReason: 'other',
      providerFinishReason: 'tool_calls',
    });
  });

  it('throws loop.max_steps_exceeded when steps reach maxSteps', async () => {
    const echo = makeEchoTool();
    ctx = createLoopTestAgent(
      permissionModeServices('yolo'),
      { initialConfig: { loopControl: { maxStepsPerTurn: 2 } } },
    );
    ctx.get(IAgentToolRegistryService).register(echo);
    ctx.get(IAgentProfileService).update({ activeToolNames: ['echo'] });

    ctx.mockNextResponse(
      { type: 'function', id: 'a', name: 'echo', arguments: '{"text":"1"}' },
    );
    ctx.mockNextResponse(
      { type: 'function', id: 'b', name: 'echo', arguments: '{"text":"2"}' },
    );

    const turnEnded = ctx.untilTurnEnd();
    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('go')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'failed', steps: 2 });
    await turnEnded;

    expect(rpcEvent(ctx, 'turn.ended')).toMatchObject({
      reason: 'failed',
      error: { code: 'loop.max_steps_exceeded', details: { maxSteps: 2 } },
      interruptReason: 'max_steps',
    });
    // No active step exists when the budget check throws, so the failure
    // surfaces only through `turn.ended` — no step.interrupted event.
    expect(stepEvents(ctx, 'turn.step.interrupted')).toHaveLength(0);
  });

  it('does not enforce a max step limit when maxStepsPerTurn is 0', async () => {
    const echo = makeEchoTool();
    ctx = createLoopTestAgent(
      permissionModeServices('yolo'),
      { initialConfig: { loopControl: { maxStepsPerTurn: 0 } } },
    );
    ctx.get(IAgentToolRegistryService).register(echo);
    ctx.get(IAgentProfileService).update({ activeToolNames: ['echo'] });

    ctx.mockNextResponse(
      { type: 'function', id: 'a', name: 'echo', arguments: '{"text":"1"}' },
    );
    ctx.mockNextResponse(
      { type: 'function', id: 'b', name: 'echo', arguments: '{"text":"2"}' },
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const turnEnded = ctx.untilTurnEnd();
    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('go')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed', steps: 3 });
    await turnEnded;
    expect(echo.calls.map((call) => call.id)).toEqual(['a', 'b']);
  });

  it('aggregates usage across steps', async () => {
    const usages = [
      { inputOther: 70, output: 50, inputCacheRead: 10, inputCacheCreation: 20 },
      { inputOther: 4, output: 3, inputCacheRead: 1, inputCacheCreation: 2 },
    ];
    let requestIndex = 0;
    const generate: GenerateFn = async () => {
      const usage = usages[requestIndex];
      if (usage === undefined) throw new Error('Unexpected model request');
      requestIndex += 1;
      return {
        id: `usage-${String(requestIndex)}`,
        message: {
          role: 'assistant',
          content: [],
          toolCalls:
            requestIndex === 1
              ? [
                  {
                    type: 'function',
                    id: 'tc-usage',
                    name: 'echo',
                    arguments: '{"text":"a"}',
                  },
                ]
              : [],
        },
        usage,
        finishReason: requestIndex === 1 ? 'tool_calls' : 'completed',
        rawFinishReason: requestIndex === 1 ? 'tool_calls' : 'stop',
      };
    };

    const echo = makeEchoTool();
    ctx = createLoopTestAgent(
      { generate },
      permissionModeServices('yolo'),
    );
    ctx.get(IAgentToolRegistryService).register(echo);
    ctx.get(IAgentProfileService).update({ activeToolNames: ['echo'] });

    const turnEnded = ctx.untilTurnEnd();
    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('aggregate')).assigned)
      .turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'completed', steps: 2 });
    await turnEnded;

    expect(ctx.get(IAgentUsageService).status().total).toEqual({
      inputOther: 74,
      output: 53,
      inputCacheRead: 11,
      inputCacheCreation: 22,
    });
  });
});
