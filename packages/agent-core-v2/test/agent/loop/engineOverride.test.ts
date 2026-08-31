import type * as ChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import {
  IEngineOverrideService,
  type AskQuestionWireResult,
  type StateReadWireResult,
  type StateWriteWireResult,
  type TurnEngine,
  type TurnEngineInput,
} from '#/agent/loop/engineOverride';
import { IAgentTaskService, type AgentTask } from '#/agent/task/task';
import { IFlagService } from '#/app/flag/flag';
import { AgentCron } from '#/features/cron/cronAgentRuntime';
import { AgentGoal } from '#/features/goal/goalAgentRuntime';
import { IAgentPlanService } from '#/features/plan/plan';
import { InMemorySkillCatalog } from '#/features/skill/catalog/registry';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { AgentTodo } from '#/features/todo/todoAgentRuntime';
import { IAgentTowerService, TOWER_FLAG_ID } from '#/features/tower/tower';
import type { ContentPart, Message } from '#/kosong/contract/message';
import { emptyUsage } from '#/kosong/contract/usage';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';

import {
  appService,
  createTestAgent,
  execEnvServices,
  permissionModeServices,
  skillServices,
  telemetryServices,
  type TestAgentContext,
  type TestAgentServiceOverride,
} from '../../harness';
import { stubFlag } from '../../app/flag/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { createFakeHostFs, createFakeProcessRunner } from '../../tools/fixtures/fake-exec';
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
    const contextMemory = ctx!.get(IAgentContextMemoryService);
    const hook = loop.hooks.onWillBeginStep.register(
      'test-injector',
      async (context) => {
        if (!context.firstStepOfTurn) return;
        contextMemory.append({
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

  it('runs the onDidFinishStep gate after the engine drives the turn', async () => {
    const finished: Array<{ step: number; firstStepOfTurn: boolean; finishReason: string }> = [];

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
    const hook = loop.hooks.onDidFinishStep.register('test-finish-probe', async (hookCtx, next) => {
      finished.push({
        step: hookCtx.step,
        firstStepOfTurn: hookCtx.firstStepOfTurn,
        finishReason: hookCtx.finishReason,
      });
      await next();
    });

    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await end;
    hook.dispose();

    expect(finished).toHaveLength(1);
    expect(finished[0]!.step).toBe(1);
    expect(finished[0]!.firstStepOfTurn).toBe(true);
    expect(finished[0]!.finishReason).toBe('completed');
  });

  it('drains steered prompts into the engine mid-turn and appends them to context', async () => {
    const drained: Message[][] = [];
    const engine: TurnEngine = async (input) => {
      engineInput = input;
      let steered: readonly Message[] = [];
      for (let i = 0; i < 50 && steered.length === 0; i += 1) {
        steered = (await input.drainSteers?.()) ?? [];
        if (steered.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      drained.push([...steered]);
      drained.push([...(await input.drainSteers?.()) ?? []]);
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
    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.rpc.steer({ input: [{ type: 'text', text: 'Steered!' }] });
    await end;

    expect(drained[0]).toHaveLength(1);
    expect(drained[0]?.[0]).toMatchObject({ role: 'user' });
    expect(drained[0]?.[0]?.content).toEqual([{ type: 'text', text: 'Steered!' }]);
    expect(drained[1]).toHaveLength(0);

    const messages = await engineInput!.buildMessages();
    expect(
      messages.some(
        (m) => m.role === 'user' && m.content.some((p) => p.type === 'text' && p.text === 'Steered!'),
      ),
    ).toBe(true);
  });

  it('settles steered prompts when the engine turn ends', async () => {
    const engine: TurnEngine = async (input) => {
      let steered: readonly Message[] = [];
      for (let i = 0; i < 50 && steered.length === 0; i += 1) {
        steered = (await input.drainSteers?.()) ?? [];
        if (steered.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
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
    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    const prompt = ctx.get(IAgentPromptService);
    const queued = await prompt.enqueue({ message: { role: 'user', content: [{ type: 'text', text: 'Steered!' }], toolCalls: [] } });
    const [steered] = await prompt.steer([queued.id]);
    const completion = steered!.completion;
    await end;
    await expect(completion).resolves.toMatchObject({ promptId: queued.id, state: 'completed' });
  });

  it('runs session-level auto compaction across turns on the engine path', async () => {
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
    ctx.configure({
      modelCapabilities: {
        image_in: true,
        video_in: true,
        audio_in: false,
        thinking: true,
        tool_use: true,
        max_context_tokens: 2_000,
      },
    });

    ctx.appendExchange(1, 'old user one', 'old assistant one', 1_900);
    const tokensBefore = ctx.contextData().tokenCount;
    expect(tokensBefore).toBeGreaterThanOrEqual(1_700);

    ctx.mockNextResponse({ type: 'text', text: 'Cross-turn compaction summary.' });
    const completed = ctx.once('compaction.completed');

    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await end;
    await completed;

    expect(ctx.llmCalls).toHaveLength(1);
    const compactionPrompt = (ctx.llmCalls[0]?.history ?? [])
      .map((message) => message.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'))
      .join('\n');
    expect(compactionPrompt).toContain('first-person handoff note');
    expect(
      ctx
        .contextData()
        .history.some((m) =>
          m.content.some((p) => p.type === 'text' && p.text.includes('Cross-turn compaction summary.')),
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

  it('provides the registered goal snapshot to the engine input', async () => {
    calls = 0;
    engineInput = undefined;
    const engine: TurnEngine = async (input) => {
      calls += 1;
      engineInput = input;
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
    const provider = loop.registerEngineGoalProvider(() => ({
      goalId: 'goal-1',
      objective: 'Do the thing',
      status: 'active',
      tokenBudget: 5000,
      turnBudget: 20,
      wallClockBudgetMs: 60000,
      wallClockMs: 1000,
      tokensUsed: 100,
      turnsUsed: 2,
    }));

    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await end;

    expect(calls).toBe(1);
    expect(engineInput!.getGoal?.()).toMatchObject({
      goalId: 'goal-1',
      objective: 'Do the thing',
      status: 'active',
      tokensUsed: 100,
      turnsUsed: 2,
    });

    provider.dispose();
    expect(engineInput!.getGoal?.()).toBeUndefined();
  });

  it('reports engine telemetry counters from the engine result', async () => {
    const records: TelemetryRecord[] = [];
    const engine: TurnEngine = async (input) => {
      await input.dispatchEvent({ type: 'step.begin', uuid: 'step-1', turnId: String(input.turnId), step: 1 });
      await input.dispatchEvent({
        type: 'step.end',
        uuid: 'step-1',
        turnId: String(input.turnId),
        step: 1,
        usage: emptyUsage(),
      });
      return {
        stopReason: 'completed',
        steps: 2,
        usage: emptyUsage(),
        telemetry: { eventsEmitted: 7, llmRetries: 1 },
      };
    };

    ctx = createTestAgentWithEngine(engine, telemetryServices(recordingTelemetry(records)));
    void ctx.restoreRuntimes();
    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await end;

    const engineTurn = records.find((r) => r.event === 'engine_turn');
    expect(engineTurn?.properties).toMatchObject({
      stop_reason: 'completed',
      steps: 2,
      events_emitted: 7,
      llm_retries: 1,
    });
  });

  it('answers native permission checks through the host permission gate', async () => {
    const decisions: Array<string | undefined> = [];
    const engine: TurnEngine = async (input) => {
      await input.dispatchEvent({ type: 'step.begin', uuid: 'step-1', turnId: String(input.turnId), step: 1 });
      decisions.push(
        (
          await input.checkToolPermission?.({
            type: 'function',
            id: 'call-1',
            name: 'echo',
            arguments: '{"text":"x"}',
          })
        )?.decision,
      );
      decisions.push(
        (
          await input.checkToolPermission?.({
            type: 'function',
            id: 'call-2',
            name: 'not-registered',
            arguments: '{}',
          })
        )?.decision,
      );
      await input.dispatchEvent({
        type: 'step.end',
        uuid: 'step-1',
        turnId: String(input.turnId),
        step: 1,
        usage: emptyUsage(),
      });
      return { stopReason: 'completed', steps: 1, usage: emptyUsage() };
    };

    const tool = makeEchoTool();
    ctx = createTestAgentWithEngine(engine, permissionModeServices('yolo'));
    registerTool(ctx, tool);
    void ctx.restoreRuntimes();
    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await end;

    expect(decisions).toEqual(['allow', 'deny']);
  });
});

describe('external engine × plan mode bridge', () => {
  let activeFs: IHostFileSystem;
  let activeRunner: IHostProcessService;
  let ctx: TestAgentContext | undefined;
  let engineInput: TurnEngineInput | undefined;

  afterEach(async () => {
    if (ctx !== undefined) {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  function delegatingFs(): IHostFileSystem {
    return new Proxy(
      createFakeHostFs({
        mkdir: async () => undefined,
        readText: async () => '',
      }),
      {
        get(_target, prop, receiver) {
          const value = Reflect.get(activeFs, prop, receiver);
          return typeof value === 'function' ? value.bind(activeFs) : value;
        },
      },
    ) as IHostFileSystem;
  }

  function delegatingRunner(): IHostProcessService {
    return new Proxy(createFakeProcessRunner(), {
      get(_target, prop, receiver) {
        const value = Reflect.get(activeRunner, prop, receiver);
        return typeof value === 'function' ? value.bind(activeRunner) : value;
      },
    }) as IHostProcessService;
  }

  function makeEngine(): TurnEngine {
    return async (input) => {
      engineInput = input;
      await input.dispatchEvent({ type: 'step.begin', uuid: 's1', turnId: String(input.turnId), step: 1 });
      await input.dispatchEvent({
        type: 'content.part',
        uuid: 'p1',
        turnId: String(input.turnId),
        step: 1,
        stepUuid: 's1',
        part: { type: 'text', text: 'planning' },
      });
      await input.dispatchEvent({ type: 'step.end', uuid: 's1', turnId: String(input.turnId), step: 1, usage: emptyUsage() });
      return { stopReason: 'completed', steps: 1, usage: emptyUsage() };
    };
  }

  it('surfaces the plan-mode reminder inside the engine message projection', async () => {
    activeFs = createFakeHostFs({ mkdir: async () => undefined, readText: async () => '' });
    activeRunner = createFakeProcessRunner();
    const engine = makeEngine();

    ctx = createTestAgent(
      appService(IEngineOverrideService, { getEngine: () => engine }),
      execEnvServices({ hostFs: delegatingFs(), processRunner: delegatingRunner() }),
    );
    await ctx.restorePersisted();
    await ctx.restoreRuntimes();

    await ctx.get(IAgentPlanService).enter('engine-plan');

    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Plan the work' }] });
    await end;

    expect(engineInput).toBeDefined();
    const messages = await engineInput!.buildMessages();
    const text = messages
      .flatMap((m) => m.content)
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('\n');
    // PlanModeInjection registers a reminder variant that reconcileAroundStep
    // injects through the onWillBeginStep gate; the engine path runs that
    // gate, so the projection the engine reads must carry the plan-mode
    // reminder — proving feature injections reach the native engine.
    expect(text).toContain('Plan mode is active');
    expect(text).toContain('<system-reminder>');
  });
});

describe('external engine × tower/swarm injection bridge', () => {
  let ctx: TestAgentContext | undefined;
  let engineInput: TurnEngineInput | undefined;
  let cwd: string | undefined;

  afterEach(async () => {
    engineInput = undefined;
    if (ctx !== undefined) {
      await ctx.dispose();
      ctx = undefined;
    }
    if (cwd !== undefined) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  function makeRecordEngine(): TurnEngine {
    return async (input) => {
      engineInput = input;
      await input.dispatchEvent({ type: 'step.begin', uuid: 's1', turnId: String(input.turnId), step: 1 });
      await input.dispatchEvent({ type: 'step.end', uuid: 's1', turnId: String(input.turnId), step: 1, usage: emptyUsage() });
      return { stopReason: 'completed', steps: 1, usage: emptyUsage() };
    };
  }

  function projectedText(): Promise<string> {
    return engineInput!.buildMessages().then((messages) =>
      messages
        .flatMap((m) => m.content)
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('\n'),
    );
  }

  it('carries the tower-mode reminder into the engine message projection', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'engine-tower-'));
    ctx = createTestAgent(
      { cwd },
      appService(IEngineOverrideService, { getEngine: () => makeRecordEngine() }),
      appService(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID)),
    );
    await ctx.restorePersisted();
    await ctx.restoreRuntimes();
    await ctx.get(IAgentTowerService).enter();

    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run the tower' }] });
    await end;

    expect(engineInput).toBeDefined();
    expect(await projectedText()).toContain('Tower mode is active');
  });

  it('carries the swarm-mode reminder into the engine message projection', async () => {
    ctx = createTestAgent(appService(IEngineOverrideService, { getEngine: () => makeRecordEngine() }));
    await ctx.restorePersisted();
    await ctx.restoreRuntimes();
    ctx.get(IAgentSwarmService).enter('manual');

    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run the swarm' }] });
    await end;

    expect(engineInput).toBeDefined();
    expect(await projectedText()).toContain('## Swarm Mode');
  });
});

describe('external engine × session question service bridge', () => {
  let ctx: TestAgentContext | undefined;
  let wireResult: AskQuestionWireResult | undefined;

  afterEach(async () => {
    wireResult = undefined;
    if (ctx !== undefined) {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  function makeQuestionEngine(): TurnEngine {
    return async (input) => {
      await input.dispatchEvent({ type: 'step.begin', uuid: 'step-1', turnId: String(input.turnId), step: 1 });
      wireResult = await input.askUserQuestion?.({
        question_id: 'question_1',
        turn_id: String(input.turnId),
        tool_call_id: 'call-q',
        background: false,
        timeout_ms: null,
        questions: [
          {
            question: 'Which database?',
            header: 'Storage',
            options: [
              { label: 'Postgres', description: 'Relational storage' },
              { label: 'SQLite', description: 'Embedded storage' },
            ],
            multi_select: false,
          },
        ],
      });
      await input.dispatchEvent({ type: 'step.end', uuid: 'step-1', turnId: String(input.turnId), step: 1, usage: emptyUsage() });
      return { stopReason: 'completed', steps: 1, usage: emptyUsage() };
    };
  }

  it('routes an engine question to the session question service and maps the answer', async () => {
    ctx = createTestAgentWithEngine(makeQuestionEngine());
    void ctx.restoreRuntimes();
    const end = ctx.untilTurnEnd();
    const question = ctx.untilQuestion({ 'Which database?': 'Postgres' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await question;
    await end;

    expect(wireResult).toEqual({ answers: { 'Which database?': 'Postgres' } });
  });

  it('passes the answer method through to the wire result', async () => {
    ctx = createTestAgentWithEngine(makeQuestionEngine());
    void ctx.restoreRuntimes();
    const end = ctx.untilTurnEnd();
    const question = ctx.untilQuestion({
      answers: { 'Which database?': 'Postgres' },
      method: 'number_key',
    });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await question;
    await end;

    expect(wireResult).toEqual({
      answers: { 'Which database?': 'Postgres' },
      method: 'number_key',
    });
  });

  it('maps a dismissed question to the empty-answers note result', async () => {
    ctx = createTestAgentWithEngine(makeQuestionEngine());
    void ctx.restoreRuntimes();
    const end = ctx.untilTurnEnd();
    const question = ctx.untilQuestion(null);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await question;
    await end;

    expect(wireResult).toEqual({
      answers: {},
      note: 'User dismissed the question without answering.',
    });
  });

  it('maps a turn-ended cancellation to the cancelled wire result', async () => {
    ctx = createTestAgentWithEngine(makeQuestionEngine());
    void ctx.restoreRuntimes();
    const end = ctx.untilTurnEnd();
    const question = ctx.untilQuestion({ cancelled: true, reason: 'turn_ended' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await question;
    await end;

    expect(wireResult).toEqual({ cancelled: true, reason: 'turn_ended' });
  });

  it('registers a background question task and returns its task_id immediately', async () => {
    let wireResult: AskQuestionWireResult | undefined;
    const engine: TurnEngine = async (input) => {
      await input.dispatchEvent({ type: 'step.begin', uuid: 'step-1', turnId: String(input.turnId), step: 1 });
      wireResult = await input.askUserQuestion?.({
        question_id: 'question_1',
        turn_id: String(input.turnId),
        tool_call_id: 'call-q',
        background: true,
        timeout_ms: null,
        questions: [
          {
            question: 'Which database?',
            header: 'Storage',
            options: [
              { label: 'Postgres', description: 'Relational storage' },
              { label: 'SQLite', description: 'Embedded storage' },
            ],
            multi_select: false,
          },
        ],
      });
      await input.dispatchEvent({ type: 'step.end', uuid: 'step-1', turnId: String(input.turnId), step: 1, usage: emptyUsage() });
      return { stopReason: 'completed', steps: 1, usage: emptyUsage() };
    };

    ctx = createTestAgentWithEngine(engine);
    void ctx.restoreRuntimes();
    ctx.mockNextResponse({ type: 'text', text: 'notification ack' });
    const end = ctx.untilTurnEnd();
    const question = ctx.untilQuestion({ 'Which database?': 'Postgres' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await question;
    await end;

    expect(wireResult?.answers).toEqual({});
    expect(wireResult?.note).toContain('task_id: question-');
    expect(wireResult?.note).toContain('status: running');
    expect(wireResult?.note).toContain('automatic_notification: true');

    const taskId = wireResult?.note?.match(/task_id: (\S+)/)?.[1];
    expect(taskId).toBeDefined();
    const tasks = ctx.get(IAgentTaskService);
    await vi.waitFor(() => {
      expect(tasks.getTask(taskId!)).toMatchObject({ kind: 'question', status: 'completed' });
    });
    const snapshot = await tasks.getOutputSnapshot(taskId!, 4096);
    expect(snapshot.preview).toContain('Postgres');
  });

  it('keeps a foreground question blocking without registering a task', async () => {
    let wireResult: AskQuestionWireResult | undefined;
    const engine: TurnEngine = async (input) => {
      await input.dispatchEvent({ type: 'step.begin', uuid: 'step-1', turnId: String(input.turnId), step: 1 });
      wireResult = await input.askUserQuestion?.({
        question_id: 'question_1',
        turn_id: String(input.turnId),
        tool_call_id: 'call-q',
        background: false,
        timeout_ms: null,
        questions: [
          {
            question: 'Which database?',
            options: [{ label: 'Postgres' }],
            multi_select: false,
          },
        ],
      });
      await input.dispatchEvent({ type: 'step.end', uuid: 'step-1', turnId: String(input.turnId), step: 1, usage: emptyUsage() });
      return { stopReason: 'completed', steps: 1, usage: emptyUsage() };
    };

    ctx = createTestAgentWithEngine(engine);
    void ctx.restoreRuntimes();
    const end = ctx.untilTurnEnd();
    const question = ctx.untilQuestion({ 'Which database?': 'Postgres' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await question;
    await end;

    expect(wireResult).toEqual({ answers: { 'Which database?': 'Postgres' } });
    expect(ctx.get(IAgentTaskService).list(false)).toHaveLength(0);
  });
});

describe('external engine × state bridge', () => {
  let activeFs: IHostFileSystem;
  let activeRunner: IHostProcessService;
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx !== undefined) {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  function delegatingFs(): IHostFileSystem {
    return new Proxy(
      createFakeHostFs({
        mkdir: async () => undefined,
        readText: async () => '',
      }),
      {
        get(_target, prop, receiver) {
          const value = Reflect.get(activeFs, prop, receiver);
          return typeof value === 'function' ? value.bind(activeFs) : value;
        },
      },
    ) as IHostFileSystem;
  }

  function delegatingRunner(): IHostProcessService {
    return new Proxy(createFakeProcessRunner(), {
      get(_target, prop, receiver) {
        const value = Reflect.get(activeRunner, prop, receiver);
        return typeof value === 'function' ? value.bind(activeRunner) : value;
      },
    }) as IHostProcessService;
  }

  function makeStateEngine(run: (input: TurnEngineInput) => Promise<void>): TurnEngine {
    return async (input) => {
      await run(input);
      await input.dispatchEvent({ type: 'step.begin', uuid: 's1', turnId: String(input.turnId), step: 1 });
      await input.dispatchEvent({ type: 'step.end', uuid: 's1', turnId: String(input.turnId), step: 1, usage: emptyUsage() });
      return { stopReason: 'completed', steps: 1, usage: emptyUsage() };
    };
  }

  function planContext(engine: TurnEngine): TestAgentContext {
    activeFs = createFakeHostFs({ mkdir: async () => undefined, readText: async () => '' });
    activeRunner = createFakeProcessRunner();
    return createTestAgent(
      appService(IEngineOverrideService, { getEngine: () => engine }),
      execEnvServices({ hostFs: delegatingFs(), processRunner: delegatingRunner() }),
    );
  }

  async function driveTurn(): Promise<void> {
    const end = ctx!.untilTurnEnd();
    await ctx!.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await end;
  }

  async function captureError(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  function completingTask(output: string): AgentTask {
    return {
      idPrefix: 'test',
      kind: 'process',
      description: 'fake process task',
      start: async (sink) => {
        sink.appendOutput(output);
        await sink.settle({ status: 'completed' });
      },
      toInfo: (base) => ({ ...base, kind: 'process', command: 'echo', pid: 0, exitCode: null }),
    };
  }

  function abortableTask(): AgentTask {
    return {
      idPrefix: 'test',
      kind: 'process',
      description: 'fake process task',
      start: async (sink) => {
        await new Promise<void>((resolve) => {
          sink.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await sink.settle({ status: 'killed' });
      },
      toInfo: (base) => ({ ...base, kind: 'process', command: 'sleep', pid: 0, exitCode: null }),
    };
  }

  function runningTask(): AgentTask {
    return {
      idPrefix: 'test',
      kind: 'process',
      description: 'fake process task',
      start: async () => {},
      toInfo: (base) => ({ ...base, kind: 'process', command: 'sleep', pid: 0, exitCode: null }),
    };
  }

  it('reads the todo domain through the AgentTodo runtime', async () => {
    let readResult: StateReadWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      readResult = await input.stateRead?.({ domain: 'todo', key: 'todo' });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await ctx.resolve(AgentTodo).replace([
      {
        id: 'T1',
        parentId: null,
        kind: 'task',
        title: 'Read session-control.ts',
        status: 'in_progress',
        progress: 40,
      },
    ]);
    await driveTurn();

    expect(readResult).toEqual({
      value: [
        {
          id: 'T1',
          parentId: null,
          kind: 'task',
          title: 'Read session-control.ts',
          status: 'in_progress',
          progress: 40,
        },
      ],
    });
  });

  it('writes the todo domain through the AgentTodo runtime with host normalization', async () => {
    let writeResult: StateWriteWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      writeResult = await input.stateWrite?.({
        domain: 'todo',
        key: 'todo',
        value: [{ title: 'Read session-control.ts', status: 'in_progress' }],
        undoable: true,
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect(writeResult).toEqual({
      ok: true,
      value: [
        {
          id: 'T1',
          parentId: null,
          kind: 'task',
          title: 'Read session-control.ts',
          status: 'in_progress',
        },
      ],
    });
    expect(ctx.resolve(AgentTodo).get()).toEqual([
      {
        id: 'T1',
        parentId: null,
        kind: 'task',
        title: 'Read session-control.ts',
        status: 'in_progress',
      },
    ]);
  });

  it('reads the plan domain as inactive when no plan is active', async () => {
    let readResult: StateReadWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      readResult = await input.stateRead?.({ domain: 'plan', key: 'plan' });
    });
    ctx = planContext(engine);
    await ctx.restorePersisted();
    await ctx.restoreRuntimes();
    await driveTurn();

    expect(readResult).toEqual({ value: { active: false } });
  });

  it('reads the plan domain with the active plan id and file path', async () => {
    let readResult: StateReadWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      readResult = await input.stateRead?.({ domain: 'plan', key: 'plan' });
    });
    ctx = planContext(engine);
    await ctx.restorePersisted();
    await ctx.restoreRuntimes();
    await ctx.get(IAgentPlanService).enter('engine-plan');
    await driveTurn();

    expect(readResult).toEqual({
      value: { active: true, id: 'engine-plan', path: expect.stringContaining('engine-plan.md') },
    });
  });

  it('enters plan mode through the plan service and returns the applied state', async () => {
    let writeResult: StateWriteWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      writeResult = await input.stateWrite?.({
        domain: 'plan',
        key: 'plan',
        value: { active: true },
        undoable: true,
      });
    });
    ctx = planContext(engine);
    await ctx.restorePersisted();
    await ctx.restoreRuntimes();
    await driveTurn();

    expect(writeResult?.ok).toBe(true);
    expect(writeResult?.value).toMatchObject({
      active: true,
      id: expect.any(String),
      path: expect.stringContaining('.md'),
    });
    expect(await ctx.get(IAgentPlanService).status()).not.toBeNull();
  });

  it('exits plan mode through the plan service and returns the applied state', async () => {
    let writeResult: StateWriteWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      writeResult = await input.stateWrite?.({
        domain: 'plan',
        key: 'plan',
        value: { active: false },
        undoable: true,
      });
    });
    ctx = planContext(engine);
    await ctx.restorePersisted();
    await ctx.restoreRuntimes();
    await ctx.get(IAgentPlanService).enter('engine-plan');
    await driveTurn();

    expect(writeResult).toEqual({ ok: true, value: { active: false } });
    expect(await ctx.get(IAgentPlanService).status()).toBeNull();
  });

  it('rejects an unknown state domain with -32001', async () => {
    let readError: unknown;
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      readError = await captureError(async () => {
        await input.stateRead?.({ domain: 'unknown', key: 'unknown' });
      });
      writeError = await captureError(async () => {
        await input.stateWrite?.({ domain: 'unknown', key: 'unknown', value: {}, undoable: true });
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((readError as { code?: number }).code).toBe(-32001);
    expect((writeError as { code?: number }).code).toBe(-32001);
  });

  it('rejects an invalid todo value with -32003', async () => {
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      writeError = await captureError(async () => {
        await input.stateWrite?.({
          domain: 'todo',
          key: 'todo',
          value: { not: 'an array' },
          undoable: true,
        });
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((writeError as { code?: number }).code).toBe(-32003);
  });

  it('rejects an invalid plan value with -32003', async () => {
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      writeError = await captureError(async () => {
        await input.stateWrite?.({
          domain: 'plan',
          key: 'plan',
          value: { active: 'yes' },
          undoable: true,
        });
      });
    });
    ctx = planContext(engine);
    await ctx.restorePersisted();
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((writeError as { code?: number }).code).toBe(-32003);
  });

  it('rejects a plan enter while plan mode is already active with -32004', async () => {
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      writeError = await captureError(async () => {
        await input.stateWrite?.({
          domain: 'plan',
          key: 'plan',
          value: { active: true },
          undoable: true,
        });
      });
    });
    ctx = planContext(engine);
    await ctx.restorePersisted();
    await ctx.restoreRuntimes();
    await ctx.get(IAgentPlanService).enter('engine-plan');
    await driveTurn();

    expect((writeError as { code?: number }).code).toBe(-32004);
  });

  it('reads the goal domain as null when no goal exists', async () => {
    let readResult: StateReadWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      readResult = await input.stateRead?.({ domain: 'goal', key: 'goal' });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect(readResult).toEqual({ value: { goal: null } });
  });

  it('reads the goal domain through the AgentGoal runtime', async () => {
    let readResult: StateReadWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      readResult = await input.stateRead?.({ domain: 'goal', key: 'goal' });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await ctx.resolve(AgentGoal).createGoal({ objective: 'Do the thing' });
    await driveTurn();

    expect(readResult).toEqual({
      value: {
        goal: expect.objectContaining({
          objective: 'Do the thing',
          status: 'active',
          tokensUsed: 0,
        }),
      },
    });
  });

  it('reads the cron domain through the AgentCron runtime', async () => {
    let readResult: StateReadWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      readResult = await input.stateRead?.({ domain: 'cron', key: 'cron' });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    ctx.resolve(AgentCron).addTask({
      cron: '0 9 * * *',
      prompt: 'morning briefing',
      recurring: true,
    });
    await driveTurn();

    expect(readResult).toEqual({
      value: [
        expect.objectContaining({
          id: expect.any(String),
          cron: '0 9 * * *',
          humanSchedule: expect.any(String),
          prompt: 'morning briefing',
          createdAt: expect.any(Number),
          recurring: true,
          nextFireAt: expect.any(String),
          ageDays: expect.any(Number),
          stale: false,
        }),
      ],
    });
  });

  it('writes the cron domain create action through the AgentCron runtime', async () => {
    let writeResult: StateWriteWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      writeResult = await input.stateWrite?.({
        domain: 'cron',
        key: 'cron',
        value: { action: 'create', cron: '0 9 * * *', prompt: 'morning briefing' },
        undoable: false,
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect(writeResult?.ok).toBe(true);
    expect(writeResult?.value).toMatchObject({
      id: expect.any(String),
      cron: '0 9 * * *',
      humanSchedule: expect.any(String),
      prompt: 'morning briefing',
      recurring: true,
      nextFireAt: expect.any(String),
    });
    expect(ctx.resolve(AgentCron).list()).toHaveLength(1);
  });

  it('writes the cron domain delete action through the AgentCron runtime', async () => {
    let writeResult: StateWriteWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      writeResult = await input.stateWrite?.({
        domain: 'cron',
        key: 'cron',
        value: { action: 'delete', id: task.id },
        undoable: false,
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    const task = ctx.resolve(AgentCron).addTask({
      cron: '0 9 * * *',
      prompt: 'morning briefing',
      recurring: true,
    });
    await driveTurn();

    expect(writeResult).toEqual({ ok: true, value: [] });
    expect(ctx.resolve(AgentCron).list()).toHaveLength(0);
  });

  it('rejects an invalid cron expression with -32003', async () => {
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      writeError = await captureError(async () => {
        await input.stateWrite?.({
          domain: 'cron',
          key: 'cron',
          value: { action: 'create', cron: 'not a cron', prompt: 'x' },
          undoable: false,
        });
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((writeError as { code?: number }).code).toBe(-32003);
  });

  it('rejects deleting a missing cron job with -32004', async () => {
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      writeError = await captureError(async () => {
        await input.stateWrite?.({
          domain: 'cron',
          key: 'cron',
          value: { action: 'delete', id: '01HZ0000000000000000000000' },
          undoable: false,
        });
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((writeError as { code?: number }).code).toBe(-32004);
  });

  it('writes the goal domain update action through the AgentGoal runtime', async () => {
    let writeResult: StateWriteWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      writeResult = await input.stateWrite?.({
        domain: 'goal',
        key: 'goal',
        value: { action: 'update', status: 'complete' },
        undoable: false,
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await ctx.resolve(AgentGoal).createGoal({ objective: 'Do the thing' });
    await driveTurn();

    expect(writeResult?.ok).toBe(true);
    expect(writeResult?.value).toEqual({
      goal: expect.objectContaining({ objective: 'Do the thing', status: 'complete' }),
    });
  });

  it('writes the goal domain set_budget action through the AgentGoal runtime', async () => {
    let writeResult: StateWriteWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      writeResult = await input.stateWrite?.({
        domain: 'goal',
        key: 'goal',
        value: { action: 'set_budget', value: 10, unit: 'turns' },
        undoable: false,
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await ctx.resolve(AgentGoal).createGoal({ objective: 'Do the thing' });
    await driveTurn();

    expect(writeResult?.ok).toBe(true);
    expect(writeResult?.value).toEqual({
      goal: expect.objectContaining({
        budget: expect.objectContaining({ turnBudget: 10 }),
      }),
    });
  });

  it('rejects a goal update with no current goal with -32004', async () => {
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      writeError = await captureError(async () => {
        await input.stateWrite?.({
          domain: 'goal',
          key: 'goal',
          value: { action: 'update', status: 'complete' },
          undoable: false,
        });
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((writeError as { code?: number }).code).toBe(-32004);
  });

  it('rejects an invalid goal status with -32003', async () => {
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      writeError = await captureError(async () => {
        await input.stateWrite?.({
          domain: 'goal',
          key: 'goal',
          value: { action: 'update', status: 'paused' },
          undoable: false,
        });
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((writeError as { code?: number }).code).toBe(-32003);
  });

  it('rejects an unreasonable goal budget with -32003', async () => {
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      writeError = await captureError(async () => {
        await input.stateWrite?.({
          domain: 'goal',
          key: 'goal',
          value: { action: 'set_budget', value: 1, unit: 'milliseconds' },
          undoable: false,
        });
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((writeError as { code?: number }).code).toBe(-32003);
  });

  it('rejects an invalid goal action with -32003', async () => {
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      writeError = await captureError(async () => {
        await input.stateWrite?.({
          domain: 'goal',
          key: 'goal',
          value: { goal: null },
          undoable: true,
        });
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((writeError as { code?: number }).code).toBe(-32003);
  });

  it('reads the task domain list through the AgentTaskService', async () => {
    let readResult: StateReadWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      readResult = await input.stateRead?.({ domain: 'task', key: 'task' });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    ctx.get(IAgentTaskService).registerTask(completingTask('hello\n'));
    await driveTurn();

    expect(readResult).toEqual({
      value: [
        expect.objectContaining({
          taskId: expect.any(String),
          description: 'fake process task',
          status: 'completed',
          startedAt: expect.any(Number),
          endedAt: expect.any(Number),
        }),
      ],
    });
  });

  it('reads a single task output snapshot through the AgentTaskService', async () => {
    let readResult: StateReadWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      readResult = await input.stateRead?.({ domain: 'task', key: taskId });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    const taskId = ctx.get(IAgentTaskService).registerTask(completingTask('hello\n'));
    await driveTurn();

    expect(readResult).toEqual({
      value: expect.objectContaining({
        taskId,
        description: 'fake process task',
        status: 'completed',
        outputSizeBytes: 6,
        preview: 'hello\n',
      }),
    });
  });

  it('rejects reading a missing task with -32002', async () => {
    let readError: unknown;
    const engine = makeStateEngine(async (input) => {
      readError = await captureError(async () => {
        await input.stateRead?.({ domain: 'task', key: 'missing-task' });
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((readError as { code?: number }).code).toBe(-32002);
  });

  it('stops a task through the AgentTaskService', async () => {
    let writeResult: StateWriteWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      writeResult = await input.stateWrite?.({
        domain: 'task',
        key: taskId,
        value: { action: 'stop', id: taskId },
        undoable: false,
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    const taskId = ctx.get(IAgentTaskService).registerTask(abortableTask());
    await driveTurn();

    expect(writeResult?.ok).toBe(true);
    expect(writeResult?.value).toMatchObject({ taskId, status: 'killed' });
    expect(ctx.get(IAgentTaskService).getTask(taskId)).toMatchObject({ status: 'killed' });
  });

  it('waits on a task through the AgentTaskService and returns its current state', async () => {
    let writeResult: StateWriteWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      writeResult = await input.stateWrite?.({
        domain: 'task',
        key: taskId,
        value: { action: 'wait', id: taskId, timeout_ms: 50 },
        undoable: false,
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    const taskId = ctx.get(IAgentTaskService).registerTask(runningTask());
    await driveTurn();

    expect(writeResult?.ok).toBe(true);
    expect(writeResult?.value).toMatchObject({ taskId, status: 'running' });
  });

  it('waits on a completed task through the AgentTaskService and returns the terminal state', async () => {
    let writeResult: StateWriteWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      writeResult = await input.stateWrite?.({
        domain: 'task',
        key: taskId,
        value: { action: 'wait', id: taskId, timeout_ms: 5_000 },
        undoable: false,
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    const taskId = ctx.get(IAgentTaskService).registerTask(completingTask('done\n'));
    await driveTurn();

    expect(writeResult?.ok).toBe(true);
    expect(writeResult?.value).toMatchObject({ taskId, status: 'completed' });
  });

  it('rejects stopping a missing task with -32002', async () => {
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      writeError = await captureError(async () => {
        await input.stateWrite?.({
          domain: 'task',
          key: 'missing-task',
          value: { action: 'stop', id: 'missing-task' },
          undoable: false,
        });
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((writeError as { code?: number }).code).toBe(-32002);
  });

  it('rejects an invalid task action with -32003', async () => {
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      writeError = await captureError(async () => {
        await input.stateWrite?.({
          domain: 'task',
          key: 'task',
          value: { action: 'explode' },
          undoable: false,
        });
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((writeError as { code?: number }).code).toBe(-32003);
  });

  it('reads the skill domain through the session skill catalog', async () => {
    let readResult: StateReadWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      readResult = await input.stateRead?.({ domain: 'skill', key: 'my-skill' });
    });
    const catalog = new InMemorySkillCatalog();
    catalog.register({
      name: 'my-skill',
      description: 'A test skill',
      path: '/skills/my-skill',
      dir: '/skills/my-skill',
      content: 'Follow these instructions.',
      metadata: {},
      source: 'user',
    });
    ctx = createTestAgentWithEngine(engine, skillServices(catalog));
    await ctx.restoreRuntimes();
    await driveTurn();

    expect(readResult).toEqual({
      value: {
        name: 'my-skill',
        description: 'A test skill',
        instructions: 'Follow these instructions.',
      },
    });
  });

  it('rejects reading a missing skill with -32002', async () => {
    let readError: unknown;
    const engine = makeStateEngine(async (input) => {
      readError = await captureError(async () => {
        await input.stateRead?.({ domain: 'skill', key: 'nope' });
      });
    });
    ctx = createTestAgentWithEngine(engine, skillServices(new InMemorySkillCatalog()));
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((readError as { code?: number }).code).toBe(-32002);
  });

  it('writes the goal domain create action through the AgentGoal runtime', async () => {
    let writeResult: StateWriteWireResult | undefined;
    const engine = makeStateEngine(async (input) => {
      writeResult = await input.stateWrite?.({
        domain: 'goal',
        key: 'goal',
        value: { action: 'create', objective: 'Do the thing' },
        undoable: false,
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect(writeResult?.ok).toBe(true);
    expect(writeResult?.value).toEqual({
      goal: expect.objectContaining({ objective: 'Do the thing', status: 'active' }),
    });
    expect(ctx.resolve(AgentGoal).getGoal().goal).toMatchObject({ objective: 'Do the thing' });
  });

  it('rejects a goal create with an existing goal with -32004', async () => {
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      writeError = await captureError(async () => {
        await input.stateWrite?.({
          domain: 'goal',
          key: 'goal',
          value: { action: 'create', objective: 'Another goal' },
          undoable: false,
        });
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await ctx.resolve(AgentGoal).createGoal({ objective: 'Existing goal' });
    await driveTurn();

    expect((writeError as { code?: number }).code).toBe(-32004);
  });

  it('rejects a goal create with an empty objective with -32003', async () => {
    let writeError: unknown;
    const engine = makeStateEngine(async (input) => {
      writeError = await captureError(async () => {
        await input.stateWrite?.({
          domain: 'goal',
          key: 'goal',
          value: { action: 'create', objective: '   ' },
          undoable: false,
        });
      });
    });
    ctx = createTestAgentWithEngine(engine);
    await ctx.restoreRuntimes();
    await driveTurn();

    expect((writeError as { code?: number }).code).toBe(-32003);
  });
});
