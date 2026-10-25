import { setLocale } from '@moonshot-ai/kimi-i18n';
import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  ToolExecutionOutcome,
} from '#/agent/toolExecutor/toolHooks';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  type HelloWorldRunItemId,
  type HelloWorldStage,
  IAgentHelloWorldService,
} from '#/features/helloWorld/agent/helloWorld';
import { AgentHelloWorldService } from '#/features/helloWorld/agent/helloWorldService';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type {
  ContextInjectionContext,
  ContextInjectionProvider,
  ContextInjectionResult,
} from '#/features/reminder/types';
import type { ToolCall } from '#human/llm/message';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import HELLO_WORLD_MODE_ENTER_REMINDER from '../../../src/features/helloWorld/agent/enter-reminder.md?raw';
import HELLO_WORLD_MODE_EXIT_REMINDER from '../../../src/features/helloWorld/agent/exit-reminder.md?raw';
import DELIVER_STAGE_SCRIPT from '../../../src/features/helloWorld/agent/stages/deliver.md?raw';
import DESIGN_STAGE_SCRIPT from '../../../src/features/helloWorld/agent/stages/design.md?raw';
import DOCS_STAGE_SCRIPT from '../../../src/features/helloWorld/agent/stages/docs.md?raw';
import REQUIREMENTS_STAGE_SCRIPT from '../../../src/features/helloWorld/agent/stages/requirements.md?raw';
import TEST_STAGE_SCRIPT from '../../../src/features/helloWorld/agent/stages/test.md?raw';
import { stubContextMemory } from '../../agent/contextMemory/stubs';
import {
  stubToolExecutorEvents,
  type ToolExecutorEventStubs,
} from '../../agent/toolExecutor/stubs';
import { createReminderStub } from '../reminder/stubs';
import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

const signal = new AbortController().signal;

const SCOPE = testWireScope('wire', 'hello-world-test');

const CHECKLIST_IDS: readonly HelloWorldRunItemId[] = [
  'requirements-approved',
  'design-written',
  'tasks-complete',
  'tests-green',
  'review-done',
  'docs-updated',
  'changeset-ready',
];

interface CapturedStatusEvent {
  readonly helloWorldMode?: boolean;
  readonly helloWorldStage?: HelloWorldStage;
}

function makeToolCall(name: string, id: string): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

function makeHookContext(toolCalls: ToolCall[]): ResolvedToolExecutionHookContext {
  const adjudicating = toolCalls[0]!;
  return {
    turnId: 0,
    signal,
    toolCall: adjudicating,
    toolCalls,
    args: {},
    execution: {
      approvalRule: adjudicating.name,
      execute: async () => ({ output: '' }),
    },
  };
}

function makeDidExecuteContext(
  name: string,
  args: Record<string, unknown>,
  options: { readonly outcome?: ToolExecutionOutcome; readonly isError?: boolean } = {},
): ToolDidExecuteContext {
  return {
    turnId: 1,
    signal,
    toolCall: makeToolCall(name, `call_${name}`),
    toolCalls: [],
    args,
    outcome: options.outcome ?? 'executed',
    result: { output: '', isError: options.isError },
  };
}

describe('AgentHelloWorldService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executorEvents: ToolExecutorEventStubs;
  let permissionGateRan: boolean;
  let telemetryTrack2: Mock<(event: string, properties?: unknown) => void>;
  let provider: ContextInjectionProvider | undefined;
  let statusEvents: CapturedStatusEvent[];

  beforeEach(() => {
    setLocale('en');
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.set(IAgentStateService, new AgentStateService());
    const reminder = createReminderStub({
      register: (_variant, value) => {
        provider = value as ContextInjectionProvider;
        return toDisposable(() => {
          provider = undefined;
        });
      },
    });
    ix.stub(IAgentReminderService, reminder);
    executorEvents = stubToolExecutorEvents();
    permissionGateRan = false;
    ix.stub(IAgentToolExecutorService, executorEvents.executor);
    telemetryTrack2 = mock();
    ix.stub(ITelemetryService, { track2: telemetryTrack2 });
    registerTestAgentWire(ix, SCOPE, {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    registerTestEventDispatcher(ix);
    statusEvents = [];
    disposables.add(
      ix.get(IEventBus).subscribe((event) => {
        if (event instanceof AgentStatusUpdated) {
          statusEvents.push({
            helloWorldMode: event.helloWorldMode,
            helloWorldStage: event.helloWorldStage,
          });
        }
      }),
    );
    ix.set(IAgentHelloWorldService, new SyncDescriptor(AgentHelloWorldService));
  });
  afterEach(() => disposables.dispose());

  async function fire(
    ctx: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    disposables.add(
      executorEvents.executor.onBeforeExecuteTool(() => {
        permissionGateRan = true;
      }),
    );
    return executorEvents.fireBeforeExecute(ctx);
  }

  async function fireDidExecute(ctx: ToolDidExecuteContext): Promise<void> {
    await executorEvents.didExecuteSlot.run(ctx);
  }

  async function runUpdatedStages(): Promise<readonly unknown[]> {
    await ix.get(IEventDispatcher).flush();
    const stages: unknown[] = [];
    for await (const record of ix
      .get(IAppendLogStore)
      .read<WireRecord>(SCOPE, AGENT_WIRE_RECORD_KEY)) {
      if (record.type === 'hello_world_run.updated') stages.push(record['stage']);
    }
    return stages;
  }

  function reminder(
    lastDisclosure?: {
      readonly kind: 'hello_world_mode';
      readonly state: 'active' | 'inactive';
      readonly stage: HelloWorldStage;
    },
  ): ContextInjectionResult | undefined {
    return provider?.({
      injectedPositions: [],
      lastInjectedAt: null,
      lastInjection: undefined,
      lastDisclosure,
      isNewTurn: true,
    } as ContextInjectionContext) as ContextInjectionResult | undefined;
  }

  function renderedText(result: ContextInjectionResult | undefined): string {
    const content = result?.content;
    return typeof content === 'string' ? content : '';
  }

  it('enter / exit toggle isActive and emit agent.status.updated via wire', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);

    expect(helloWorld.isActive).toBe(false);
    helloWorld.enter('manual');
    expect(helloWorld.isActive).toBe(true);
    helloWorld.exit();
    expect(helloWorld.isActive).toBe(false);

    expect(statusEvents).toEqual([
      { helloWorldMode: true, helloWorldStage: 'requirements' },
      { helloWorldMode: false, helloWorldStage: undefined },
    ]);
  });

  it('tracks hello_world_mode_entered / hello_world_mode_exited on transitions only', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);

    helloWorld.enter('manual');
    helloWorld.enter('manual');
    helloWorld.exit();
    helloWorld.exit();

    expect(telemetryTrack2.mock.calls).toEqual([
      ['hello_world_mode_entered', { trigger: 'manual' }],
      ['hello_world_mode_exited', { trigger: 'manual' }],
    ]);
  });

  it('enter opens a run at requirements with the task and the full checklist', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);

    helloWorld.enter('task', 'ship the staged run');

    expect(helloWorld.run).toEqual({
      stage: 'requirements',
      task: 'ship the staged run',
      items: CHECKLIST_IDS.map((id) => ({ id, done: false })),
      waivers: [],
    });

    helloWorld.enter('manual');
    expect(helloWorld.run?.task).toBe('ship the staged run');
  });

  it('exit clears the run', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);

    helloWorld.enter('manual');
    helloWorld.exit();

    expect(helloWorld.run).toBeNull();
  });

  it('renders the run opening and the requirements stage script on entry', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('task', 'ship the staged run');

    const result = reminder();
    expect(result?.disclosure).toEqual({
      kind: 'hello_world_mode',
      state: 'active',
      stage: 'requirements',
    });
    const content = renderedText(result);
    expect(content).toContain(HELLO_WORLD_MODE_ENTER_REMINDER);
    expect(content).toContain(REQUIREMENTS_STAGE_SCRIPT);
    expect(content).toContain('Task: ship the staged run');
    expect(content).toContain('Stage: requirements');
    expect(content).toContain('- [ ] requirements-approved');
    expect(content).not.toContain(DESIGN_STAGE_SCRIPT);
  });

  it('reinjects only the next stage script when the stage changes', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');
    helloWorld.advance('next');

    const result = reminder({ kind: 'hello_world_mode', state: 'active', stage: 'requirements' });
    expect(result?.disclosure).toEqual({
      kind: 'hello_world_mode',
      state: 'active',
      stage: 'design',
    });
    const content = renderedText(result);
    expect(content).toContain(DESIGN_STAGE_SCRIPT);
    expect(content).not.toContain(HELLO_WORLD_MODE_ENTER_REMINDER);
    expect(content).not.toContain(REQUIREMENTS_STAGE_SCRIPT);
  });

  it('renders nothing while the stage is unchanged', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');

    expect(
      reminder({ kind: 'hello_world_mode', state: 'active', stage: 'requirements' }),
    ).toBeUndefined();
  });

  it('renders no reminder for tool-triggered entries', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('tool');

    expect(reminder()).toBeUndefined();
  });

  it('renders the exit reminder when the mode leaves a trailing enter disclosure', () => {
    void ix.get(IAgentHelloWorldService);

    expect(
      reminder({ kind: 'hello_world_mode', state: 'active', stage: 'design' }),
    ).toEqual({
      content: HELLO_WORLD_MODE_EXIT_REMINDER,
      disclosure: { kind: 'hello_world_mode', state: 'inactive', stage: 'design' },
    });
  });

  it('renders nothing when neither active nor previously rendered', () => {
    void ix.get(IAgentHelloWorldService);

    expect(reminder()).toBeUndefined();
    expect(
      reminder({ kind: 'hello_world_mode', state: 'inactive', stage: 'requirements' }),
    ).toBeUndefined();
  });

  it('does not veto the Agent tool while hello-world mode is active', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');

    const decision = await fire(makeHookContext([makeToolCall('Agent', 'call_agent')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
  });

  it('keeps the run alive across turns for task-triggered entries', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('task', 'long running task');

    ix.get(IEventBus).publish(
      new TurnEnded({ agentId: 'test-agent', turnId: 1, reason: 'completed' }),
      ix.get(IAgentScopeContext).agentContext,
    );

    expect(helloWorld.isActive).toBe(true);
    expect(helloWorld.run?.task).toBe('long running task');
  });

  it('keeps the run alive across turns for tool-triggered entries', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('tool');

    ix.get(IEventBus).publish(
      new TurnEnded({ agentId: 'test-agent', turnId: 1, reason: 'completed' }),
      ix.get(IAgentScopeContext).agentContext,
    );

    expect(helloWorld.isActive).toBe(true);
  });

  it('stays active across turns for manual entries', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');

    ix.get(IEventBus).publish(
      new TurnEnded({ agentId: 'test-agent', turnId: 1, reason: 'completed' }),
      ix.get(IAgentScopeContext).agentContext,
    );

    expect(helloWorld.isActive).toBe(true);
  });

  it('advance walks the run forward and tracks hello_world_stage_changed', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');

    helloWorld.advance('next');
    expect(helloWorld.run?.stage).toBe('design');

    helloWorld.advance('implement');
    expect(helloWorld.run?.stage).toBe('implement');

    expect(telemetryTrack2.mock.calls).toEqual([
      ['hello_world_mode_entered', { trigger: 'manual' }],
      ['hello_world_stage_changed', { stage: 'design', previous: 'requirements' }],
      ['hello_world_stage_changed', { stage: 'implement', previous: 'design' }],
    ]);
    expect(statusEvents.at(-1)).toEqual({
      helloWorldMode: undefined,
      helloWorldStage: 'implement',
    });
    expect(await runUpdatedStages()).toEqual(['design', 'implement']);
  });

  it('advance is only-forward and no-ops past deliver', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');

    helloWorld.advance('deliver');
    expect(helloWorld.run?.stage).toBe('deliver');

    helloWorld.advance('next');
    helloWorld.advance('requirements');
    helloWorld.advance('design');
    expect(helloWorld.run?.stage).toBe('deliver');
    expect(await runUpdatedStages()).toEqual(['deliver']);
  });

  it('waive records the waiver, checks the item as waived, and is idempotent', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');

    helloWorld.waive('tests-green');
    expect(helloWorld.run?.waivers).toEqual(['tests-green']);
    expect(helloWorld.run?.items.find((item) => item.id === 'tests-green')).toEqual({
      id: 'tests-green',
      done: true,
      evidence: 'waived',
    });
    expect(helloWorld.run?.stage).toBe('requirements');
    expect(await runUpdatedStages()).toEqual(['requirements']);

    helloWorld.waive('tests-green');
    expect(await runUpdatedStages()).toEqual(['requirements']);
  });

  it('advance and waive are no-ops without a run', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);

    helloWorld.advance('next');
    helloWorld.waive('tests-green');

    expect(helloWorld.run).toBeNull();
    expect(telemetryTrack2.mock.calls).toEqual([]);
    expect(await runUpdatedStages()).toEqual([]);
  });

  it('advances on evidence: writing specs/*/requirements.md checks requirements-approved', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');

    await fireDidExecute(
      makeDidExecuteContext('Write', { path: 'specs/medusa/requirements.md' }),
    );

    expect(helloWorld.run?.stage).toBe('design');
    expect(helloWorld.run?.items.find((item) => item.id === 'requirements-approved')).toEqual({
      id: 'requirements-approved',
      done: true,
      evidence: 'specs/medusa/requirements.md',
    });
    expect(telemetryTrack2.mock.calls).toContainEqual([
      'hello_world_stage_changed',
      { stage: 'design', previous: 'requirements' },
    ]);
  });

  it('advances on evidence: writing specs/*/design.md checks design-written and tasks-complete', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');
    helloWorld.advance('design');

    await fireDidExecute(
      makeDidExecuteContext('Edit', { path: 'specs/medusa/design.md' }),
    );
    await fireDidExecute(makeDidExecuteContext('Write', { path: 'specs/medusa/tasks.md' }));

    expect(helloWorld.run?.stage).toBe('implement');
    expect(helloWorld.run?.items.find((item) => item.id === 'design-written')).toEqual({
      id: 'design-written',
      done: true,
      evidence: 'specs/medusa/design.md',
    });
    expect(helloWorld.run?.items.find((item) => item.id === 'tasks-complete')?.done).toBe(true);
  });

  it('advances on evidence: successful bun check commands walk implement → test → review', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');
    helloWorld.advance('implement');

    await fireDidExecute(
      makeDidExecuteContext('Bash', { command: 'bun test --isolate test/features/helloWorld' }),
    );
    expect(helloWorld.run?.stage).toBe('test');

    await fireDidExecute(
      makeDidExecuteContext('Bash', { command: 'bun run typecheck' }),
    );
    expect(helloWorld.run?.stage).toBe('review');
    expect(helloWorld.run?.items.find((item) => item.id === 'tests-green')).toEqual({
      id: 'tests-green',
      done: true,
      evidence: 'bun run typecheck',
    });
  });

  it('advances on evidence: docs then changeset writes walk review → docs → deliver', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');
    helloWorld.advance('review');

    await fireDidExecute(
      makeDidExecuteContext('Write', { path: 'docs/en/guides/hello-world.md' }),
    );
    expect(helloWorld.run?.stage).toBe('docs');
    expect(helloWorld.run?.items.find((item) => item.id === 'review-done')?.done).toBe(true);

    await fireDidExecute(
      makeDidExecuteContext('Write', { path: '.changeset/hello-world-mode.md' }),
    );
    expect(helloWorld.run?.stage).toBe('deliver');
    expect(helloWorld.run?.items.find((item) => item.id === 'docs-updated')?.done).toBe(true);
    expect(helloWorld.run?.items.find((item) => item.id === 'changeset-ready')?.done).toBe(true);
  });

  it('code writes move requirements/design to implement only', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');

    await fireDidExecute(
      makeDidExecuteContext('Write', { path: 'packages/agent-core-v2/src/foo.ts' }),
    );
    expect(helloWorld.run?.stage).toBe('implement');

    await fireDidExecute(
      makeDidExecuteContext('Write', { path: 'packages/agent-core-v2/src/bar.ts' }),
    );
    expect(helloWorld.run?.stage).toBe('implement');
    expect(await runUpdatedStages()).toEqual(['implement']);
  });

  it('evidence signals are idempotent and ignored when they fail', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');

    await fireDidExecute(
      makeDidExecuteContext('Write', { path: 'specs/medusa/requirements.md' }, { isError: true }),
    );
    expect(helloWorld.run?.stage).toBe('requirements');
    expect(await runUpdatedStages()).toEqual([]);

    await fireDidExecute(
      makeDidExecuteContext('Write', { path: 'specs/medusa/requirements.md' }),
    );
    await fireDidExecute(
      makeDidExecuteContext('Write', { path: 'specs/medusa/requirements.md' }),
    );
    expect(helloWorld.run?.stage).toBe('design');
    expect(await runUpdatedStages()).toEqual(['design']);

    await fireDidExecute(
      makeDidExecuteContext(
        'Bash',
        { command: 'bun run lint' },
        { outcome: 'vetoed', isError: true },
      ),
    );
    expect(helloWorld.run?.stage).toBe('design');
    expect(await runUpdatedStages()).toEqual(['design']);
  });
});
