import { t, setLocale } from '@moonshot-ai/kimi-i18n';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { AgentSwarmService } from '#/features/swarm/agent/swarmService';
import { ISessionSwarmService } from '#/features/swarm/session/sessionSwarm';
import type { ToolCall } from '#/kosong/contract/message';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { stubContextMemory } from '../../agent/contextMemory/stubs';
import {
  stubToolExecutorEvents,
  type ToolExecutorEventStubs,
} from '../../agent/toolExecutor/stubs';
import { registerTestAgentWire, registerTestEventDispatcher, testWireScope } from '../../wire/stubs';

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

function expectedDenyMessage(): string {
  return t(DENY_MESSAGE_KEY);
}

function expectedVetoShape(): { veto: { output: string; isError: boolean } } {
  return {
    veto: {
      output: expectedDenyMessage(),
      isError: true,
    },
  };
}

describe('AgentSwarmService —Agent tool veto in swarm mode', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executorEvents: ToolExecutorEventStubs;
  let permissionGateRan: boolean;
  let formatDenyMessage: Mock<(message: string) => string>;

  beforeEach(() => {
    setLocale('en');
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.stub(IAgentLoopService, {
      status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
    });
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.stub(IAgentLifecycleService, {});
    ix.stub(ISessionSwarmService, {
      getSwarmItem: async () => {},
      run: async () => [],
      cancel: () => {},
    });
    executorEvents = stubToolExecutorEvents();
    permissionGateRan = false;
    ix.stub(IAgentToolExecutorService, executorEvents.executor);
    formatDenyMessage = vi.fn((message: string) => message);
    ix.stub(IAgentToolApprovalService, { formatDenyMessage });
    registerTestAgentWire(ix, testWireScope('wire', 'swarm-agent-veto'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    registerTestEventDispatcher(ix);
    ix.set(IAgentSystemReminderService, new SyncDescriptor(AgentSystemReminderService));
    ix.stub(IAgentContextInjectorService, {
      register: () => ({ dispose: () => {} }),
    } as unknown as IAgentContextInjectorService);
    ix.set(IAgentSwarmService, new SyncDescriptor(AgentSwarmService));
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

  describe('core veto behavior', () => {
    it('vetoes the Agent tool while swarm mode is active', async () => {
      const swarm = ix.get(IAgentSwarmService);
      swarm.enter('manual');

      const decision = await fire(makeHookContext([makeToolCall('Agent', 'call_agent')]));

      expect(decision).toEqual(expectedVetoShape());
      expect(permissionGateRan).toBe(false);
      expect(formatDenyMessage).toHaveBeenCalledTimes(1);
      expect(formatDenyMessage).toHaveBeenCalledWith(expectedDenyMessage());
    });

    it('allows the Agent tool when swarm mode has never been activated', async () => {
      void ix.get(IAgentSwarmService);

      const decision = await fire(makeHookContext([makeToolCall('Agent', 'call_agent')]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('allows the Agent tool after swarm mode exits', async () => {
      const swarm = ix.get(IAgentSwarmService);
      swarm.enter('manual');
      swarm.exit();

      const decision = await fire(makeHookContext([makeToolCall('Agent', 'call_agent')]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('allows the Agent tool after re-entering and exiting again (idempotency)', async () => {
      const swarm = ix.get(IAgentSwarmService);

      swarm.enter('task');
      swarm.exit();
      swarm.enter('tool');
      swarm.exit();

      const decision = await fire(makeHookContext([makeToolCall('Agent', 'call_agent')]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
    });
  });

  describe('non-target tools pass through in swarm mode', () => {
    it('does not veto Read in swarm mode', async () => {
      const swarm = ix.get(IAgentSwarmService);
      swarm.enter('manual');

      const decision = await fire(makeHookContext([makeToolCall('Read', 'call_read')]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });

    it('does not veto Bash in swarm mode', async () => {
      const swarm = ix.get(IAgentSwarmService);
      swarm.enter('manual');

      const decision = await fire(makeHookContext([makeToolCall('Bash', 'call_bash')]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
    });

    it('does not veto AgentSwarm in swarm mode (the correct subagent dispatch tool)', async () => {
      const swarm = ix.get(IAgentSwarmService);
      swarm.enter('manual');

      const decision = await fire(makeHookContext([makeToolCall('AgentSwarm', 'call_swarm')]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
      expect(formatDenyMessage).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('vetoes Agent even when batched with other tools (Agent is adjudicating)', async () => {
      const swarm = ix.get(IAgentSwarmService);
      swarm.enter('manual');

      const decision = await fire(
        makeHookContext([makeToolCall('Agent', 'call_agent'), makeToolCall('Read', 'call_read')]),
      );

      expect(decision).toEqual(expectedVetoShape());
      expect(permissionGateRan).toBe(false);
    });

    it('vetoes Agent for every trigger type (manual / task / tool)', async () => {
      const triggers: Array<'manual' | 'task' | 'tool'> = ['manual', 'task', 'tool'];

      for (const trigger of triggers) {
        const swarm = ix.get(IAgentSwarmService);
        swarm.enter(trigger);

        const decision = await fire(makeHookContext([makeToolCall('Agent', `call_${trigger}`)]));

        expect(decision).toEqual(expectedVetoShape());
        expect(formatDenyMessage).toHaveBeenCalled();

        swarm.exit();
        permissionGateRan = false;
        vi.clearAllMocks();
      }
    });

    it('correctly reports isActive state transitions', async () => {
      const swarm = ix.get(IAgentSwarmService);

      expect(swarm.isActive).toBe(false);

      swarm.enter('manual');
      expect(swarm.isActive).toBe(true);

      swarm.exit();
      expect(swarm.isActive).toBe(false);

      swarm.enter('task');
      expect(swarm.isActive).toBe(true);
    });

    it('idempotent enter (calling enter twice) does not break veto behavior', async () => {
      const swarm = ix.get(IAgentSwarmService);
      swarm.enter('manual');
      swarm.enter('manual');

      const decision = await fire(makeHookContext([makeToolCall('Agent', 'call_agent')]));
      expect(decision).toEqual(expectedVetoShape());
    });

    it('idempotent exit (calling exit when not active) does not throw', async () => {
      const swarm = ix.get(IAgentSwarmService);

      expect(() => swarm.exit()).not.toThrow();
      expect(swarm.isActive).toBe(false);
    });
  });
});
