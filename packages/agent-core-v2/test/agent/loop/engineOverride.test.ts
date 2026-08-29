import { afterEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IEngineOverrideService, type TurnEngine, type TurnEngineInput } from '#/agent/loop/engineOverride';
import type { ContentPart } from '#/kosong/contract/message';
import { emptyUsage } from '#/kosong/contract/usage';

import {
  appService,
  createTestAgent,
  permissionModeServices,
  type TestAgentContext,
  type TestAgentServiceOverride,
} from '../../harness';
import { makeEchoTool, registerTool } from './helpers';

function emitted(ctx: TestAgentContext, event: string): Array<Record<string, unknown>> {
  return ctx.allEvents
    .filter((entry) => entry.type === '[rpc]' && entry.event === event)
    .map((entry) => entry.args as Record<string, unknown>);
}

function createTestAgentWithEngine(
  engine: TurnEngine,
  ...overrides: TestAgentServiceOverride[]
): TestAgentContext {
  return createTestAgent(
    appService(IEngineOverrideService, { getEngine: () => engine }),
    ...overrides,
  );
}

describe('external engine override', () => {
  let ctx: TestAgentContext | undefined;
  let engineInput: TurnEngineInput | undefined;
  let calls: number;

  afterEach(async () => {
    if (ctx !== undefined) {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  it('drives a whole turn through the external engine and reports events', async () => {
    calls = 0;
    engineInput = undefined;
    const engine: TurnEngine = async (input) => {
      calls += 1;
      engineInput = input;
      await input.dispatchEvent({ type: 'step.begin', uuid: 'step-1', turnId: String(input.turnId), step: 1 });
      await input.dispatchEvent({
        type: 'content.part',
        uuid: 'part-1',
        turnId: String(input.turnId),
        step: 1,
        stepUuid: 'step-1',
        part: { type: 'text', text: 'engine says hi' },
      });
      await input.dispatchEvent({
        type: 'step.end',
        uuid: 'step-1',
        turnId: String(input.turnId),
        step: 1,
        usage: emptyUsage(),
      });
      return {
        stopReason: 'completed',
        steps: 1,
        usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      };
    };

    ctx = createTestAgentWithEngine(engine);
    void ctx.restoreRuntimes();
    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await end;

    expect(calls).toBe(1);
    expect(engineInput).toBeDefined();

    // The prompt must reach the engine's message projection.
    const messages = await engineInput!.buildMessages();
    expect(
      messages.some(
        (m) => m.role === 'user' && m.content.some((p) => p.type === 'text' && p.text === 'Hello'),
      ),
    ).toBe(true);

    // Engine-dispatched events land in the context transcript.
    const context = ctx.get(IAgentContextMemoryService).get();
    expect(
      context.some((m) => m.content.some((p) => p.type === 'text' && p.text.includes('engine says hi'))),
    ).toBe(true);

    // Step lifecycle UI events are emitted with the engine's usage.
    expect(emitted(ctx, 'turn.step.started')).toHaveLength(1);
    const completed = emitted(ctx, 'turn.step.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.['usage']).toMatchObject({ output: 5, inputOther: 10 });
    // Text streaming reaches the UI via the assistant delta bridge.
    expect(emitted(ctx, 'assistant.delta').some((e) => e['delta'] === 'engine says hi')).toBe(true);
  });

  it('executes tools through toolExecutor inside the engine turn', async () => {
    calls = 0;
    engineInput = undefined;
    const tool = makeEchoTool();
    let toolOutcome: { output: string | readonly ContentPart[]; isError?: boolean } | undefined;

    const engine: TurnEngine = async (input) => {
      calls += 1;
      engineInput = input;
      await input.dispatchEvent({ type: 'step.begin', uuid: 'step-1', turnId: String(input.turnId), step: 1 });
      await input.dispatchEvent({
        type: 'tool.call',
        uuid: 'tc-1',
        turnId: String(input.turnId),
        step: 1,
        stepUuid: 'step-1',
        toolCallId: 'call-1',
        name: 'echo',
        args: { text: 'roundtrip' },
      });
      toolOutcome = await input.executeTool(
        { type: 'function', id: 'call-1', name: 'echo', arguments: '{"text":"roundtrip"}' },
        { signal: input.signal, turnId: input.turnId },
      );
      await input.dispatchEvent({
        type: 'tool.result',
        parentUuid: 'tc-1',
        toolCallId: 'call-1',
        result: { output: toolOutcome?.output ?? '' },
      });
      await input.dispatchEvent({
        type: 'step.end',
        uuid: 'step-1',
        turnId: String(input.turnId),
        step: 1,
        usage: emptyUsage(),
      });
      return { stopReason: 'completed', steps: 1, usage: emptyUsage() };
    };

    ctx = createTestAgentWithEngine(engine, permissionModeServices('yolo'));
    registerTool(ctx, tool);
    void ctx.restoreRuntimes();
    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'use echo' }] });
    await end;

    expect(calls).toBe(1);
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0]?.args).toEqual({ text: 'roundtrip' });
    expect(toolOutcome?.output).toBe('roundtrip');
  });

  it('falls back to the JS loop when no engine is provided', async () => {
    ctx = createTestAgent();
    void ctx.restoreRuntimes();
    ctx.mockNextResponse({ type: 'text', text: 'js turn' });
    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await end;
    expect(emitted(ctx, 'assistant.delta').some((e) => e['delta'] === 'js turn')).toBe(true);
  });

  it('runs the onWillBeginStep injection gate before driving the engine', async () => {
    const engine: TurnEngine = async (input) => {
      await input.dispatchEvent({ type: 'step.begin', uuid: 'step-1', turnId: String(input.turnId), step: 1 });
      await input.dispatchEvent({
        type: 'step.end',
        uuid: 'step-1',
        turnId: String(input.turnId),
        step: 1,
        usage: emptyUsage(),
      });
      return { stopReason: 'completed', steps: 1, usage: emptyUsage() };
    };

    ctx = createTestAgentWithEngine(engine);
    void ctx.restoreRuntimes();

    const loop = ctx.get(IAgentLoopService);
    const hook = loop.hooks.onWillBeginStep.register(
      'test-injector',
      async (context) => {
        if (!context.firstStepOfTurn) return;
        ctx
          .get(IAgentContextMemoryService)
          .append({
            role: 'user',
            content: [{ type: 'text', text: '<system-reminder>\nengine-path injection\n</system-reminder>' }],
            toolCalls: [],
          });
      },
    );

    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await end;
    hook.dispose();

    expect(emitted(ctx, 'turn.step.started')).toHaveLength(1);

    const context = ctx.get(IAgentContextMemoryService).get();
    expect(
      context.some(
        (m) =>
          m.content.some(
            (p) => p.type === 'text' && p.text.includes('engine-path injection'),
          ),
      ),
    ).toBe(true);
  });

  it('drives a multi-step turn with tool round-trips then reports events', async () => {
    const tool = makeEchoTool();
    let stepCount = 0;

    const engine: TurnEngine = async (input) => {
      for (let step = 1; step <= 2; step += 1) {
        stepCount += 1;
        await input.dispatchEvent({ type: 'step.begin', uuid: `step-${step}`, turnId: String(input.turnId), step });
        if (step === 1) {
          await input.dispatchEvent({
            type: 'tool.call',
            uuid: 'tc-1',
            turnId: String(input.turnId),
            step,
            stepUuid: `step-${step}`,
            toolCallId: 'call-1',
            name: 'echo',
            args: { text: 'multi' },
          });
          const outcome = await input.executeTool(
            { type: 'function', id: 'call-1', name: 'echo', arguments: '{"text":"multi"}' },
            { signal: input.signal, turnId: input.turnId },
          );
          await input.dispatchEvent({
            type: 'tool.result',
            parentUuid: 'tc-1',
            toolCallId: 'call-1',
            result: { output: outcome.output },
          });
        }
        await input.dispatchEvent({
          type: 'content.part',
          uuid: `part-${step}`,
          turnId: String(input.turnId),
          step,
          stepUuid: `step-${step}`,
          part: { type: 'text', text: `engine step ${step}` },
        });
        await input.dispatchEvent({
          type: 'step.end',
          uuid: `step-${step}`,
          turnId: String(input.turnId),
          step,
          usage: emptyUsage(),
        });
      }
      return { stopReason: 'completed', steps: 2, usage: emptyUsage() };
    };

    ctx = createTestAgentWithEngine(engine, permissionModeServices('yolo'));
    registerTool(ctx, tool);
    void ctx.restoreRuntimes();
    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });
    await end;

    expect(stepCount).toBe(2);
    expect(tool.calls).toHaveLength(1);
    expect(tool.calls[0]?.args).toEqual({ text: 'multi' });
    expect(emitted(ctx, 'turn.step.started')).toHaveLength(1);
    expect(emitted(ctx, 'assistant.delta').map((e) => e['delta'])).toEqual([
      'engine step 1',
      'engine step 2',
    ]);
  });
});
