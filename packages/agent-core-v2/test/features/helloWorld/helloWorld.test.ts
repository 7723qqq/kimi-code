import { setLocale, t } from '@moonshot-ai/kimi-i18n';
import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentHelloWorldService } from '#/features/helloWorld/agent/helloWorld';
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

import HELLO_WORLD_MODE_ENTER_REMINDER from '../../../src/features/helloWorld/agent/enter-reminder.md?raw';
import HELLO_WORLD_MODE_EXIT_REMINDER from '../../../src/features/helloWorld/agent/exit-reminder.md?raw';
import SWARM_MODE_ENTER_REMINDER from '../../../src/features/swarm/agent/enter-reminder.md?raw';
import { stubContextMemory } from '../../agent/contextMemory/stubs';
import { recordingTelemetry } from '../../app/telemetry/stubs';
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

const DENY_MESSAGE_KEY = 'toolsV2.swarm.agentDeniedInSwarmMode';

describe('AgentHelloWorldService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executorEvents: ToolExecutorEventStubs;
  let permissionGateRan: boolean;
  let formatDenyMessage: Mock<(message: string) => string>;
  let telemetryTrack2: Mock<(event: string, properties?: unknown) => void>;
  let provider: ContextInjectionProvider | undefined;

  beforeEach(() => {
    setLocale('en');
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
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
    formatDenyMessage = mock((message: string) => message);
    ix.stub(IAgentToolApprovalService, { formatDenyMessage });
    telemetryTrack2 = mock();
    ix.stub(ITelemetryService, { track2: telemetryTrack2 });
    registerTestAgentWire(ix, testWireScope('wire', 'hello-world-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    registerTestEventDispatcher(ix);
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

  function reminder(
    lastDisclosure?: { readonly kind: 'hello_world_mode'; readonly state: 'active' | 'inactive' },
  ): ContextInjectionResult | undefined {
    return provider?.({
      injectedPositions: [],
      lastInjectedAt: null,
      lastInjection: undefined,
      lastDisclosure,
      isNewTurn: true,
    } as ContextInjectionContext) as ContextInjectionResult | undefined;
  }

  it('enter / exit toggle isActive and emit agent.status.updated via wire', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    const events: { readonly type: string; readonly helloWorldMode?: boolean }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({
            type: e.type,
            helloWorldMode: (e as AgentStatusUpdated).helloWorldMode,
          });
        }
      }),
    );

    expect(helloWorld.isActive).toBe(false);
    helloWorld.enter('manual');
    expect(helloWorld.isActive).toBe(true);
    helloWorld.exit();
    expect(helloWorld.isActive).toBe(false);

    expect(events).toEqual([
      { type: 'agent.status.updated', helloWorldMode: true },
      { type: 'agent.status.updated', helloWorldMode: false },
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

  it('renders the same reminder text as swarm mode (placeholder contract)', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');

    const result = reminder();
    expect(result).toEqual({
      content: HELLO_WORLD_MODE_ENTER_REMINDER,
      disclosure: { kind: 'hello_world_mode', state: 'active' },
    });
    expect(HELLO_WORLD_MODE_ENTER_REMINDER).toBe(SWARM_MODE_ENTER_REMINDER);
  });

  it('renders no reminder for tool-triggered entries', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('tool');

    expect(reminder()).toBeUndefined();
  });

  it('renders the exit reminder when the mode leaves a trailing enter disclosure', () => {
    void ix.get(IAgentHelloWorldService);

    expect(
      reminder({ kind: 'hello_world_mode', state: 'active' }),
    ).toEqual({
      content: HELLO_WORLD_MODE_EXIT_REMINDER,
      disclosure: { kind: 'hello_world_mode', state: 'inactive' },
    });
  });

  it('renders nothing when neither active nor previously rendered', () => {
    void ix.get(IAgentHelloWorldService);

    expect(reminder()).toBeUndefined();
    expect(reminder({ kind: 'hello_world_mode', state: 'inactive' })).toBeUndefined();
  });

  it('vetoes the Agent tool while hello-world mode is active with the swarm deny text', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');

    const decision = await fire(makeHookContext([makeToolCall('Agent', 'call_agent')]));

    expect(decision).toEqual({
      veto: { output: t(DENY_MESSAGE_KEY), isError: true },
    });
    expect(permissionGateRan).toBe(false);
    expect(formatDenyMessage).toHaveBeenCalledWith(t(DENY_MESSAGE_KEY));
  });

  it('allows the Agent tool when hello-world mode is inactive', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');
    helloWorld.exit();

    const decision = await fire(makeHookContext([makeToolCall('Agent', 'call_agent')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
    expect(formatDenyMessage).not.toHaveBeenCalled();
  });

  it('allows AgentSwarm while hello-world mode is active', async () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('manual');

    const decision = await fire(makeHookContext([makeToolCall('AgentSwarm', 'call_swarm')]));

    expect(decision).toBeUndefined();
    expect(permissionGateRan).toBe(true);
  });

  it('auto-exits after the turn for task-triggered entries', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('task');

    ix.get(IEventBus).publish(
      new TurnEnded({ agentId: 'test-agent', turnId: 1, reason: 'completed' }),
      ix.get(IAgentScopeContext).agentContext,
    );

    expect(helloWorld.isActive).toBe(false);
  });

  it('auto-exits after the turn for tool-triggered entries', () => {
    const helloWorld = ix.get(IAgentHelloWorldService);
    helloWorld.enter('tool');

    ix.get(IEventBus).publish(
      new TurnEnded({ agentId: 'test-agent', turnId: 1, reason: 'completed' }),
      ix.get(IAgentScopeContext).agentContext,
    );

    expect(helloWorld.isActive).toBe(false);
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
});
