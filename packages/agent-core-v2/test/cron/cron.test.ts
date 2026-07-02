import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/app/bootstrap';
import { IConfigRegistry, IConfigService } from '#/app/config';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import type { ContextMessage } from '#/agent/contextMemory';
import { IAgentCronService } from '#/agent/cron';
import { AgentCronService } from '#/agent/cron/cronService';
import { ILogService } from '#/app/log';
import { IAgentPromptService } from '#/agent/prompt';
import { ISessionContext } from '#/session/sessionContext';
import {
  InMemoryStorageService,
  IStorageService,
  IAtomicDocumentStore,
  IAtomicTomlDocumentStore,
  TomlAtomicDocumentStore,
} from '#/app/storage';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { IAgentTurnService, type Turn } from '#/agent/turn';
import { IAgentWireRecordService } from '#/agent/wireRecord';

import { IAgentEventSinkService } from '#/agent/eventSink';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubWireRecord } from '../contextMemory/stubs';
import { stubLog } from '../log/stubs';
import { stubTurn } from '../turn/stubs';

const FAR_FUTURE_MS = 10 * 366 * 24 * 60 * 60 * 1000;

function fakeTurn(): Turn {
  return {
    id: 1,
    abortController: new AbortController(),
    ready: Promise.resolve(),
    result: Promise.resolve({ reason: 'completed' }),
  };
}

function textOf(message: ContextMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

// NOTE: the legacy `CronFireCoordinator` (which steered the main agent on fire
// through `IAgentTurnService.steer`) no longer exists in HEAD. Fire delivery now
// lives inside `AgentCronService` itself: a due, idle task is delivered via
// `IAgentPromptService.steer`. The cases below cover that path directly, so there is
// no separate coordinator suite to migrate.

describe('AgentCronService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let now: number;
  let activeTurn: Turn | undefined;
  let steered: ContextMessage[];

  beforeEach(() => {
    vi.stubEnv('KIMI_CRON_POLL_INTERVAL_MS', '0');
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    now = 0;
    activeTurn = undefined;
    steered = [];
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const turnService: IAgentTurnService = {
      ...stubTurn(),
      getActiveTurn: () => activeTurn,
    };

    ix.stub(IAgentPromptService, {
      prompt: () => undefined,
      steer: (message) => {
        steered.push(message);
        return fakeTurn();
      },
      retry: () => undefined,
      undo: () => 0,
      clear: () => {},
    });
    ix.stub(IAgentEventSinkService, { emit: () => {}, on: () => ({ dispose: () => {} }) });
    ix.stub(IAgentWireRecordService, stubWireRecord());
    ix.stub(IAgentTurnService, turnService);
    ix.stub(ITelemetryService, { track: () => {} });
    ix.stub(IAgentToolRegistryService, { register: () => ({ dispose: () => {} }) });
    ix.stub(IBootstrapService, stubBootstrap());
    ix.stub(ISessionContext, {
      _serviceBrand: undefined,
      sessionId: 'test-session',
      workspaceId: 'test-workspace',
      sessionDir: '/tmp/kimi-cron-test/session',
      metaScope: 'session',
    });
    ix.stub(ILogService, stubLog());
    ix.stub(IStorageService, new InMemoryStorageService());
    ix.stub(IAtomicDocumentStore, {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    });
    ix.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    ix.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    ix.set(IConfigService, new SyncDescriptor(ConfigService));
    ix.set(
      IAgentCronService,
      new SyncDescriptor(AgentCronService, [{}]),
    );
  });
  afterEach(() => {
    disposables.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('addTask / list / removeTasks', () => {
    const svc = ix.get(IAgentCronService);
    const task = svc.addTask({ cron: '* * * * *', prompt: 'hi', recurring: false });

    expect(svc.list()).toHaveLength(1);
    svc.removeTasks([task.id]);
    expect(svc.list()).toEqual([]);
  });

  it('does not fire while a turn is active', () => {
    const svc = ix.get(IAgentCronService);
    svc.addTask({ cron: '* * * * *', prompt: 'fire-me', recurring: false });

    activeTurn = fakeTurn();
    now = FAR_FUTURE_MS;
    svc.tick();

    expect(steered).toEqual([]);
  });

  it('fires a due task when idle', () => {
    const svc = ix.get(IAgentCronService);
    svc.addTask({ cron: '* * * * *', prompt: 'fire-me', recurring: false });

    now = FAR_FUTURE_MS;
    svc.tick();

    expect(steered).toHaveLength(1);
    expect(textOf(steered[0]!)).toContain('fire-me');
    expect(steered[0]!.origin).toMatchObject({ kind: 'cron_job' });
  });

  it('removes one-shot tasks after firing', () => {
    const svc = ix.get(IAgentCronService);
    svc.addTask({ cron: '* * * * *', prompt: 'x', recurring: false });

    now = FAR_FUTURE_MS;
    svc.tick();

    expect(svc.list()).toEqual([]);
  });
});
