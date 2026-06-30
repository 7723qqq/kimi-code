import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/contextMemory';
import { IAgentEventSinkService } from '../../src/eventSink';
import { ISessionSubagentHost } from '#/subagentHost';
import { IAgentSystemReminderService } from '#/systemReminder';
import { AgentSystemReminderService } from '#/systemReminder/systemReminderService';
import { IAgentSwarmService } from '#/swarm';
import { AgentSwarmService } from '#/swarm/swarmService';
import { IAgentToolRegistryService, AgentToolRegistryService } from '#/toolRegistry';
import { IAgentTurnService } from '#/turn';
import { IAgentWireRecordService } from '#/wireRecord';

import { stubContextMemory, stubWireRecord } from '../contextMemory/stubs';
import { stubTurnWithHooks } from '../turn/stubs';

describe('AgentSwarmService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(IAgentWireRecordService, stubWireRecord());
    ix.stub(IAgentEventSinkService, { emit: () => {}, on: () => toDisposable(() => {}) });
    ix.stub(IAgentTurnService, stubTurnWithHooks());
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.stub(ISessionSubagentHost, {});
    ix.set(IAgentSystemReminderService, new SyncDescriptor(AgentSystemReminderService));
    ix.set(IAgentSwarmService, new SyncDescriptor(AgentSwarmService));
  });
  afterEach(() => disposables.dispose());

  it('enter / exit toggle isActive', async () => {
    const swarm = ix.get(IAgentSwarmService);
    expect(swarm.isActive).toBe(false);
    swarm.enter('manual');
    expect(swarm.isActive).toBe(true);
    swarm.exit();
    expect(swarm.isActive).toBe(false);
  });
});
