import { t, setLocale } from '@moonshot-ai/kimi-i18n';
/**
 * Test: Agent tool is hard-denied while swarm mode is active.
 *
 * These tests verify the veto listener added to AgentSwarmService that blocks
 * the `Agent` tool when swarm mode is on —the hard enforcement counterpart to
 * the soft enter-reminder constraint.
 *
 * Coverage matrix:
 *
 * | Swarm State | Tool           | Expected      | Case ID |
 * |-------------|----------------|---------------|---------|
 * | active      | Agent          | 鉂?VETO       | 1, 5    |
 * | inactive    | Agent          | 鉁?pass-through| 2       |
 * | exited      | Agent          | 鉁?pass-through| 3       |
 * | active      | Read (other)   | 鉁?pass-through| 4       |
 * | active      | AgentSwarm     | 鉁?pass-through| 6       |
 * | active      | Agent + mixed  | 鉂?VETO       | 5       |
 */
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

// 鈹€鈹€ Helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

const signal = new AbortController().signal;

/** Creates a minimal ToolCall for testing. */
function makeToolCall(name: string, id: string): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

/** Creates a hook context where the first toolCalls entry is the one being adjudicated. */
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

/** The i18n key for the deny message produced by agentDeniedInSwarmModeMessage(). */
const DENY_MESSAGE_KEY = 'toolsV2.swarm.agentDeniedInSwarmMode';

/** The exact deny message in the current locale (en by default in tests). */
function expectedDenyMessage(): string {
  return t(DENY_MESSAGE_KEY);
}

/** Shape of a veto decision returned by our listener. */
function expectedVetoShape(): { veto: { output: string; isError: boolean } } {
  return {
    veto: {
      output: expectedDenyMessage(),
      isError: true,
    },
  };
}

// 鈹€鈹€ Test Suite 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

describe('AgentSwarmService —Agent tool veto in swarm mode', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executorEvents: ToolExecutorEventStubs;
  /** Tracks whether a downstream permission gate ran (proves veto short-circuits). */
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
    // AgentSwarmService contributes the replayable `swarm` state key at
    // construction and reads it back through `agentState`; a real
    // AgentStateService plus a dispatcher make enter/exit drive `isActive`.
    registerTestEventDispatcher(ix);
    ix.set(IAgentSystemReminderService, new SyncDescriptor(AgentSystemReminderService));
    // SwarmInjection (constructed with AgentSwarmService) registers a
    // context-injection provider; the veto suite only exercises the veto
    // listeners, so a no-op injector is enough.
    ix.stub(IAgentContextInjectorService, {
      register: () => ({ dispose: () => {} }),
    } as unknown as IAgentContextInjectorService);
    ix.set(IAgentSwarmService, new SyncDescriptor(AgentSwarmService));
  });

  afterEach(() => disposables.dispose());

  /**
   * Fires the before-execute pipeline and returns the decision.
   * Registers a downstream listener that sets `permissionGateRan = true`
   * so we can verify that the veto short-circuits before reaching it.
   */
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

  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
  // Core veto behavior
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

  describe('core veto behavior', () => {
    it('vetoes the Agent tool while swarm mode is active', async () => {
      const swarm = ix.get(IAgentSwarmService);
      swarm.enter('manual');

      const decision = await fire(makeHookContext([makeToolCall('Agent', 'call_agent')]));

      // Must return a veto with exact shape
      expect(decision).toEqual(expectedVetoShape());
      // Veto must short-circuit —downstream gate must NOT have run
      expect(permissionGateRan).toBe(false);
      // Deny message must be formatted exactly once through the approval service
      expect(formatDenyMessage).toHaveBeenCalledTimes(1);
      expect(formatDenyMessage).toHaveBeenCalledWith(expectedDenyMessage());
    });

    it('allows the Agent tool when swarm mode has never been activated', async () => {
      // Intentionally NOT calling swarm.enter() —service exists but swarm is off
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

      // Cycle: active 鈫?exit 鈫?active 鈫?exit 鈫?verify Agent is allowed
      swarm.enter('task');
      swarm.exit();
      swarm.enter('tool');
      swarm.exit();

      const decision = await fire(makeHookContext([makeToolCall('Agent', 'call_agent')]));

      expect(decision).toBeUndefined();
      expect(permissionGateRan).toBe(true);
    });
  });

  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
  // Non-target tools are not affected
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

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

  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
  // Edge cases
  // 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

  describe('edge cases', () => {
    it('vetoes Agent even when batched with other tools (Agent is adjudicating)', async () => {
      const swarm = ix.get(IAgentSwarmService);
      swarm.enter('manual');

      // Agent is toolCalls[0] 鈫?the one being adjudicated
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

        // Clean up for next iteration
        swarm.exit();
        permissionGateRan = false;
        vi.clearAllMocks();
      }
    });

    it('correctly reports isActive state transitions', async () => {
      const swarm = ix.get(IAgentSwarmService);

      // Initially inactive
      expect(swarm.isActive).toBe(false);

      swarm.enter('manual');
      expect(swarm.isActive).toBe(true);

      swarm.exit();
      expect(swarm.isActive).toBe(false);

      // Re-enter with different trigger
      swarm.enter('task');
      expect(swarm.isActive).toBe(true);
    });

    it('idempotent enter (calling enter twice) does not break veto behavior', async () => {
      const swarm = ix.get(IAgentSwarmService);
      swarm.enter('manual');
      swarm.enter('manual'); // Second enter should be no-op (guard in swarmService)

      // Swarm should still be active and still veto Agent
      const decision = await fire(makeHookContext([makeToolCall('Agent', 'call_agent')]));
      expect(decision).toEqual(expectedVetoShape());
    });

    it('idempotent exit (calling exit when not active) does not throw', async () => {
      const swarm = ix.get(IAgentSwarmService);

      // Never entered —exit should be safe no-op
      expect(() => swarm.exit()).not.toThrow();
      expect(swarm.isActive).toBe(false);
    });
  });
});
