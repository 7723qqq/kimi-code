import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { IEventBus } from '#/app/event/eventBus';
import type { generate as kosongGenerate } from '#/kosong/contract/generate';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import type { ExecutableTool, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

import { permissionModeServices, type TestAgentContext } from '../../harness';
import { createLoopTestAgent, makeEchoTool, nextTurnMessage, registerTool } from './helpers';

type GenerateFn = typeof kosongGenerate;

function rpcEvents(ctx: TestAgentContext, event: string): Array<Record<string, unknown>> {
  return ctx.allEvents
    .filter((entry) => entry.type === '[rpc]' && entry.event === event)
    .map((entry) => entry.args as Record<string, unknown>);
}

function makeAbortAwareTool(
  name: string,
  onStarted?: () => void,
): ExecutableTool<Record<string, never>> {
  return {
    name,
    description: 'Hangs until aborted.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    resolveExecution: (): ToolExecution => ({
      approvalRule: name,
      execute: async ({ signal }): Promise<ExecutableToolResult> => {
        onStarted?.();
        if (!signal.aborted) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return { output: 'never reached' };
      },
    }),
  };
}

describe('Agent loop — abort handling', () => {
  let ctx: TestAgentContext;

  beforeEach(() => {
    ctx = createLoopTestAgent();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('returns cancelled without throwing when the signal is already aborted on entry', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await ctx.get(IAgentLoopService).run({
      turnId: 0,
      signal: controller.signal,
    });

    expect(result.type).toBe('cancelled');
    if (result.type === 'cancelled') {
      expect(result.steps).toBe(0);
    }
    expect(ctx.llmCalls).toHaveLength(0);
    const stepBegins = ctx.allEvents.filter(
      (entry) =>
        entry.type === '[wire]' &&
        entry.event === 'context.append_loop_event' &&
        (entry.args as { event?: { type?: string } }).event?.type === 'step.begin',
    );
    expect(stepBegins).toHaveLength(0);
  });

  it('returns cancelled when the LLM call itself observes the signal', async () => {
    const loop = ctx.get(IAgentLoopService);
    const subscription = ctx.get(IEventBus).subscribe('assistant.delta', () => {
      loop.cancel();
    });

    ctx.mockNextResponse({ type: 'text', text: 'partial' }, { type: 'text', text: ' more' });
    const turn = (await loop.enqueue(nextTurnMessage('Hello')).assigned).turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(ctx.llmCalls).toHaveLength(1);
    expect(rpcEvents(ctx, 'turn.ended')[0]).toMatchObject({
      reason: 'cancelled',
      interruptReason: 'user_cancelled',
    });
  });

  it('preserves usage already recorded by an earlier step when later steps abort', async () => {
    const usages = [
      { inputOther: 100, output: 50, inputCacheRead: 0, inputCacheCreation: 0 },
      { inputOther: 7, output: 11, inputCacheRead: 0, inputCacheCreation: 0 },
    ];
    let requestIndex = 0;
    const generate: GenerateFn = async () => {
      const usage = usages[requestIndex];
      if (usage === undefined) throw new Error('Unexpected model request');
      requestIndex += 1;
      return {
        id: `abort-usage-${String(requestIndex)}`,
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              type: 'function',
              id: `tc-${String(requestIndex)}`,
              name: requestIndex === 1 ? 'echo' : 'hang',
              arguments: '{}',
            },
          ],
        },
        usage,
        finishReason: 'tool_calls',
        rawFinishReason: 'tool_calls',
      };
    };

    const echo = makeEchoTool();
    const hangStarted = deferredVoid();
    const hang = makeAbortAwareTool('hang', () => hangStarted.resolve());
    ctx = createLoopTestAgent({ generate }, permissionModeServices('yolo'));
    registerTool(ctx, echo);
    registerTool(ctx, hang);

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('run')).assigned).turn;
    await hangStarted.promise;
    ctx.get(IAgentLoopService).cancel(turn.id);
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

    expect(ctx.get(ISessionUsageService).status(ctx.agentContext).total).toEqual({
      inputOther: 107,
      output: 61,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  it('pairs every tool.call with a tool.result when aborted mid-batch', async () => {
    const started = deferredVoid();
    let starts = 0;
    const work = makeAbortAwareTool('work', () => {
      starts += 1;
      if (starts === 1) started.resolve();
    });
    ctx = createLoopTestAgent(permissionModeServices('yolo'));
    registerTool(ctx, work);

    ctx.mockNextResponse(
      { type: 'function', id: 'tc-1', name: 'work', arguments: '{}' },
      { type: 'function', id: 'tc-2', name: 'work', arguments: '{}' },
      { type: 'function', id: 'tc-3', name: 'work', arguments: '{}' },
    );

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('run')).assigned).turn;
    await started.promise;
    ctx.get(IAgentLoopService).cancel(turn.id);
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

    const callIds = rpcEvents(ctx, 'tool.call.started')
      .map((e) => e['toolCallId'])
      .toSorted();
    const resultIds = rpcEvents(ctx, 'tool.result')
      .map((e) => e['toolCallId'])
      .toSorted();
    expect(callIds).toEqual(['tc-1', 'tc-2', 'tc-3']);
    expect(resultIds).toEqual(callIds);
  });

  it('tells the model a running tool was interrupted by the user, not by a system fault', async () => {
    const started = deferredVoid();
    const hang = makeAbortAwareTool('hang', () => started.resolve());
    ctx = createLoopTestAgent(permissionModeServices('yolo'));
    registerTool(ctx, hang);

    ctx.mockNextResponse({ type: 'function', id: 'tc-1', name: 'hang', arguments: '{}' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('run')).assigned).turn;
    await started.promise;
    ctx.get(IAgentLoopService).cancel(turn.id);
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

    const result = rpcEvents(ctx, 'tool.result')[0];
    expect(typeof result?.['output']).toBe('string');
    const output = result?.['output'] as string;
    expect(output).toContain('not a system error');
    expect(output).toContain("wait for the user's next instruction");
  });

  it('does not crash when an aborted turn still has work to drain', async () => {
    const started = deferredVoid();
    const hang = makeAbortAwareTool('hang', () => started.resolve());
    ctx = createLoopTestAgent(permissionModeServices('yolo'));
    registerTool(ctx, hang);

    ctx.mockNextResponse({ type: 'function', id: 'tc-1', name: 'hang', arguments: '{}' });

    const turn = (await ctx.get(IAgentLoopService).enqueue(nextTurnMessage('run')).assigned).turn;
    await started.promise;
    ctx.get(IAgentLoopService).cancel(turn.id);
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

    expect(rpcEvents(ctx, 'turn.ended')).toHaveLength(1);
    expect(rpcEvents(ctx, 'tool.result')).toHaveLength(1);
  });
});

function deferredVoid(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
