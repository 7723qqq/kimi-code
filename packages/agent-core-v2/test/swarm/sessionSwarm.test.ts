import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/_base/di/scope';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IEventBus, type DomainEvent } from '#/app/event/eventBus';
import { IAgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import {
  IAgentLifecycleService,
  type AgentTaskHooks,
  type CreateAgentOptions,
} from '#/session/agentLifecycle/agentLifecycle';
import { labelsFromAgentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { createHooks } from '#/hooks';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionMetadata,
  type AgentMeta,
  type SessionMetadataChangedEvent,
} from '#/session/sessionMetadata/sessionMetadata';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ILogService } from '#/_base/log/log';
import {
  AgentRunBatch,
  resolveSwarmMaxConcurrency,
  type AgentRunBatchLauncher,
  type AgentSpawnAttemptOptions,
  type QueuedAgentRunTask,
} from '#/session/swarm/agentRunBatch';
import { ISessionSwarmService, type SessionSwarmTask } from '#/session/swarm/sessionSwarm';
import { SessionSwarmService } from '#/session/swarm/sessionSwarmService';

import { stubLog } from '../log/stubs';

describe('resolveSwarmMaxConcurrency', () => {
  it('returns undefined when the variable is unset', () => {
    expect(resolveSwarmMaxConcurrency({})).toBeUndefined();
  });

  it('returns undefined for empty or whitespace-only values', () => {
    expect(
      resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '' }),
    ).toBeUndefined();
    expect(
      resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '   ' }),
    ).toBeUndefined();
  });

  it('throws for non-positive, non-integer, or non-numeric values', () => {
    for (const raw of ['0', '-1', '2.5', 'abc']) {
      expect(() =>
        resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: raw }),
      ).toThrow(/KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY.*positive integer/);
    }
  });

  it('returns the integer for a positive integer value', () => {
    expect(resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '3' })).toBe(3);
    expect(resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: ' 8 ' })).toBe(8);
  });
});

describe('AgentRunBatch swarm item forwarding', () => {
  function recordingLauncher() {
    const spawned: AgentSpawnAttemptOptions[] = [];
    let nextId = 1;
    const launcher: AgentRunBatchLauncher = {
      spawn: vi.fn(async (options) => {
        spawned.push(options);
        return {
          agentId: `agent-${String(nextId++)}`,
          profileName: options.profileName,
          completion: Promise.resolve({ result: 'ok' }),
        };
      }),
      resume: vi.fn(async () => {
        throw new Error('unexpected resume');
      }),
      retry: vi.fn(async () => {
        throw new Error('unexpected retry');
      }),
    };
    return { launcher, spawned };
  }

  function spawnTask(swarmItem?: string): QueuedAgentRunTask {
    return {
      kind: 'spawn',
      data: {},
      profileName: 'subagent',
      parentToolCallId: 'call_swarm',
      prompt: 'Review the file',
      description: 'Review #1 (subagent)',
      swarmItem,
      runInBackground: false,
    };
  }

  it('forwards swarmItem from a spawn task to launcher.spawn', async () => {
    const { launcher, spawned } = recordingLauncher();

    const results = await new AgentRunBatch(launcher, [spawnTask('src/a.ts')]).run();

    expect(launcher.spawn).toHaveBeenCalledOnce();
    expect(spawned[0]).toMatchObject({
      profileName: 'subagent',
      swarmItem: 'src/a.ts',
    });
    expect(results).toMatchObject([{ status: 'completed', agentId: 'agent-1' }]);
  });

  it('leaves swarmItem undefined for spawn tasks without one', async () => {
    const { launcher, spawned } = recordingLauncher();

    await new AgentRunBatch(launcher, [spawnTask()]).run();

    expect(launcher.spawn).toHaveBeenCalledOnce();
    expect(spawned[0]?.swarmItem).toBeUndefined();
  });
});

describe('SessionSwarmService metadata compatibility', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let agents: Record<string, AgentMeta>;
  let handles: Map<string, IAgentScopeHandle>;
  let lifecycle: IAgentLifecycleService;
  let createAgent: ReturnType<typeof vi.fn>;
  let runAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    agents = {};
    handles = new Map();
    const eventBus = eventBusStub();
    lifecycle = lifecycleStub(handles, eventBus);
    createAgent = lifecycle.create as ReturnType<typeof vi.fn>;
    runAgent = lifecycle.run as ReturnType<typeof vi.fn>;
    handles.set('main', agentHandle('main', lifecycle, eventBus));

    ix.stub(IAgentLifecycleService, lifecycle);
    ix.stub(IAgentProfileCatalogService, {
      _serviceBrand: undefined,
      get: (name: string) =>
        name === 'coder'
          ? { name: 'coder', tools: [], systemPrompt: () => '' }
          : undefined,
      getDefault: () => ({ name: 'agent', tools: [], systemPrompt: () => '' }),
      list: () => [],
    });
    ix.stub(
      ISessionContext,
      makeSessionContext({
        sessionId: 's1',
        workspaceId: 'w1',
        sessionDir: '/tmp/kimi/s1',
        sessionScope: 'sessions/w1/s1',
        cwd: '/repo',
      }),
    );
    ix.stub(ISessionMetadata, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeMetadata: Event.None as Event<SessionMetadataChangedEvent>,
      read: async () => ({
        id: 's1',
        createdAt: 0,
        updatedAt: 0,
        archived: false,
        agents,
      }),
      update: async () => {},
      setTitle: async () => {},
      setArchived: async () => {},
      registerAgent: async (agentId, meta) => {
        agents[agentId] = meta;
      },
    });
    ix.stub(ISessionProcessRunner, {
      _serviceBrand: undefined,
      exec: async () => {
        throw new Error('unexpected process exec');
      },
    });
    ix.stub(ILogService, stubLog());
    ix.set(ISessionSwarmService, new SyncDescriptor(SessionSwarmService));
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('reads swarm items from caller-owned v2 labels and legacy v1 metadata', async () => {
    agents['v2-child'] = {
      homedir: '/tmp/kimi/s1/agents/v2-child',
      labels: { parentAgentId: 'main', swarmItem: 'src/a.ts' },
    };
    agents['legacy-child'] = {
      homedir: '/tmp/kimi/s1/agents/legacy-child',
      type: 'sub',
      parentAgentId: 'main',
      swarmItem: 'src/legacy.ts',
    };
    agents['other-child'] = {
      homedir: '/tmp/kimi/s1/agents/other-child',
      labels: { parentAgentId: 'other', swarmItem: 'src/other.ts' },
    };

    const service = ix.get(ISessionSwarmService);

    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'v2-child' }),
    ).resolves.toBe('src/a.ts');
    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'legacy-child' }),
    ).resolves.toBe('src/legacy.ts');
    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'other-child' }),
    ).resolves.toBeUndefined();
    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'missing' }),
    ).resolves.toBeUndefined();
  });

  it('prefers labels over legacy metadata fields when both are present', async () => {
    agents['mixed-child'] = {
      homedir: '/tmp/kimi/s1/agents/mixed-child',
      labels: { parentAgentId: 'main', swarmItem: 'src/labels.ts' },
      type: 'sub',
      parentAgentId: 'other',
      swarmItem: 'src/legacy.ts',
    };

    const service = ix.get(ISessionSwarmService);

    await expect(
      service.getSwarmItem({ callerAgentId: 'main', agentId: 'mixed-child' }),
    ).resolves.toBe('src/labels.ts');
    await expect(
      service.getSwarmItem({ callerAgentId: 'other', agentId: 'mixed-child' }),
    ).resolves.toBeUndefined();
  });

  it('normalizes legacy subagent metadata into labels for new writes', () => {
    expect(
      labelsFromAgentMeta({
        homedir: '/tmp/kimi/s1/agents/legacy-child',
        type: 'sub',
        parentAgentId: 'main',
        swarmItem: 'src/legacy.ts',
      }),
    ).toEqual({ parentAgentId: 'main', swarmItem: 'src/legacy.ts' });
    expect(
      labelsFromAgentMeta({
        homedir: '/tmp/kimi/s1/agents/mixed-child',
        labels: { parentAgentId: 'main', swarmItem: 'src/labels.ts', custom: 'kept' },
        type: 'sub',
        parentAgentId: 'other',
        swarmItem: 'src/legacy.ts',
      }),
    ).toEqual({ parentAgentId: 'main', swarmItem: 'src/labels.ts', custom: 'kept' });
  });

  it('persists caller ownership and swarm item labels on spawned children', async () => {
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [spawnSessionTask('src/a.ts')],
      }),
    ).resolves.toMatchObject([
      {
        agentId: 'agent-new',
        status: 'completed',
        result: 'child summary',
      },
    ]);

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: {
          profile: 'coder',
          model: 'kimi-test',
          thinking: 'medium',
          cwd: '/repo',
        },
        permissionMode: 'auto',
        labels: { parentAgentId: 'main', swarmItem: 'src/a.ts' },
      }),
    );
  });

  it('keeps v1 resume ownership errors inside the per-subagent result', async () => {
    agents['other-child'] = {
      homedir: '/tmp/kimi/s1/agents/other-child',
      labels: { parentAgentId: 'other', swarmItem: 'src/other.ts' },
    };
    handles.set('other-child', agentHandle('other-child', lifecycle, eventBusStub()));
    const service = ix.get(ISessionSwarmService);

    await expect(
      service.run({
        callerAgentId: 'main',
        tasks: [resumeSessionTask('other-child')],
      }),
    ).resolves.toMatchObject([
      {
        status: 'failed',
        state: 'not_started',
        error: 'Agent instance "other-child" does not belong to this parent agent',
      },
    ]);
    expect(runAgent).not.toHaveBeenCalled();
  });
});

function spawnSessionTask(swarmItem?: string): SessionSwarmTask {
  return {
    kind: 'spawn',
    data: {},
    profileName: 'coder',
    parentToolCallId: 'call_swarm',
    prompt: 'Review the file',
    description: 'Review #1 (coder)',
    swarmIndex: 1,
    swarmItem,
    runInBackground: false,
  };
}

function resumeSessionTask(agentId: string): SessionSwarmTask {
  return {
    kind: 'resume',
    data: {},
    profileName: 'subagent',
    parentToolCallId: 'call_swarm',
    prompt: 'Continue',
    description: 'Resume #1 (resume)',
    swarmIndex: 1,
    runInBackground: false,
    resumeAgentId: agentId,
  };
}

function lifecycleStub(
  handles: Map<string, IAgentScopeHandle>,
  eventBus: IEventBus,
): IAgentLifecycleService {
  const hooks = createHooks<AgentTaskHooks, keyof AgentTaskHooks>([
    'onWillStartAgentTask',
    'onDidStopAgentTask',
  ]);
  const lifecycle = {
    _serviceBrand: undefined,
    hooks,
    onDidCreate: Event.None,
    onDidCreateMain: Event.None,
    onDidDispose: Event.None,
    create: vi.fn(async (opts: CreateAgentOptions = {}) => {
      const id = opts.agentId ?? 'agent-new';
      const handle = agentHandle(id, lifecycle as IAgentLifecycleService, eventBus, {
        profileName: opts.binding?.profile ?? 'coder',
        modelAlias: opts.binding?.model ?? 'kimi-test',
        thinkingLevel: opts.binding?.thinking ?? 'medium',
        cwd: opts.binding?.cwd ?? '/repo',
      });
      handles.set(id, handle);
      return handle;
    }),
    ensureMcpReady: async () => {},
    notifyMainCreated: () => {},
    fork: vi.fn(),
    run: vi.fn(async (agentId: string) => ({
      agentId,
      turn: {} as never,
      completion: Promise.resolve({ summary: 'child summary' }),
    })),
    getHandle: (agentId: string) => handles.get(agentId),
    list: () => [...handles.values()],
    remove: async (agentId: string) => {
      handles.delete(agentId);
    },
  };
  return lifecycle as IAgentLifecycleService;
}

function agentHandle(
  id: string,
  lifecycle: IAgentLifecycleService,
  eventBus: IEventBus,
  data: Partial<ProfileData> = {},
): IAgentScopeHandle {
  const profile = profileService({
    cwd: '/repo',
    modelAlias: 'kimi-test',
    modelCapabilities: {} as never,
    profileName: 'agent',
    thinkingLevel: 'medium',
    systemPrompt: '',
    ...data,
  });
  const permissionMode = {
    _serviceBrand: undefined,
    mode: 'auto',
    setMode: () => {},
    hooks: createHooks(['onChanged']),
  } as IAgentPermissionModeService;
  return {
    id,
    kind: LifecycleScope.Agent,
    accessor: {
      get: ((serviceId: unknown) => {
        if (serviceId === IAgentProfileService) return profile;
        if (serviceId === IAgentPermissionModeService) return permissionMode;
        if (serviceId === IEventBus) return eventBus;
        if (serviceId === ITelemetryService) return noopTelemetryService;
        if (serviceId === IAgentLifecycleService) return lifecycle;
        return undefined;
      }) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
  };
}

function profileService(data: ProfileData): IAgentProfileService {
  return {
    _serviceBrand: undefined,
    data: () => data,
  } as IAgentProfileService;
}

function eventBusStub(): IEventBus {
  return {
    _serviceBrand: undefined,
    publish: vi.fn((_: DomainEvent) => {}),
    subscribe: vi.fn(() => ({ dispose: () => {} })) as IEventBus['subscribe'],
  };
}
