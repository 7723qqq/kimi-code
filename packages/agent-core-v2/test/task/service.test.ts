import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentTaskService, type AgentTask } from '#/agent/task';
import { AgentTaskService } from '#/agent/task/taskService';
import { IConfigRegistry, IConfigService } from '#/app/config';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentPromptService } from '#/agent/prompt';
import { IAgentRecordService } from '#/agent/record';
import { ISessionContext } from '#/session/sessionContext';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { IAgentWireRecordService } from '#/agent/wireRecord';
import { createHooks } from '#/hooks';

import { stubContextMemory, stubWireRecord } from '../contextMemory/stubs';

function fakeProcessTask(): AgentTask {
  return {
    idPrefix: 'test',
    kind: 'process',
    description: 'fake process task',
    start: () => {},
    toInfo: (base) => ({ ...base, kind: 'process', command: 'echo', pid: 0, exitCode: null }),
  };
}

describe('AgentTaskService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentWireRecordService, stubWireRecord());
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(IAgentRecordService, {
      hooks: createHooks(['onRestoredRecord', 'onResumeEnded']) as IAgentRecordService['hooks'],
      append: () => {},
      on: () => toDisposable(() => {}),
      define: () => toDisposable(() => {}),
      signal: () => {},
    });
    ix.stub(ITelemetryService, { track: () => {} });
    ix.stub(IAgentToolRegistryService, {
      register: () => toDisposable(() => {}),
    });
    ix.stub(IAgentPromptService, { steer: () => undefined });
    ix.stub(IConfigRegistry, { registerSection: () => {} });
    ix.stub(IConfigService, {
      get: (() => undefined) as IConfigService['get'],
    });
    ix.stub(ISessionContext, {
      sessionId: 'test-session',
      workspaceId: 'test-ws',
      sessionDir: '/tmp/test-session',
      metaScope: 'sessions/test-ws/test-session/session-meta',
    });
    ix.stub(IAtomicDocumentStore, {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    });
    ix.stub(IFileSystemStorageService, {
      read: async () => undefined,
      readStream: async function* () {},
      write: async () => {},
      append: async () => {},
      list: async () => [],
      delete: async () => {},
      flush: async () => {},
      close: async () => {},
    });
    ix.set(IAgentTaskService, new SyncDescriptor(AgentTaskService));
  });
  afterEach(() => disposables.dispose());

  it('registerTask / list / readOutput / stop', async () => {
    const svc = ix.get(IAgentTaskService);
    const id = svc.registerTask(fakeProcessTask());
    const listed = svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.taskId).toBe(id);
    expect(listed[0]?.kind).toBe('process');
    expect(await svc.readOutput(id)).toBe('');
    await svc.stop(id);
  });
});
