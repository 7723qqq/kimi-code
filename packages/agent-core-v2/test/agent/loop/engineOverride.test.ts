import type * as ChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import {
  IEngineOverrideService,
  type AskQuestionWireResult,
  type StateReadWireResult,
  type StateWriteWireResult,
  type TurnEngine,
  type TurnEngineInput,
} from '#/agent/loop/engineOverride';
import { IFlagService } from '#/app/flag/flag';
import { AgentGoal } from '#/features/goal/goalAgentRuntime';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { AgentTodo } from '#/features/todo/todoAgentRuntime';
import { IAgentTowerService, TOWER_FLAG_ID } from '#/features/tower/tower';
import type { ContentPart } from '#/kosong/contract/message';
import { emptyUsage } from '#/kosong/contract/usage';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';

import {
  appService,
  createTestAgent,
  execEnvServices,
  permissionModeServices,
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
        await input.stateRead?.({ domain: 'cron', key: 'cron' });
      });
      writeError = await captureError(async () => {
        await input.stateWrite?.({ domain: 'cron', key: 'cron', value: {}, undoable: true });
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

  it('rejects a goal state write with -32004', async () => {
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

    expect((writeError as { code?: number }).code).toBe(-32004);
  });
});
