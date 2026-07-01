import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentBackgroundService } from '#/agent/background';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';
import { ILogService } from '#/app/log';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import type { IScopeHandle } from '#/_base/di/scope';
import { IKaos } from '#/app/kaos';
import { ISessionMetadata } from '#/session/session-metadata';
import { ISessionProcessRunner } from '#/session/process';
import { ISessionSubagentHost, SessionSubagentHostService } from '#/session/subagentHost';

function fakeProfileScope(id: string): IScopeHandle {
  const profile = {
    data: vi.fn(() => ({
      cwd: '/repo',
      modelAlias: 'parent-model',
      thinkingLevel: 'medium',
      systemPrompt: 'parent prompt',
      activeToolNames: ['Read', 'Write'],
    })),
    update: vi.fn(),
  };
  return {
    id,
    accessor: {
      get: vi.fn((token: unknown) => (token === IAgentProfileService ? profile : undefined)),
    },
  } as unknown as IScopeHandle;
}

describe('SessionSubagentHostService DI wiring', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
  });

  afterEach(() => disposables.dispose());

  it('uses the built-in host behavior when no host override is provided', async () => {
    const register = vi.fn(() => ({ dispose: () => {} }));
    const parent = fakeProfileScope('main');
    const child = fakeProfileScope('child');
    ix.stub(IAgentLifecycleService, {
      getHandle: vi.fn().mockReturnValue(undefined),
      createMain: vi.fn().mockResolvedValue(parent),
      create: vi.fn().mockResolvedValue(child),
    });
    ix.stub(ISessionMetadata, {
      ready: Promise.resolve(),
      read: vi.fn().mockResolvedValue({ agents: {} }),
      onDidChangeMetadata: () => ({ dispose: () => {} }),
      update: vi.fn(),
      setTitle: vi.fn(),
      setArchived: vi.fn(),
      registerAgent: vi.fn(),
    });
    ix.stub(IAgentToolRegistryService, { register });
    ix.stub(IAgentBackgroundService, {});
    ix.stub(IAgentProfileService, { isToolActive: vi.fn().mockReturnValue(false) });
    ix.stub(IKaos, { cwd: '/repo' });
    ix.stub(ISessionProcessRunner, { exec: vi.fn() });
    ix.stub(ILogService, { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() });
    ix.set(ISessionSubagentHost, new SyncDescriptor(SessionSubagentHostService));

    const service = ix.get(ISessionSubagentHost);

    expect(service).toBeInstanceOf(SessionSubagentHostService);
    expect(register).toHaveBeenCalledTimes(1);
    await expect(service.startBtw()).resolves.toBe('child');
  });
});
