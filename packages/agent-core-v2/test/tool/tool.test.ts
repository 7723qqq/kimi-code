import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { createControlledPromise } from '@antfu/utils';

import { type IAgentScopeHandle } from '#/_base/di/scope';
import { Event, type Event as KimiEvent } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { userCancellationReason } from '#/_base/utils/abort';
import { type AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { IAgentEnvironmentBindingService } from '#/agent/environmentBinding/environmentBinding';
import { agentContextOf, IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentTaskService } from '#/agent/task/task';
import { type AgentTaskSettlement } from '#/agent/task/types';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { SubagentToolInputSchema, type SubagentToolInput } from '#/agent/tools/agent/agent';
import {
  NO_PARTIAL_OUTPUT,
  PARTIAL_OUTPUT_NOTICE,
  SubagentTask,
} from '#/agent/tools/agent/subagent-task';
import { IAgentUserToolService, type UserToolRegistration } from '#/agent/userTool/userTool';
import {
  normalizeAgentProfile,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IWebSearchProviderService } from '#/app/auth/webSearch/webSearch';
import { IConfigService } from '#/app/config/config';
import { Event2 } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { ASSOCIATIVE_MEMORY_FLAG_ID } from '#/features/associativeMemory/flag';
import { LifecycleScope } from '#/app/scopes';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { Error2, ErrorCodes } from '#/errors';
import { ISessionNotify } from '#/features/notify/sessionNotify';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import {
  ISessionSwarmService,
  type SessionSwarmRunArgs,
  type SessionSwarmRunResult,
} from '#/features/swarm/session/sessionSwarm';
import {
  AgentSwarmToolInputSchema,
  type AgentSwarmToolInput,
} from '#/features/swarm/tools/agent-swarm/agent-swarm';
import { TOWER_WORKER_PROFILE } from '#/features/tower/tower';
import { createHooks } from '#/hooks';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import { type IHostProcess } from '#/os/interface/hostProcess';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IHostTimers, type IHostTimerHandle } from '#/os/interface/hostTimers';
import {
  IAgentLifecycleService,
  type AgentScopeCreatedEvent,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { BACKENDS_EXPERIMENTAL_UNAVAILABLE } from '#/session/subagent/backend/configSection';
import { SUBAGENT_BACKENDS_FLAG_ID } from '#/session/subagent/backend/flag';
import {
  ISubagentBackendService,
  type ISubagentBackend,
  type SubagentBackendResult,
  type SubagentBackendRun,
  type SubagentBackendStartRequest,
} from '#/session/subagent/backend/subagentBackend';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  SECONDARY_MODEL_SECTION,
  SUBAGENT_SECTION,
} from '#/session/subagent/configSection';
import { TOOL_SELECT_FLAG_ID } from '#/agent/toolSelect/flag';
import { SUBAGENT_FORK_FLAG_ID } from '#/session/subagent/flag';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import {
  FORK_EXPERIMENTAL_UNAVAILABLE,
  FORK_WITH_MODEL_UNAVAILABLE,
  FORK_WITH_RESUME_UNAVAILABLE,
  FORK_WITH_TYPE_UNAVAILABLE,
} from '#/session/subagent/spawn';
import {
  type AgentRunCompletion,
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
  type RunAgentOptions,
} from '#/session/subagent/subagent';
import { SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV } from '#/session/subagent/subagentScopeCache';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ExecutableTool } from '#/tool/toolContract';
import { IWireService } from '#/wire/wire';
import { createAgentMachine } from '#human/agent/machine';
import { type ToolCall } from '#human/llm/message';
import { createActor } from '#human/xstate2';
import { setEnv, restoreEnvs } from '#test/helpers/stubs';
import { waitForAssertion } from '#test/helpers/waitFor';

import { stubAgentContext } from '../agent/agentContext/stubs';
import { stubFlag } from '../app/flag/stubs';
import { makeHookRunner } from '../features/externalHooks/runner-stub';
import {
  agentService,
  appService,
  configServices,
  createCommandRunner,
  createTestAgent,
  execEnvServices,
  externalHookServices,
  modelProviderServices,
  sessionService,
  swarmServices,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../harness';
import { homeDirServices } from '../harness/agent';
import { renderSnapshot } from '../harness/snapshots';
import { StubConfigService } from '../stubs';
import { executeTool } from '../tools/fixtures/execute-tool';
import { createFakeProcessRunner } from '../tools/fixtures/fake-exec';

const signal = new AbortController().signal;

interface FakeHostTimerHandle extends IHostTimerHandle {
  readonly id: number;
}

interface FakeHostTimers extends IHostTimers {
  advance(byMs: number): void;
  readonly pending: number;
}

function createFakeHostTimers(): FakeHostTimers {
  let nowMs = 0;
  let nextId = 1;
  const scheduled: Array<{
    readonly id: number;
    due: number;
    readonly callback: () => void;
    cancelled: boolean;
  }> = [];

  const schedule = (callback: () => void, delayMs: number): FakeHostTimerHandle => {
    const id = nextId;
    nextId += 1;
    scheduled.push({ id, due: nowMs + delayMs, callback, cancelled: false });
    return { id, unref: () => {} };
  };

  return {
    _serviceBrand: undefined,
    setClampedTimeout: (callback, timeoutMs) => schedule(callback, timeoutMs),
    setTimeout: (callback, timeoutMs) => schedule(callback, timeoutMs),
    clearTimeout: (handle) => {
      const id = (handle as FakeHostTimerHandle).id;
      const timer = scheduled.find((candidate) => candidate.id === id);
      if (timer !== undefined) timer.cancelled = true;
    },
    advance: (byMs) => {
      const limit = nowMs + byMs;
      let guard = 0;
      for (;;) {
        const next = scheduled
          .filter((timer) => !timer.cancelled && timer.due <= limit)
          .sort((left, right) => left.due - right.due || left.id - right.id)[0];
        if (next === undefined) break;
        guard += 1;
        if (guard > 1_000) throw new Error('fake host timers advanced more than 1000 timers');
        nowMs = next.due;
        next.cancelled = true;
        next.callback();
      }
      nowMs = limit;
    },
    get pending() {
      return scheduled.filter((timer) => !timer.cancelled).length;
    },
  };
}

async function flushHostWork(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

async function advanceHostTime(timers: FakeHostTimers, byMs: number): Promise<void> {
  await flushHostWork();
  timers.advance(byMs);
  await flushHostWork();
}

function forkFlags(enabled = true): TestAgentServiceOverride {
  return appService(
    IFlagService,
    stubFlag((id) => enabled && id === SUBAGENT_FORK_FLAG_ID),
  );
}

function agentSchemaProperties<T = unknown>(): Record<string, T> {
  return (toInputJsonSchema(SubagentToolInputSchema) as { properties: Record<string, T> })
    .properties;
}

function agentSwarmSchemaProperties<T = unknown>(): Record<string, T> {
  return (toInputJsonSchema(AgentSwarmToolInputSchema) as { properties: Record<string, T> })
    .properties;
}

const BACKGROUND_AGENT_NEXT_STEP =
  'next_step: The completion arrives automatically in a later turn — do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user. (If you have nothing to do until it finishes, run such tasks in the foreground next time.)';

const POOL_MODEL_ENTRIES = {
  'provider/fast': { provider: 'test-provider', model: 'fast-model', maxContextSize: 262_144 },
  'provider/smart': { provider: 'test-provider', model: 'smart-model', maxContextSize: 262_144 },
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface CapturedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly payload: unknown;
}

function captureLogs(): {
  readonly entries: CapturedLogEntry[];
  readonly logger: ILogService;
} {
  const entries: CapturedLogEntry[] = [];
  const capture = (level: CapturedLogEntry['level']) => (message: string, payload?: unknown) => {
    entries.push({ level, message, payload });
  };
  let logger: ILogService;
  logger = {
    _serviceBrand: undefined,
    level: 'off',
    setLevel: () => {},
    flush: async () => {},
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    debug: capture('debug'),
    child: () => logger,
  };
  return { entries, logger };
}

function hookSlot<T>() {
  return {
    run: mock(async (_input: T) => {}),
    register: () => ({ dispose: () => {} }),
    delete: () => false,
  };
}

function noopDisposable() {
  return { dispose: () => {} };
}

function modelCatalogResolving(...aliases: readonly string[]): IModelCatalog {
  return {
    _serviceBrand: undefined,
    get: (alias: string) => {
      if (!aliases.includes(alias)) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `Model "${alias}" is not configured in config.toml.`,
          { details: { model: alias } },
        );
      }
      return { id: alias } as Model;
    },
    getRequester: (alias: string) => ({
      model: { id: alias } as Model,
      request: async function* () {},
    }),
    notifyConfigChanged: () => {},
  } as unknown as IModelCatalog;
}

interface AgentLifecycleStubOptions {
  readonly createAgentIds?: readonly string[];
  readonly runCompletion?: (
    agentId: string,
    request: AgentRunRequest,
    options: RunAgentOptions,
  ) => Promise<AgentRunCompletion>;
  readonly partialOutput?: (agentId: string) => string;
  readonly createError?: Error;
  readonly handleServices?: ReadonlyMap<string, ReadonlyMap<unknown, unknown>>;
}

interface AgentLifecycleStub extends IAgentLifecycleService, ISessionSubagentService {
  readonly create: ReturnType<typeof mock<IAgentLifecycleService['create']>>;
  readonly fork: ReturnType<typeof mock<IAgentLifecycleService['fork']>>;
  readonly run: ReturnType<typeof mock<ISessionSubagentService['run']>>;
  readonly get: ReturnType<typeof mock<IAgentLifecycleService['get']>>;
  readonly publishedEvents: Event2[];
  addHandle(
    agentId: string,
    profileName: string,
    services?: ReadonlyMap<unknown, unknown>,
    context?: AgentContext,
  ): void;
}

function createAgentLifecycleStub(options: AgentLifecycleStubOptions = {}): AgentLifecycleStub {
  let lifecycle: AgentLifecycleStub;
  let created = 0;
  const stateByAgentId = new Map<string, AgentStateService>();
  const profileByAgentId = new Map<string, string>();
  const handles = new Map<string, IAgentScopeHandle>();
  const servicesByAgentId = new Map(options.handleServices);
  const contextsByAgentId = new Map<string, AgentContext>();
  const publishedEvents: Event2[] = [];
  const contextFor = (agentId: string): AgentContext => {
    let context = contextsByAgentId.get(agentId);
    if (context === undefined) {
      context = stubAgentContext(agentId, 1);
      contextsByAgentId.set(agentId, context);
    }
    return context;
  };
  const handle = (agentId: string): IAgentScopeHandle => ({
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor: {
      get: (serviceId) => {
        const service = servicesByAgentId.get(agentId)?.get(serviceId);
        if (service !== undefined) return service as never;
        if (serviceId === IAgentLifecycleService) return lifecycle as never;
        if (serviceId === ISessionSubagentService) return lifecycle as never;
        if (serviceId === IAgentScopeContext) {
          return {
            _serviceBrand: undefined,
            agentId,
            agentContext: contextFor(agentId),
            scope: (subKey?: string) => subKey ?? '',
          } as never;
        }
        if (serviceId === IAgentContextMemoryService) {
          return {
            _serviceBrand: undefined,
            get: () => [],
          } as never;
        }
        if (serviceId === IAgentProfileService) {
          return {
            _serviceBrand: undefined,
            data: () => ({ profileName: profileByAgentId.get(agentId) }),
            update: () => {},
            republishStatus: () => {},
            getEffectiveThinkingLevel: () => 'off',
            getActiveToolNames: () => [],
            isToolActive: () => false,
          } as never;
        }
        if (serviceId === IAgentLoopService) {
          return {
            _serviceBrand: undefined,
            snapshot: () => ({ state: 'idle' }),
          } as never;
        }
        if (serviceId === IAgentPermissionModeService) {
          return {
            _serviceBrand: undefined,
            mode: 'manual',
            setMode: () => {},
            onDidChangeMode: Event.None,
          } as never;
        }
        if (serviceId === IAgentToolRegistryService) {
          return {
            _serviceBrand: undefined,
            register: () => ({ dispose: () => {} }),
          } as never;
        }
        if (serviceId === IAgentUserToolService) {
          return {
            _serviceBrand: undefined,
            list: () => [],
            inheritUserTools: () => {},
            register: () => {},
            unregister: () => {},
          } as never;
        }
        if (serviceId === IAgentEnvironmentBindingService) {
          return {
            _serviceBrand: undefined,
            onDidChange: Event.None,
            current: { environmentId: 'local' },
            bind: (environmentId: string, cwd?: string) => ({ environmentId, cwd }),
          } as never;
        }
        if (serviceId === IAgentReminderService) {
          return {
            _serviceBrand: undefined,
            register: () => noopDisposable(),
            notify: () => {},
            reconcileWhenIdle: () => Promise.resolve(),
          } as never;
        }
        if (serviceId === IEventBus) {
          return {
            _serviceBrand: undefined,
            publish: (event: Event2) => {
              publishedEvents.push(event);
            },
            subscribe: () => noopDisposable(),
          } as never;
        }
        if (serviceId === IWireService) {
          return {
            _serviceBrand: undefined,
            hooks: createHooks(['onDidRestore']),
            dispatch: () => {},
            replay: async () => {},
            flush: async () => {},
            externallyModified: () => false,
            getModel: () => [],
            subscribe: () => noopDisposable(),
            onEmission: () => noopDisposable(),
          } as never;
        }
        if (serviceId === IEventDispatcher) {
          return {
            _serviceBrand: undefined,
            hooks: createHooks(['onDidRestore']),
            dispatch: (event: Event2) => {
              publishedEvents.push(event);
              return Promise.resolve();
            },
            restore: () => Promise.resolve(),
            flush: () => Promise.resolve(),
          } as never;
        }
        if (serviceId === IAgentStateService) {
          let state = stateByAgentId.get(agentId);
          if (state === undefined) {
            state = new AgentStateService();
            stateByAgentId.set(agentId, state);
          }
          return state as never;
        }
        return undefined as never;
      },
    },
    dispose: () => {},
  });
  lifecycle = {
    _serviceBrand: undefined,
    hooks: {
      onWillStartAgentTask: hookSlot(),
    },
    onDidStopAgentTask: Event.None as KimiEvent<AgentTaskStopHookContext>,
    onDidCreate: Event.None as KimiEvent<AgentContext>,
    onDidCreateScope: Event.None as KimiEvent<AgentScopeCreatedEvent>,
    onWillClose: Event.None as KimiEvent<AgentContext>,
    onDidClose: Event.None as KimiEvent<AgentContext>,
    create: mock(async (input = {}) => {
      if (options.createError !== undefined) throw options.createError;
      const agentId =
        input.agentId ?? options.createAgentIds?.[created] ?? `agent-child-${String(created + 1)}`;
      created += 1;
      const profileName = input.binding?.profile ?? 'coder';
      profileByAgentId.set(agentId, profileName);
      handles.set(agentId, handle(agentId));
      return contextFor(agentId);
    }),
    notifyAgentTaskStopped: mock(),
    planSpawn: mock(async () => {
      throw new Error('unexpected planSpawn');
    }),
    spawn: mock(async () => {
      throw new Error('unexpected spawn');
    }),
    fork: mock(async (source, input = {}) => {
      if (options.createError !== undefined) throw options.createError;
      const agentId =
        input.agentId ?? options.createAgentIds?.[created] ?? `agent-child-${String(created + 1)}`;
      created += 1;
      profileByAgentId.set(agentId, profileByAgentId.get(source.agentId) ?? 'coder');
      const createdHandle = handle(agentId);
      handles.set(agentId, createdHandle);
      return contextFor(agentId);
    }),
    run: mock(async (agent, request, runOptions): Promise<AgentRunHandle> => {
      const completion =
        options.runCompletion?.(agent.agentId, request, runOptions) ??
        Promise.resolve({ summary: 'child result' });
      return {
        agentId: agent.agentId,
        turn: {} as AgentRunHandle['turn'],
        completion,
        partialOutput: () => options.partialOutput?.(agent.agentId) ?? '',
      };
    }),
    get: mock((agentId: string) => contextsByAgentId.get(agentId)),
    handleOf: mock((agentId: string) => handles.get(agentId)),
    list: mock(() => [...handles.keys()].map((agentId) => contextFor(agentId))),
    adopt: mock((adopted) => {
      const adoptedHandle = adopted as IAgentScopeHandle;
      handles.set(adoptedHandle.id, adoptedHandle);
      const loop = adoptedHandle.accessor.get(IAgentLoopService);
      const bundle = loop.buildAttachBundle();
      const ref = createActor(createAgentMachine({}), {
        input: {
          request: bundle.request,
          scopeFactory: () =>
            Promise.resolve({
              store: bundle.store,
              turnLogic: bundle.turnLogic,
              toolLogic: bundle.toolLogic,
              tools: bundle.tools,
              request: bundle.request,
            }),
        },
      });
      ref.start();
      loop.attachEngine(ref, bundle);
      return agentContextOf(adoptedHandle);
    }),
    broadcastPermissionMode: mock(),
    remove: mock(async (agent) => {
      handles.delete(agent.agentId);
    }),
    addHandle: (agentId, profileName, services, context) => {
      profileByAgentId.set(agentId, profileName);
      if (services !== undefined) {
        const existing = servicesByAgentId.get(agentId);
        servicesByAgentId.set(
          agentId,
          existing === undefined ? new Map(services) : new Map([...existing, ...services]),
        );
      }
      if (context !== undefined) contextsByAgentId.set(agentId, context);
      handles.set(agentId, handle(agentId));
    },
    publishedEvents,
  };
  return lifecycle;
}

function wireRealSubagentService(ctx: TestAgentContext, lifecycle: AgentLifecycleStub): void {
  const subagents = ctx.get(ISessionSubagentService);
  spyOn(subagents, 'run').mockImplementation(lifecycle.run);
  lifecycle.addHandle(
    'main',
    'agent',
    new Map<unknown, unknown>([
      [IAgentProfileService, ctx.get(IAgentProfileService)],
      [IAgentEnvironmentService, ctx.get(IAgentEnvironmentService)],
    ]),
    ctx.get(IAgentScopeContext).agentContext,
  );
}

function agentTool(ctx: TestAgentContext): ExecutableTool<SubagentToolInput> {
  const tool = ctx.get(IAgentToolRegistryService).resolve('Agent');
  expect(tool).toBeDefined();
  return tool! as ExecutableTool<SubagentToolInput>;
}

function agentSwarmTool(ctx: TestAgentContext): ExecutableTool<AgentSwarmToolInput> {
  const tool = ctx.get(IAgentToolRegistryService).resolve('AgentSwarm');
  expect(tool).toBeDefined();
  return tool! as ExecutableTool<AgentSwarmToolInput>;
}

function agentSwarmToolInSwarmMode(ctx: TestAgentContext): ExecutableTool<AgentSwarmToolInput> {
  ctx.get(IAgentSwarmService).enter('manual');
  return agentSwarmTool(ctx);
}

function executeAgentTool(
  ctx: TestAgentContext,
  args: SubagentToolInput,
  inputSignal: AbortSignal = signal,
) {
  return executeTool(agentTool(ctx), {
    turnId: 0,
    toolCallId: 'call_agent',
    args,
    signal: inputSignal,
  });
}

function currentAgentHandle(ctx: TestAgentContext, agentId: string): IAgentScopeHandle {
  return {
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor: {
      get: ((serviceId: unknown) =>
        ctx.get(serviceId as never)) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
  };
}

function sessionMetadataStub(agents: Readonly<Record<string, AgentMeta>>): ISessionMetadata {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: Event.None as ISessionMetadata['onDidChangeMetadata'],
    read: async () => ({
      id: 'test-session',
      createdAt: 0,
      updatedAt: 0,
      archived: false,
      agents,
    }),
    update: async () => {},
    applyPromptMetadata: async () => false,
    setTitle: async () => {},
    setGeneratedTitleIfUncustomized: async () => false,
    setArchived: async () => {},
    registerAgent: async () => {},
  };
}

function subagentMeta(parentAgentId = 'main'): AgentMeta {
  return {
    labels: { parentAgentId },
  };
}

function discoveredCatalog(): ISessionAgentProfileCatalog {
  const agent = normalizeAgentProfile({
    name: 'agent',
    description: 'Default agent',
    subagents: ['coder', 'explore', 'plan'],
    systemPrompt: () => 'agent',
  });
  const coder = normalizeAgentProfile({
    name: 'coder',
    description: 'Coder',
    systemPrompt: () => 'coder',
  });
  const reviewer = normalizeAgentProfile({
    name: 'reviewer',
    description: 'Reviewer',
    systemPrompt: () => 'reviewer',
  });
  const profiles = [agent, coder, reviewer];
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
    get: (name) => profiles.find((profile) => profile.name === name),
    getDefault: () => agent,
    list: () => [...profiles],
    inspect: (name) => {
      const profile = profiles.find((candidate) => candidate.name === name);
      if (profile === undefined) return undefined;
      return {
        name,
        profile,
        sourceId: name === 'reviewer' ? 'workspace' : 'builtin',
        priority: 0,
        suppressed: [],
      };
    },
    load: async () => {},
    reload: async () => {},
  };
}

describe('SubagentToolInputSchema', () => {
  it('accepts the snake_case background parameter', () => {
    const parsed = SubagentToolInputSchema.parse({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
      run_in_background: true,
    });

    expect(parsed).toMatchObject({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
      run_in_background: true,
    });
  });

  it('exposes run_in_background and not runInBackground in the JSON schema', () => {
    const properties = agentSchemaProperties();

    expect(properties).toHaveProperty('run_in_background');
    expect(properties).not.toHaveProperty('runInBackground');
  });

  it('does not expose the timeout parameter in the JSON schema', () => {
    const properties = agentSchemaProperties();

    expect(properties).not.toHaveProperty('timeout');
  });

  it('exposes the model parameter as a free-form string in the JSON schema', () => {
    const properties = agentSchemaProperties<{
      description?: string;
      type?: string;
      enum?: string[];
    }>();

    expect(properties['model']?.type).toBe('string');
    expect(properties['model']?.enum).toBeUndefined();
    expect(properties['model']?.description).toContain('Available models');
  });

  it('normalizes the default subagent type into tool args', () => {
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
      }).subagent_type,
    ).toBe('coder');
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
        subagent_type: '',
      }).subagent_type,
    ).toBe('coder');
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
      }).subagent_type,
    ).toBeUndefined();
  });

  it('exposes the fork parameter in the JSON schema', () => {
    const properties = agentSchemaProperties<{ type?: string }>();

    expect(properties).toHaveProperty('fork');
    expect(properties['fork']?.type).toBe('boolean');
  });

  it('does not default subagent_type when forking', () => {
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Continue',
        description: 'Continue work',
        fork: true,
      }).subagent_type,
    ).toBeUndefined();
  });

  it('exposes the backend parameter in the JSON schema', () => {
    const properties = agentSchemaProperties<{ type?: string }>();

    expect(properties).toHaveProperty('backend');
    expect(properties['backend']?.type).toBe('string');
  });

  it('does not default subagent_type when a backend is requested', () => {
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
        backend: 'codex',
      }).subagent_type,
    ).toBeUndefined();
  });
});

describe('Agent tool description', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    await ctx.dispose();
    restoreEnvs();
  });

  function agentDescription(): string {
    const tool = ctx.toolsData().find((entry) => entry.name === 'Agent');
    expect(tool).toBeDefined();
    return tool!.description;
  }

  it.each([
    { enabled: false, primary: true, secondary: true, fork: false, expected: false },
    { enabled: true, primary: false, secondary: false, fork: false, expected: false },
    { enabled: true, primary: true, secondary: false, fork: false, expected: false },
    { enabled: true, primary: true, secondary: false, fork: true, expected: false },
    { enabled: true, primary: false, secondary: true, fork: false, expected: true },
  ])('describes select_tools for eligible subagent models: $enabled/$primary/$secondary/$fork', ({
    enabled, primary, secondary, fork, expected,
  }) => {
    ctx = createTestAgent(
      {
        initialConfig: {
          secondaryModel: { defaultModel: 'provider/child' },
          models: {
            'provider/child': {
              provider: 'test-provider',
              model: 'child-model',
              maxContextSize: 262_144,
              capabilities: secondary ? ['tool_use', 'dynamically_loaded_tools'] : ['tool_use'],
            },
          },
        },
      },
      appService(
        IFlagService,
        stubFlag((id) =>
          id === TOOL_SELECT_FLAG_ID ? enabled : id === SUBAGENT_FORK_FLAG_ID ? fork : true,
        ),
      ),
      sessionService(ISessionAgentProfileCatalog, discoveredCatalog()),
    );
    ctx.configure({
      modelCapabilities: {
        ...ctx.get(IAgentProfileService).getModelCapabilities(),
        tool_use: true,
        dynamically_loaded_tools: primary,
      },
    });
    const profile = ctx.get(IAgentProfileService);
    profile.applyBindingSnapshot({ ...profile.data(), subagents: ['reviewer'] });

    const tools = agentDescription().match(/- reviewer: [^\n]*\n  Tools: ([^\n]*)/)?.[1];
    expect(tools).toBeDefined();
    expect(tools!.split(', ').includes('select_tools')).toBe(expected);
  });

  it.each([false, true])('renders caller model tools without a pool when fork=%s', async (fork) => {
    ctx = createTestAgent(forkFlags(fork));
    ctx.configure({
      modelCapabilities: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
        max_context_tokens: 0,
      },
    });
    await ctx.get(IEventDispatcher).flush();

    const description = agentDescription();

    expect(description).toContain('Tools: Bash, Read, Glob, Grep, WebSearch, FetchURL');
    expect(description).toContain('Tools: Bash, CronCreate, CronDelete, CronList, Edit');
  });

  it('omits unregistered tools from subagent type descriptions', () => {
    ctx = createTestAgent();

    const description = agentDescription();

    expect(description).toContain('Available agent types');
    expect(description).not.toContain('ReadMediaFile');
    expect(description).toContain('Tools: Bash, Read, Glob, Grep, WebSearch, FetchURL');
  });

  it('registers Memory while associative memory is off', () => {
    ctx = createTestAgent(appService(IFlagService, stubFlag(() => false)));

    expect(ctx.toolsData().some((tool) => tool.name === 'Memory')).toBe(true);
  });

  it('registers MemoryGraph in its place once associative memory is on', () => {
    ctx = createTestAgent(
      appService(IFlagService, stubFlag((id) => id === ASSOCIATIVE_MEMORY_FLAG_ID)),
    );

    const names = ctx.toolsData().map((tool) => tool.name);
    expect(names).toContain('MemoryGraph');
    expect(names).not.toContain('Memory');
  });

  it('registers every documented tool, including Knowledge and Workflow', () => {
    ctx = createTestAgent();

    const names = ctx.toolsData().map((tool) => tool.name);
    expect(names).toContain('Knowledge');
    expect(names).toContain('Workflow');
  });

  it.each([false, true])('omits caller-only ReadMediaFile from subagent types when fork=%s', async (fork) => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: { defaultModel: 'provider/text' },
        models: {
          'provider/text': {
            provider: 'test-provider',
            model: 'text-model',
            maxContextSize: 262_144,
          },
        },
      },
    }, forkFlags(fork));
    ctx.configure({
      modelCapabilities: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
        max_context_tokens: 0,
      },
    });
    await ctx.get(IEventDispatcher).flush();

    const description = agentDescription();

    expect(description).not.toContain('ReadMediaFile');
  });

  it('preserves glob tool patterns that do not end with an asterisk', () => {
    const caller = normalizeAgentProfile({
      name: 'caller',
      description: 'Caller',
      systemPrompt: () => 'caller',
    });
    const globber = normalizeAgentProfile({
      name: 'globber',
      description: 'Globber',
      tools: ['Read', 'mcp__server__get_?_details'],
      systemPrompt: () => 'globber',
    });
    const profiles = [caller, globber];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => profiles,
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));

    const description = agentDescription();

    expect(description).toContain('- globber: Globber');
    expect(description).toContain('mcp__server__get_?_details');
  });

  it('preserves extglob tool patterns', () => {
    const caller = normalizeAgentProfile({
      name: 'caller',
      description: 'Caller',
      systemPrompt: () => 'caller',
    });
    const globber = normalizeAgentProfile({
      name: 'globber',
      description: 'Globber',
      tools: ['Read', 'mcp__server__@(read|write)'],
      systemPrompt: () => 'globber',
    });
    const profiles = [caller, globber];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => profiles,
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));

    const description = agentDescription();

    expect(description).toContain('- globber: Globber');
    expect(description).toContain('mcp__server__@(read|write)');
  });

  it('omits the fork parameter and guidance while the subagent_fork flag is off', () => {
    ctx = createTestAgent(forkFlags(false));

    const tool = ctx.toolsData().find((entry) => entry.name === 'Agent');
    expect(tool).toBeDefined();
    expect(tool!.description).not.toContain('Context forking');
    const properties = (tool!.parameters as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    expect(properties).toBeDefined();
    expect(properties).not.toHaveProperty('fork');
  });

  it('exposes the fork parameter and guidance when the subagent_fork flag is on', () => {
    ctx = createTestAgent(forkFlags());

    const tool = ctx.toolsData().find((entry) => entry.name === 'Agent');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('inheriting your current agent type, model, and tool set.');
    const properties = (tool!.parameters as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    expect(properties?.['fork']).toMatchObject({
      description: 'Start with a snapshot of your completed conversation history, inheriting your current agent type, model, and tool set.',
    });
  });

  it('does not offer the default agent type to the builtin default caller', () => {
    ctx = createTestAgent();

    const description = agentDescription();

    expect(description).toContain('- coder:');
    expect(description).toContain('- explore:');
    expect(description).not.toContain('- agent:');
  });

  it('lists discovered custom agents for the main agent alongside the builtin allowlist', async () => {
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, discoveredCatalog()));
    await ctx.get(IAgentProfileService).bind({ profile: 'agent', model: 'mock-model' });

    const description = agentDescription();

    expect(description).toContain('- reviewer: Reviewer');
    expect(description).toContain('- coder: Coder');
    expect(description).not.toContain('- agent: Default agent');
  });

  it('renders global tool restrictions in subagent type descriptions', () => {
    ctx = createTestAgent(
      configServices(() => ({
        providers: {},
        tools: { disabled: ['Bash'] },
      })),
    );

    const description = agentDescription();
    const coderTools = description
      .split('\n')
      .find((line) => line.startsWith('  Tools:') && line.includes('Read'));

    expect(coderTools).toBeDefined();
    expect(coderTools).not.toContain('Bash');
  });

  it('lists contributed tools the caller profile does not activate', () => {
    const callerData = {
      profileName: 'orchestrator',
      activeToolNames: ['Agent', 'Bash', 'Read'],
      disallowedTools: [],
      subagents: ['agent'],
    } as unknown as ProfileData;
    ctx = createTestAgent(
      { autoConfigure: false },
      agentService(IAgentProfileService, {
        _serviceBrand: undefined,
        data: () => callerData,
        getModelCapabilities: () => ({}),
        onDidChange: Event.None,
      } as unknown as IAgentProfileService),
      configServices(() => ({
        providers: {},
        tools: { disabled: ['Write'] },
      })),
    );

    const description = agentDescription();
    const agentTools = description.match(/- agent: [^\n]*\n  Tools: ([^\n]*)/)?.[1];

    expect(agentTools).toBeDefined();
    expect(agentTools).toContain('AgentSwarm');
    expect(agentTools).not.toContain('Write');
  });

  it('renders effective tools after applying disallowedTools', () => {
    const restricted: AgentProfile = normalizeAgentProfile({
      name: 'restricted',
      description: 'Restricted agent',
      tools: ['Bash', 'Read', 'mcp__github__*'],
      disallowedTools: ['Bash', 'mcp__github__*'],
      systemPrompt: () => 'restricted',
    });
    const allowAllExcept: AgentProfile = normalizeAgentProfile({
      name: 'allow-all-except',
      description: 'Allow all except one',
      disallowedTools: ['Bash'],
      systemPrompt: () => 'allow all except',
    });
    const profiles = [restricted, allowAllExcept];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => restricted,
      list: () => profiles,
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));

    const description = agentDescription();

    expect(description).toContain('- restricted: Restricted agent\n  Tools: Read');
    const allowAllExceptTools = description
      .split('\n')
      .find((line) => line.startsWith('  Tools:') && line.includes('TaskList'));
    expect(allowAllExceptTools).toBeDefined();
    expect(allowAllExceptTools).not.toContain('Bash');
    expect(description).not.toContain('Tools: Bash, Read, mcp__github__*');
  });

  it('omits WebSearch from every subagent when no search provider is configured', () => {
    ctx = createTestAgent(
      appService(IWebSearchProviderService, {
        _serviceBrand: undefined,
        hasWebSearchProvider: () => false,
        getWebSearchProvider: () => undefined,
      }),
    );

    expect(agentDescription()).not.toContain('WebSearch');
    expect(agentDescription()).toContain('FetchURL');
  });

  it('keeps an unavailable contribution registered but omits it from descriptions', async () => {
    let available = true;
    ctx = createTestAgent(
      appService(IWebSearchProviderService, {
        _serviceBrand: undefined,
        hasWebSearchProvider: () => available,
        getWebSearchProvider: () => undefined,
      }),
    );
    expect(agentDescription()).toContain('WebSearch');
    expect(ctx.get(IAgentToolRegistryService).resolve('WebSearch')).toBeDefined();

    available = false;
    await ctx.get(IAgentToolActivationService).activate();
    expect(ctx.get(IAgentToolRegistryService).resolve('WebSearch')).toBeDefined();
    expect(agentDescription()).not.toContain('WebSearch');
  });

  it('preserves a user tool overriding an unavailable built-in contribution', async () => {
    ctx = createTestAgent(
      appService(IWebSearchProviderService, {
        _serviceBrand: undefined,
        hasWebSearchProvider: () => false,
        getWebSearchProvider: () => undefined,
      }),
    );
    ctx.get(IAgentUserToolService).register({
      name: 'WebSearch',
      description: 'Search with a user-provided service.',
      parameters: { type: 'object', properties: {} },
    });

    await ctx.get(IAgentToolActivationService).activate();

    expect(ctx.get(IAgentToolRegistryService).listReferences()).toContainEqual({
      name: 'WebSearch',
      source: 'user',
    });
    expect(agentDescription()).toContain('WebSearch');
  });

  it('filters descriptions by the inherited runtime capabilities without churning the registry', async () => {
    ctx = createTestAgent();
    const runtime = ctx.get(IAgentEnvironmentService);
    const isAvailable = spyOn(runtime, 'isAvailable');
    isAvailable.mockImplementation((required = []) => !required.includes('fs'));

    for (const name of ['Edit', 'Write', 'Glob', 'Grep']) {
      expect(agentDescription()).not.toMatch(new RegExp(`Tools:.*\\b${name}\\b`));
    }
    expect(agentDescription()).toMatch(/Tools:.*\bBash\b/);
    await ctx.get(IAgentToolActivationService).activate();
    expect(ctx.get(IAgentToolRegistryService).resolve('Edit')).toBeDefined();
    expect(ctx.get(IAgentToolRegistryService).resolve('Bash')).toBeDefined();

    isAvailable.mockReturnValue(true);
    expect(agentDescription()).toMatch(/Tools:.*\bEdit\b/);
  });

  it.each([false, true])(
    'uses the NotifyUser contribution condition when enabled=%s',
    (enabled) => {
      ctx = createTestAgent(
        sessionService(ISessionNotify, {
          _serviceBrand: undefined,
          ready: Promise.resolve(),
          enabled,
        }),
      );

      expect(agentDescription().includes('NotifyUser')).toBe(enabled);
      expect(ctx.get(IAgentToolRegistryService).resolve('NotifyUser') !== undefined).toBe(enabled);
    },
  );

  it('lists only subagent types allowed by the caller profile', () => {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      subagents: ['explore'],
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      tools: ['Read'],
      systemPrompt: () => 'explore',
    });
    const profiles = [caller, coder, explore];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [coder, explore],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));

    const description = agentDescription();

    expect(description).toContain('- explore: Explorer');
    expect(description).not.toContain('- coder: Coder');
  });

  it('lists subagent types from the persisted binding instead of the current catalog profile', () => {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      subagents: ['coder'],
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    });
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => [caller, coder, explore].find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [coder, explore],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));
    ctx.get(IAgentProfileService).applyBindingSnapshot({
      profileName: 'deleted-profile',
      thinkingLevel: 'off',
      systemPrompt: 'persisted prompt',
      subagents: ['explore'],
    });

    const description = agentDescription();

    expect(description).toContain('- explore: Explorer');
    expect(description).not.toContain('- coder: Coder');
  });

  it('freezes the subagent type list once the profile catalog is ready', async () => {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    });
    const profiles = [coder];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => [caller, ...profiles].find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [...profiles],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));
    expect(agentDescription()).toContain('- coder: Coder');
    await Promise.resolve();

    const frozen = agentDescription();
    expect(frozen).toContain('- coder: Coder');

    profiles.push(explore);
    const after = agentDescription();
    expect(after).toBe(frozen);
    expect(after).not.toContain('- explore: Explorer');
  });

  it('reflects the current catalog list in the description before the catalog is ready', async () => {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    });
    const profiles = [coder];
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready,
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => [caller, ...profiles].find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [...profiles],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));

    expect(agentDescription()).toContain('- coder: Coder');
    profiles.push(explore);
    expect(agentDescription()).toContain('- explore: Explorer');

    resolveReady();
    await ready;
  });

  it('renders the available agent types section', () => {
    ctx = createTestAgent();

    expect(agentDescription()).toContain('Available agent types');
  });

  it('omits the models section when no [secondary_model.models] pool is configured', () => {
    ctx = createTestAgent();

    expect(agentDescription()).not.toContain('Available models');
  });

  it('renders the pool in config order with the default first and no primary choice', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: {
            'provider/fast': 'fast and cheap',
            'provider/smart': 'hard tasks',
          },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const description = agentDescription();

    expect(description).toContain('Available models');
    const defaultIndex = description.indexOf('- provider/fast [default]: fast and cheap');
    const smartIndex = description.indexOf('- provider/smart: hard tasks');
    expect(defaultIndex).toBeGreaterThanOrEqual(0);
    expect(smartIndex).toBeGreaterThan(defaultIndex);
    expect(description).not.toContain('- primary');
  });

  it('renders the caller-in-pool alias as a plain entry and renders empty descriptions bare', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: {
            'provider/fast': 'fast and cheap',
            'mock-model': 'the main model, great at hard things',
            'provider/smart': '',
          },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const description = agentDescription();

    expect(description).toContain('- provider/fast [default]: fast and cheap');
    expect(description).toContain('- mock-model: the main model, great at hard things');
    expect(description).toMatch(/^- provider\/smart$/m);
    expect(description).not.toContain('- primary');
  });

  it('marks the default alias with [default]', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'mock-model',
          models: {
            'mock-model': 'the main model, great at hard things',
            'provider/fast': 'fast and cheap',
          },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const description = agentDescription();

    const defaultIndex = description.indexOf(
      '- mock-model [default]: the main model, great at hard things',
    );
    const fastIndex = description.indexOf('- provider/fast: fast and cheap');
    expect(defaultIndex).toBeGreaterThanOrEqual(0);
    expect(fastIndex).toBeGreaterThan(defaultIndex);
  });

  function agentParameters(): Record<string, unknown> {
    const tool = ctx.toolsData().find((entry) => entry.name === 'Agent');
    expect(tool?.parameters).toBeDefined();
    return tool!.parameters!;
  }

  it('strips the model parameter from the advertised schema when no pool is configured', () => {
    ctx = createTestAgent();

    const properties = agentParameters()['properties'] as Record<string, unknown>;

    expect(properties).not.toHaveProperty('model');
    expect(properties).toHaveProperty('prompt');
  });

  it('advertises the model parameter when the pool offers more than one model', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const properties = agentParameters()['properties'] as Record<
      string,
      { type?: string; enum?: unknown }
    >;

    expect(properties['model']?.type).toBe('string');
    expect(properties['model']?.enum).toBeUndefined();
  });

  it('strips the model parameter and pool description when no pool is configured', () => {
    ctx = createTestAgent({
      initialConfig: {
        models: POOL_MODEL_ENTRIES,
      },
    });

    const properties = agentParameters()['properties'] as Record<string, unknown>;
    expect(properties).not.toHaveProperty('model');
    expect(agentDescription()).not.toContain('Available models');
  });

  it.each([
    { name: 'a pool-less default_model', secondaryModel: { defaultModel: 'provider/fast' } },
    {
      name: 'a single-entry pool table',
      secondaryModel: { defaultModel: 'provider/fast', models: { 'provider/fast': 'fast' } },
    },
  ])('hides the model parameter and the pool description for $name', ({ secondaryModel }) => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel,
        models: POOL_MODEL_ENTRIES,
      },
    });

    const properties = agentParameters()['properties'] as Record<string, unknown>;
    expect(properties).not.toHaveProperty('model');
    expect(agentDescription()).not.toContain('Available models');
  });
});

describe('Agent tool execution contract', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  function createAgentToolContext(
    lifecycle: AgentLifecycleStub = createAgentLifecycleStub(),
    ...extra: readonly (TestAgentServiceOverride | TestAgentOptions)[]
  ): TestAgentContext {
    ctx = createTestAgent(
      sessionService(IAgentLifecycleService, lifecycle),
      modelProviderServices(modelCatalogResolving('mock-model', 'provider/fast', 'provider/smart')),
      ...extra,
    );
    wireRealSubagentService(ctx, lifecycle);
    return ctx;
  }

  function allowlistCatalog(allowlist: readonly string[]): ISessionAgentProfileCatalog {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      subagents: allowlist,
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      tools: ['Bash', 'Read'],
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      tools: ['Read'],
      systemPrompt: () => 'explore',
    });
    const profiles = [caller, coder, explore];
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [coder, explore],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
  }

  it('rejects a subagent type outside the caller allowlist', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionAgentProfileCatalog, allowlistCatalog(['explore'])),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'coder',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Subagent type "coder" is not allowed for this agent');
    expect(result.output).toContain('explore');
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('enforces the persisted subagent allowlist instead of the current catalog profile', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionAgentProfileCatalog, allowlistCatalog(['coder'])),
    );
    context.get(IAgentProfileService).applyBindingSnapshot({
      profileName: 'deleted-profile',
      thinkingLevel: 'off',
      systemPrompt: 'persisted prompt',
      subagents: ['explore'],
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'coder',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Subagent type "coder" is not allowed for this agent');
    expect(result.output).toContain('explore');
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('blocks fallback delegation to profiles that can themselves delegate', async () => {
    const agent = normalizeAgentProfile({
      name: 'agent',
      description: 'Default agent',
      subagents: ['coder', 'explore'],
      systemPrompt: () => 'agent',
    });
    const coder = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      tools: ['Agent', 'Read'],
      systemPrompt: () => 'coder',
    });
    const explore = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      tools: ['Read'],
      systemPrompt: () => 'explore',
    });
    const profiles: AgentProfile[] = [agent, coder, explore];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => agent,
      list: () => [...profiles],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionAgentProfileCatalog, catalog),
    );
    context.get(IAgentProfileService).applyBindingSnapshot({
      modelAlias: 'mock-model',
      profileName: 'coder',
      thinkingLevel: 'off',
      systemPrompt: 'persisted prompt',
    });

    const blocked = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'coder',
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain('Subagent type "coder" is not allowed for this agent');
    expect(blocked.output).toContain('explore');

    const allowed = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });
    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ profile: 'explore' }),
      }),
    );
    expect(allowed.output).toContain('actual_subagent_type: explore');
  });

  it('does not create a subagent when process disappears after tool activation', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    spyOn(context.get(IAgentEnvironmentService), 'acquire').mockImplementation(() => {
      throw new Error('process capability is no longer available');
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });

    expect(result).toEqual({
      output: 'subagent error: process capability is no longer available',
      isError: true,
    });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
    expect(lifecycle.list()).toHaveLength(1);
  });

  it('spawns a subagent type inside the caller allowlist', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionAgentProfileCatalog, allowlistCatalog(['explore'])),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ profile: 'explore' }),
      }),
    );
    expect(result.output).toContain('actual_subagent_type: explore');
  });

  it('reports a normal completion with stop_reason and a resume hint', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('status: completed');
    expect(result.output).toContain('stop_reason: completed');
    expect(result.output).toContain('[summary]\nchild result');
    expect(result.output).toContain('resume_hint: Continue with Agent(resume="agent-child"');
    expect(result.output).not.toContain('notice:');
    expect(result.output).not.toContain('next_step:');
  });

  it('reports a repeat-breaker handoff as completed with stop_reason repeat_breaker', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({
        summary: 'Stuck: the same grep keeps returning nothing.',
        stopReason: 'repeat_breaker',
      }),
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('status: completed');
    expect(result.output).toContain('stop_reason: repeat_breaker');
    expect(result.output).toContain('notice: The subagent was stopped by the repeat breaker');
    expect(result.output).toContain('[summary]\nStuck: the same grep keeps returning nothing.');
    expect(result.output).toContain('next_step: The subagent was stuck on one tool call.');
  });

  it('settles a repeat-breaker completion with a stop code and a task reason', async () => {
    const task = new SubagentTask(
      {
        agentId: 'agent-child',
        profileName: 'coder',
        completion: Promise.resolve({ result: 'handoff', stopReason: 'repeat_breaker' }),
      },
      'Find cause',
      new AbortController(),
    );
    const settlements: AgentTaskSettlement[] = [];
    const output: string[] = [];
    await task.start({
      signal: new AbortController().signal,
      appendOutput: (chunk) => {
        output.push(chunk);
      },
      settle: async (settlement) => {
        settlements.push(settlement);
        return true;
      },
    });

    expect(output).toEqual(['handoff']);
    expect(settlements).toEqual([
      { status: 'completed', stopReason: expect.stringContaining('repeat breaker') },
    ]);
    const info = task.toInfo({
      taskId: 'agent-1',
      description: 'Find cause',
      status: 'completed',
      startedAt: 0,
      endedAt: 1,
    });
    expect(info.stopCode).toBe('repeat_breaker');
  });

  it('derives the stop code from the stop reason of a missing-handoff failure', async () => {
    const task = new SubagentTask(
      {
        agentId: 'agent-child',
        profileName: 'coder',
        completion: Promise.reject(
          new Error2(ErrorCodes.AGENT_NO_FINAL_MESSAGE, 'no handoff', {
            details: { stopReason: 'repeat_breaker' },
          }),
        ),
      },
      'Find cause',
      new AbortController(),
    );
    const settlements: AgentTaskSettlement[] = [];
    await task.start({
      signal: new AbortController().signal,
      appendOutput: () => {},
      settle: async (settlement) => {
        settlements.push(settlement);
        return true;
      },
    });

    expect(settlements).toEqual([{ status: 'failed', stopReason: 'no handoff' }]);
    const info = task.toInfo({
      taskId: 'agent-1',
      description: 'Find cause',
      status: 'failed',
      startedAt: 0,
      endedAt: 1,
    });
    expect(info.stopCode).toBe('repeat_breaker');
  });

  it('reports a missing final message as a failure with stop_reason no_final_message', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => {
        throw new Error2(
          ErrorCodes.AGENT_NO_FINAL_MESSAGE,
          'Subagent turn ended without a final message (stop reason: repeat_breaker).',
        );
      },
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('status: failed');
    expect(result.output).toContain('stop_reason: no_final_message');
    expect(result.output).toContain(
      'subagent error: The subagent was stopped before it finished. Reason: Subagent turn ended without a final message (stop reason: repeat_breaker).',
    );
    expect(result.output).toContain(
      'resume_hint: Continue with Agent(resume="agent-child", prompt="continue")',
    );
    expect(result.output).toContain('next_step: Resume to continue where it stopped');
  });

  it('keeps the repeat_breaker classification when the handoff produced no text', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => {
        throw new Error2(
          ErrorCodes.AGENT_NO_FINAL_MESSAGE,
          'Subagent turn ended without a final message (stop reason: repeat_breaker).',
          { details: { stopReason: 'repeat_breaker' } },
        );
      },
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('status: failed');
    expect(result.output).toContain('stop_reason: repeat_breaker');
    expect(result.output).toContain('Reason: Subagent turn ended without a final message');
    expect(result.output).toContain(
      'resume_hint: Continue with Agent(resume="agent-child", prompt="continue")',
    );
    expect(result.output).toContain('next_step: The subagent was stuck on one tool call.');
    expect(result.output).not.toContain('[summary]');
  });

  it('maps a step-cap failure to stop_reason max_steps without config advice', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => {
        throw new Error2(
          ErrorCodes.LOOP_MAX_STEPS_EXCEEDED,
          'Subagent hit the per-turn step cap (maxSteps=5) before finishing its handoff.',
        );
      },
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('stop_reason: max_steps');
    expect(result.output).toContain('maxSteps=5');
    expect(result.output).not.toContain('config.toml');
    expect(result.output).toContain('resume_hint:');
  });

  it('maps a provider filter failure to stop_reason filtered with a rephrase hint', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => {
        throw new Error2(
          ErrorCodes.PROVIDER_FILTERED,
          'Provider safety policy blocked the response.',
        );
      },
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('stop_reason: filtered');
    expect(result.output).toContain('next_step: Resuming is unlikely to help');
  });

  it('truncates an oversized failure reason', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => {
        throw new Error('x'.repeat(5000));
      },
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('stop_reason: error');
    expect(result.output).toContain('[truncated]');
    expect((result.output as string).length).toBeLessThan(3000);
  });

  it('declares no resource accesses so concurrent Agent calls can run in parallel', async () => {
    const context = createAgentToolContext();

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.accesses).toEqual(ToolAccesses.none());
  });

  it('uses the resumed agent profile in the activity description', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    lifecycle.addHandle('agent-existing', 'explore');

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      resume: ' agent-existing ',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching explore agent: Continue work');
    expect(lifecycle.list).toHaveBeenCalled();
  });

  it('uses the persisted profile of an offline subagent for display and approval rules', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({
          'agent-existing': { labels: { parentAgentId: 'main', profileName: 'explore' } },
        }),
      ),
    );

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching explore agent: Continue work');
    expect(execution.matchesRule?.('explore')).toBe(true);
    expect(execution.matchesRule?.('coder')).toBe(false);
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('falls back to the generic label when an offline subagent has no persisted profile', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionMetadata, sessionMetadataStub({ 'agent-existing': subagentMeta() })),
    );

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching subagent agent: Continue work');
  });

  it('labels fork launches with the caller profile for display and approval rules', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle, forkFlags());
    context.get(IAgentProfileService).update({ profileName: 'orchestrator' });

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      fork: true,
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching orchestrator agent: Continue work');
    expect(execution.matchesRule?.('orchestrator')).toBe(true);
    expect(execution.matchesRule?.('coder')).toBe(false);
  });

  it('returns an error when resuming with a subagent type', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    lifecycle.addHandle('agent-existing', 'explore');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
      subagent_type: 'explore',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
    });
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('rejects fork combined with resume', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle, forkFlags());
    lifecycle.addHandle('agent-existing', 'explore');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
      fork: true,
    });

    expect(result).toMatchObject({ isError: true, output: FORK_WITH_RESUME_UNAVAILABLE });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('rejects fork with a different subagent type', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle, forkFlags());
    context.get(IAgentProfileService).update({ profileName: 'coder' });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
      fork: true,
    });

    expect(result).toMatchObject({ isError: true, output: FORK_WITH_TYPE_UNAVAILABLE });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('rejects fork with a model override', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle, forkFlags());

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model: 'provider/smart',
      fork: true,
    });

    expect(result).toMatchObject({ isError: true, output: FORK_WITH_MODEL_UNAVAILABLE });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('accepts fork with its own model alias but rejects the removed primary choice', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(lifecycle, forkFlags());

    const rejected = await executeAgentTool(context, {
      prompt: 'Continue the analysis',
      description: 'Fork context',
      model: 'primary',
      fork: true,
    });
    expect(rejected).toMatchObject({ isError: true, output: FORK_WITH_MODEL_UNAVAILABLE });
    expect(lifecycle.fork).not.toHaveBeenCalled();

    const result = await executeAgentTool(context, {
      prompt: 'Continue the analysis',
      description: 'Fork context',
      model: 'mock-model',
      fork: true,
    });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('child result');
    expect(lifecycle.fork).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'main' }), {
      labels: expect.objectContaining({ parentAgentId: 'main' }),
    });
  });

  it('launches a fork through the agent lifecycle with subagent labels', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(lifecycle, forkFlags());
    context.get(IAgentProfileService).update({ profileName: 'coder' });

    const result = await executeAgentTool(context, {
      prompt: 'Continue the analysis',
      description: 'Fork context',
      fork: true,
    });

    expect(result.output).toContain('child result');
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.fork).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'main' }), {
      labels: expect.objectContaining({ parentAgentId: 'main' }),
    });
    expect(lifecycle.run).toHaveBeenCalledTimes(1);
    const [runAgent, runRequest] = lifecycle.run.mock.calls[0]!;
    expect(runAgent).toMatchObject({ agentId: 'agent-child' });
    const runPrompt = runRequest.kind === 'prompt' ? runRequest.prompt : '';
    expect(runPrompt).toBe('Continue the analysis');
  });

  it('forks without requiring the caller profile in the catalog', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(lifecycle, forkFlags());
    context.get(IAgentProfileService).update({ profileName: 'withdrawn-profile' });

    const result = await executeAgentTool(context, {
      prompt: 'Continue the analysis',
      description: 'Fork context',
      fork: true,
    });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('child result');
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.fork).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'main' }), {
      labels: expect.objectContaining({ parentAgentId: 'main' }),
    });
  });

  it('rejects fork while the subagent_fork experimental flag is off', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle, forkFlags(false));

    const result = await executeAgentTool(context, {
      prompt: 'Continue the analysis',
      description: 'Fork context',
      fork: true,
    });

    expect(result).toMatchObject({ isError: true, output: FORK_EXPERIMENTAL_UNAVAILABLE });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.fork).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('marks fork consistently in every subagent_created telemetry emission', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const telemetryRecords: { event: string; properties: unknown }[] = [];
    const context = createAgentToolContext(lifecycle, forkFlags());
    lifecycle.addHandle(
      'main',
      'agent',
      new Map<unknown, unknown>([
        [
          ITelemetryService,
          {
            ...noopTelemetryService,
            track2: (event: string, properties: unknown) => {
              telemetryRecords.push({ event, properties });
            },
          },
        ],
      ]),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Continue the analysis',
      description: 'Fork context',
      fork: true,
    });

    expect(result.isError).not.toBe(true);
    const created = telemetryRecords.filter((record) => record.event === 'subagent_created');
    expect(created.length).toBeGreaterThan(0);
    for (const record of created) {
      expect(record.properties).toMatchObject({ fork: true, model_source: 'inherited' });
    }
  });

  it('spawns a foreground subagent and returns its summary', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ profile: 'explore' }),
        labels: expect.objectContaining({ parentAgentId: 'main' }),
      }),
    );
    expect(lifecycle.run).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-child' }),
      { kind: 'prompt', prompt: expect.stringContaining('Investigate') },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('actual_subagent_type: explore');
    expect(result.output).toContain('child result');
  });

  it('emits subagent.spawned exactly once, after task registration, carrying the task id', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(lifecycle);

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });

    const spawned = lifecycle.publishedEvents.filter((event) => event.type === 'subagent.spawned');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      subagentId: 'agent-child',
      taskId: expect.any(String),
    });
  });

  it('spawns the subagent on the pool default model when the tool call omits model', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
        },
      },
    });

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          model: 'provider/fast',
          thinking: undefined,
        }),
      }),
    );
    expect(lifecycle.publishedEvents).toContainEqual(
      expect.objectContaining({
        type: 'subagent.spawned',
        subagentId: 'agent-child',
        model: 'provider/fast',
      }),
    );
  });

  it('rejects the removed "primary" choice instead of escaping the pool', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
        },
      },
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model: 'primary',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain(
      'Invalid model "primary". Available models: provider/fast, provider/smart.',
    );
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('binds the caller-in-pool alias like any pool entry, without inheriting thinking', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'mock-model': 'the main model' },
        },
      },
    });

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model: 'mock-model',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ model: 'mock-model', thinking: undefined }),
      }),
    );
  });

  it('spawns on the pool alias chosen via the model parameter', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
        },
      },
    });

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model: 'provider/smart',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          model: 'provider/smart',
          thinking: undefined,
        }),
      }),
    );
  });

  it('rejects a model choice outside the pool, listing the available models', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
        },
      },
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model: 'provider/typo',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain(
      'Invalid model "provider/typo". Available models: provider/fast, provider/smart.',
    );
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('inherits the caller model when no pool is configured', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle);

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          model: 'mock-model',
          thinking: 'off',
        }),
      }),
    );
  });

  it('accepts a pool that gained a "primary" key through a runtime config edit', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(
      lifecycle,
      modelProviderServices(modelCatalogResolving('mock-model', 'provider/fast', 'primary')),
      {
        initialConfig: {
          secondaryModel: {
            defaultModel: 'provider/fast',
            models: { 'provider/fast': 'fast and cheap' },
          },
        },
      },
    );
    await (context.get(IConfigService) as StubConfigService).replace(SECONDARY_MODEL_SECTION, {
      defaultModel: 'primary',
      models: { primary: 'ordinary alias' },
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBeFalsy();
    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ model: 'primary' }),
      }),
    );
  });

  it('points at the [secondary_model.models] config when the bound alias stops resolving', async () => {
    const lifecycle = createAgentLifecycleStub({
      createError: new Error2(
        ErrorCodes.CONFIG_INVALID,
        'Model "provider/bad" is not configured in config.toml.',
        { details: { model: 'provider/bad' } },
      ),
    });
    const context = createAgentToolContext(
      lifecycle,
      modelProviderServices(modelCatalogResolving('mock-model', 'provider/bad')),
      {
        initialConfig: {
          secondaryModel: { defaultModel: 'provider/bad', models: { 'provider/bad': 'broken' } },
        },
      },
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Model "provider/bad" is not configured in config.toml.');
    expect(result.output).toContain('comes from [secondary_model.models]');
  });

  it('does not rewrite spawn failures unrelated to the model config', async () => {
    const lifecycle = createAgentLifecycleStub({
      createError: new Error('MCP server failed to start'),
    });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap' },
        },
      },
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('MCP server failed to start');
    expect(result.output).not.toContain('[secondary_model.models]');
  });

  it('mirrors v1-compatible subagent lifecycle event fields', async () => {
    const lifecycle = createAgentLifecycleStub();
    const events: Event2[] = [];
    let agentStateService: AgentStateService | undefined;
    const eventBus = {
      _serviceBrand: undefined,
      publish: mock((event: Event2) => {
        events.push(event);
      }),
      subscribe: mock(() => noopDisposable()),
    } as IEventBus;
    lifecycle.addHandle(
      'agent-child',
      'explore',
      new Map([
        [
          ISessionTokenCountingService,
          {
            _serviceBrand: undefined,
            get: () => ({ size: 321, measured: 300, estimated: 21 }),
            measured: () => {},
            statusSize: () => 321,
          },
        ],
      ]),
    );
    const telemetryRecords: Array<{ event: string; properties: unknown }> = [];
    const dispatcher = {
      _serviceBrand: undefined,
      dispatch: async (event: Event2) => {
        eventBus.publish(event);
      },
    } as unknown as IEventDispatcher;
    const requester = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: {
        get: ((serviceId: unknown) => {
          if (serviceId === IEventBus) return eventBus;
          if (serviceId === IEventDispatcher) return dispatcher;
          if (serviceId === IAgentStateService) {
            agentStateService ??= new AgentStateService();
            return agentStateService;
          }
          if (serviceId === IAgentLifecycleService) return lifecycle;
          if (serviceId === ITelemetryService) {
            return {
              ...noopTelemetryService,
              track2: (event: string, properties: unknown) => {
                telemetryRecords.push({ event, properties });
              },
            };
          }
          return undefined;
        }) as IAgentScopeHandle['accessor']['get'],
      },
      dispose: () => {},
    } satisfies IAgentScopeHandle;

    emitAgentRunSpawned(requester, 'agent-child', {
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      runInBackground: false,
      model: 'provider/secondary',
      modelSource: 'secondary_pool',
    });
    await mirrorAgentRun(
      requester,
      {
        agentId: 'agent-child',
        turn: {} as AgentRunHandle['turn'],
        completion: Promise.resolve({ summary: 'child result' }),
        partialOutput: () => '',
      },
      {
        profileName: 'explore',
        prompt: 'Investigate',
        signal,
      },
    );

    expect(events.find((event) => event.type === 'subagent.spawned')).toMatchObject({
      parentAgentId: 'main',
      callerAgentId: 'main',
      model: 'provider/secondary',
      thinkingEffort: 'off',
    });
    expect(telemetryRecords).toContainEqual({
      event: 'subagent_created',
      properties: {
        subagent_name: 'explore',
        run_in_background: false,
        fork: false,
        agent_id: 'agent-child',
        model: 'provider/secondary',
        model_source: 'secondary_pool',
        parent_agent_id: 'main',
        parent_tool_call_id: 'call_agent',
      },
    });
    expect(events.find((event) => event.type === 'subagent.completed')).toMatchObject({
      subagentId: 'agent-child',
      resultSummary: 'child result',
      contextTokens: 321,
    });
  });

  it('inherits parent user tools when spawning a subagent', async () => {
    const lookupTool: UserToolRegistration = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    };
    const parentUserTools = {
      _serviceBrand: undefined,
      list: () => [lookupTool],
      inheritUserTools: mock(),
      register: mock(),
      unregister: mock(),
    } as unknown as IAgentUserToolService;
    const childUserTools = {
      _serviceBrand: undefined,
      list: () => [],
      inheritUserTools: mock(),
      register: mock(),
      unregister: mock(),
    } as unknown as IAgentUserToolService;
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      handleServices: new Map([
        ['main', new Map([[IAgentUserToolService, parentUserTools]])],
        ['agent-child', new Map([[IAgentUserToolService, childUserTools]])],
      ]),
    });
    const context = createAgentToolContext(lifecycle);

    await executeAgentTool(context, {
      prompt: 'Use the available lookup tool',
      description: 'Use lookup',
    });

    expect(childUserTools.inheritUserTools).toHaveBeenCalledWith(parentUserTools);
  });

  it('falls back to coder for an empty subagent type', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle);

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: '',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ profile: 'coder' }),
      }),
    );
  });

  it('resumes a foreground subagent when resume is provided', async () => {
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed result' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionMetadata, sessionMetadataStub({ 'agent-existing': subagentMeta() })),
    );
    lifecycle.addHandle('agent-existing', 'explore');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-existing' }),
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.output).toContain('agent_id: agent-existing');
    expect(result.output).toContain('actual_subagent_type: explore');
    expect(result.output).toContain('resumed result');
  });

  it('rebuilds a persisted subagent that is not live before resuming it', async () => {
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed after restart' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({
          'agent-existing': {
            type: 'sub',
            parentAgentId: 'main',
            forkedFrom: 'main',
            labels: { parentAgentId: 'main' },
          },
        }),
      ),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(lifecycle.create).toHaveBeenCalledTimes(1);
    expect(lifecycle.create).toHaveBeenCalledWith({
      agentId: 'agent-existing',
      labels: { parentAgentId: 'main' },
      forkedFrom: 'main',
    });
    expect(lifecycle.run).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-existing' }),
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('agent_id: agent-existing');
    expect(result.output).toContain('resumed after restart');
  });

  it('re-acquires the resume target after the metadata read and rebuilds it when it was evicted meanwhile', async () => {
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed after eviction' }),
    });
    const metadata = sessionMetadataStub({ 'agent-existing': subagentMeta() });
    const snapshot = await metadata.read();
    const readGate = createControlledPromise<typeof snapshot>();
    let armGate = false;
    let gatedReadStarted = false;
    metadata.read = mock(async () => {
      if (!armGate) return snapshot;
      gatedReadStarted = true;
      return readGate;
    });
    const context = createAgentToolContext(lifecycle, sessionService(ISessionMetadata, metadata));
    lifecycle.addHandle('agent-existing', 'explore');

    armGate = true;
    const resultPromise = executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });
    await waitForAssertion(() => {
      expect(gatedReadStarted).toBe(true);
    });
    await lifecycle.remove(stubAgentContext('agent-existing', 1));
    readGate.resolve(snapshot);
    const result = await resultPromise;

    expect(lifecycle.create).toHaveBeenCalledTimes(1);
    expect(lifecycle.create).toHaveBeenCalledWith({
      agentId: 'agent-existing',
      labels: { parentAgentId: 'main' },
      forkedFrom: undefined,
    });
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('resumed after eviction');
  });

  it('stops rebuilding an evicted resume target once the caller aborts', async () => {
    setEnv(SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV, '1000');
    try {
      const lifecycle = createAgentLifecycleStub({
        createError: new Error2(ErrorCodes.AGENT_ALREADY_EXISTS, 'still closing'),
      });
      const context = createAgentToolContext(
        lifecycle,
        sessionService(ISessionMetadata, sessionMetadataStub({ 'agent-existing': subagentMeta() })),
      );
      const controller = new AbortController();

      const resultPromise = executeAgentTool(
        context,
        { prompt: 'Continue', description: 'Continue work', resume: 'agent-existing' },
        controller.signal,
      );
      await waitForAssertion(() => {
        expect(lifecycle.create).toHaveBeenCalled();
      });
      controller.abort(userCancellationReason());
      const createCallsAtAbort = lifecycle.create.mock.calls.length;
      const abortedAt = Date.now();
      const result = await resultPromise;

      expect(result.isError).toBe(true);
      expect(Date.now() - abortedAt).toBeLessThan(500);
      expect(lifecycle.create.mock.calls.length).toBe(createCallsAtAbort);
    } finally {
      restoreEnvs();
    }
  });

  it('keeps rejecting resume of an agent id that was never persisted', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionMetadata, sessionMetadataStub({})),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-missing',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: Agent instance "agent-missing" does not exist',
    });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('does not rebuild a persisted subagent owned by another parent', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({ 'agent-existing': subagentMeta('other') }),
      ),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(result).toMatchObject({
      isError: true,
      output:
        'subagent error: Agent instance "agent-existing" does not belong to this parent agent',
    });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('syncs a rebuilt subagent to the caller permission mode before resuming it', async () => {
    const setMode = mock();
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed after restart' }),
      handleServices: new Map<string, ReadonlyMap<unknown, unknown>>([
        [
          'agent-existing',
          new Map<unknown, unknown>([
            [
              IAgentPermissionModeService,
              { _serviceBrand: undefined, mode: 'yolo', setMode, onDidChangeMode: Event.None },
            ],
          ]),
        ],
      ]),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionMetadata, sessionMetadataStub({ 'agent-existing': subagentMeta() })),
    );
    context.get(IAgentPermissionModeService).setMode('auto');
    expect(context.get(IAgentPermissionModeService).mode).toBe('auto');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(result.isError).not.toBe(true);
    expect(setMode).toHaveBeenCalledWith('auto');
    expect(setMode.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.run.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps a rebuilt tower worker on its pinned permission mode', async () => {
    const setMode = mock();
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'worker resumed' }),
      handleServices: new Map<string, ReadonlyMap<unknown, unknown>>([
        [
          'agent-existing',
          new Map<unknown, unknown>([
            [
              IAgentProfileService,
              {
                _serviceBrand: undefined,
                data: () => ({ profileName: TOWER_WORKER_PROFILE }),
                update: () => {},
                republishStatus: () => {},
                getEffectiveThinkingLevel: () => 'off',
                getActiveToolNames: () => [],
                isToolActive: () => false,
              },
            ],
            [
              IAgentPermissionModeService,
              { _serviceBrand: undefined, mode: 'auto', setMode, onDidChangeMode: Event.None },
            ],
          ]),
        ],
      ]),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({
          'agent-existing': {
            labels: { parentAgentId: 'main', profileName: TOWER_WORKER_PROFILE },
          },
        }),
      ),
    );
    context.get(IAgentPermissionModeService).setMode('manual');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(result).toEqual({
      output: expect.stringContaining(`actual_subagent_type: ${TOWER_WORKER_PROFILE}`),
    });
    expect(setMode).not.toHaveBeenCalled();
    expect(lifecycle.run).toHaveBeenCalledTimes(1);
  });

  it('rejects direct resume of a non-subagent', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({
          main: { type: 'main' },
        }),
      ),
    );
    lifecycle.addHandle('main', 'agent');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue main',
      resume: 'main',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: Agent instance "main" is not a subagent',
    });
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('rejects direct resume of another caller owned subagent', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({ 'agent-existing': subagentMeta('other') }),
      ),
    );
    lifecycle.addHandle('agent-existing', 'explore');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(result).toMatchObject({
      isError: true,
      output:
        'subagent error: Agent instance "agent-existing" does not belong to this parent agent',
    });
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('rejects direct resume of an already running subagent before launching a turn', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionMetadata, sessionMetadataStub({ 'agent-existing': subagentMeta() })),
    );
    lifecycle.addHandle(
      'agent-existing',
      'explore',
      new Map([
        [
          IAgentLoopService,
          {
            _serviceBrand: undefined,
            snapshot: () => ({ state: 'running' }),
          },
        ],
      ]),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(result).toMatchObject({
      isError: true,
      output:
        'subagent error: Agent instance "agent-existing" is already running and cannot run concurrently',
    });
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('keeps a directly resumed subagent on its own recorded model', async () => {
    const targetProfile = {
      _serviceBrand: undefined,
      data: () => ({ profileName: 'explore', modelAlias: 'stale-model' }),
      update: mock(),
      republishStatus: mock(),
      getEffectiveThinkingLevel: () => 'medium',
      isToolActive: () => false,
    } as unknown as IAgentProfileService;
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed result' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionMetadata, sessionMetadataStub({ 'agent-existing': subagentMeta() })),
    );
    lifecycle.addHandle(
      'agent-existing',
      'explore',
      new Map([[IAgentProfileService, targetProfile]]),
    );

    await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(targetProfile.update).not.toHaveBeenCalled();
    expect(lifecycle.run).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-existing' }),
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('registers background subagents with the task manager', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      run_in_background: true,
    });

    expect(result.output).toContain('status: running');
    expect(result.output).toContain('agent_id: agent-child');
    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    expect(context.get(IAgentTaskService).getTask(taskId!)).toMatchObject({
      status: 'running',
      description: 'Find cause',
      timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
    });
    completion.resolve({ summary: 'finished later' });
  });

  it('rejects background subagents when background execution is disabled', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    context.get(IAgentProfileService).update({ activeToolNames: ['Agent'] });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      run_in_background: true,
    });

    expect(result).toMatchObject({
      isError: true,
      output:
        'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.',
    });
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('does not consume a background task slot when validation fails before launch', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(
      lifecycle,
      configServices(() => ({
        providers: {},
        task: { maxRunningTasks: 1 },
      })),
    );

    const invalid = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Invalid background resume',
      resume: 'agent-existing',
      subagent_type: 'explore',
      run_in_background: true,
    });
    const valid = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      run_in_background: true,
    });

    expect(invalid).toMatchObject({
      isError: true,
      output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
    });
    expect(valid.output).toContain('status: running');
    expect(lifecycle.create).toHaveBeenCalledTimes(1);
    completion.resolve({ summary: 'finished later' });
  });

  it('returns an error when background registration hits the task limit', async () => {
    const completions = [
      deferred<{ readonly summary: string }>(),
      deferred<{ readonly summary: string }>(),
    ];
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-first', 'agent-second'],
      runCompletion: (_agentId, _request, options) => {
        const next = completions.shift();
        if (next === undefined) throw new Error('unexpected run');
        options.signal.addEventListener(
          'abort',
          () => {
            next.reject(options.signal.reason);
          },
          { once: true },
        );
        return next.promise;
      },
    });
    const context = createAgentToolContext(
      lifecycle,
      configServices(() => ({
        providers: {},
        task: { maxRunningTasks: 1 },
      })),
    );

    const first = await executeAgentTool(context, {
      prompt: 'Investigate first',
      description: 'Find first',
      run_in_background: true,
    });
    const second = await executeAgentTool(context, {
      prompt: 'Investigate second',
      description: 'Find second',
      run_in_background: true,
    });

    expect(first.output).toContain('status: running');
    expect(second).toMatchObject({
      isError: true,
      output: 'Too many background tasks are already running.',
    });
    expect(lifecycle.create).toHaveBeenCalledTimes(2);
    completions[0]?.resolve({ summary: 'finished later' });
  });

  it('rejects one of two concurrent background subagents when the task limit is reached', async () => {
    const completions = [
      deferred<{ readonly summary: string }>(),
      deferred<{ readonly summary: string }>(),
    ];
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-first', 'agent-second'],
      runCompletion: (_agentId, _request, options) => {
        const next = completions.shift();
        if (next === undefined) throw new Error('unexpected run');
        options.signal.addEventListener('abort', () => next.reject(options.signal.reason), {
          once: true,
        });
        return next.promise;
      },
    });
    const context = createAgentToolContext(
      lifecycle,
      configServices(() => ({
        providers: {},
        task: { maxRunningTasks: 1 },
      })),
    );

    const first = executeAgentTool(context, {
      prompt: 'Investigate first',
      description: 'Find first',
      run_in_background: true,
    });
    const second = executeAgentTool(context, {
      prompt: 'Investigate second',
      description: 'Find second',
      run_in_background: true,
    });

    const results = await Promise.all([first, second]);

    expect(lifecycle.create).toHaveBeenCalledTimes(2);
    expect(results).toContainEqual(
      expect.objectContaining({ output: expect.stringContaining('status: running') }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        isError: true,
        output: 'Too many background tasks are already running.',
      }),
    );
    completions[0]?.resolve({ summary: 'finished later' });
  });

  it('logs background registration failures', async () => {
    const { entries, logger } = captureLogs();
    const completions = [
      deferred<{ readonly summary: string }>(),
      deferred<{ readonly summary: string }>(),
    ];
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-first', 'agent-second'],
      runCompletion: (_agentId, _request, options) => {
        const next = completions.shift();
        if (next === undefined) throw new Error('unexpected run');
        options.signal.addEventListener('abort', () => next.reject(options.signal.reason), {
          once: true,
        });
        return next.promise;
      },
    });
    const context = createAgentToolContext(
      lifecycle,
      configServices(() => ({
        providers: {},
        task: { maxRunningTasks: 1 },
      })),
      sessionService(ILogService, logger),
    );

    await executeAgentTool(context, {
      prompt: 'Investigate first',
      description: 'Find first',
      run_in_background: true,
    });
    await executeAgentTool(context, {
      prompt: 'Investigate second',
      description: 'Find second',
      run_in_background: true,
    });

    expect(entries).toContainEqual({
      level: 'warn',
      message: 'background agent task registration failed',
      payload: expect.objectContaining({
        toolCallId: 'call_agent',
        agentId: 'agent-second',
        subagentType: 'coder',
        error: expect.any(Error),
      }),
    });
    completions[0]?.resolve({ summary: 'finished later' });
  });

  it('returns tool errors and logs when spawning fails', async () => {
    const error = new Error('missing subagent');
    const { entries, logger } = captureLogs();
    const lifecycle = createAgentLifecycleStub({ createError: error });
    const context = createAgentToolContext(lifecycle, sessionService(ILogService, logger));

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: missing subagent',
    });
    expect(entries).toContainEqual({
      level: 'warn',
      message: 'subagent launch failed',
      payload: expect.objectContaining({
        toolCallId: 'call_agent',
        runInBackground: false,
        operation: 'spawn',
        subagentType: 'coder',
        error,
      }),
    });
  });

  it('can detach a foreground subagent through the task manager', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(lifecycle);
    const tasks = context.get(IAgentTaskService);

    const running = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await waitForAssertion(() => {
      expect(tasks.list(false)).toHaveLength(1);
    });
    const task = tasks.list(false)[0]!;

    expect(task).toMatchObject({
      kind: 'agent',
      detached: false,
      agentId: 'agent-child',
    });

    tasks.detach(task.taskId);
    const result = await running;

    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('automatic_notification: true');
    expect(result.output).toContain('note: The user moved this subagent to the background.');

    completion.resolve({ summary: 'finished later' });
    await expect(tasks.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('does not recommend disabled task tools when a foreground subagent is detached', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(lifecycle);
    context.get(IAgentProfileService).update({ activeToolNames: ['Agent'] });
    const tasks = context.get(IAgentTaskService);

    const running = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await waitForAssertion(() => {
      expect(tasks.list(false)).toHaveLength(1);
    });
    const task = tasks.list(false)[0]!;

    tasks.detach(task.taskId);
    const result = await running;

    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('next_step: The completion arrives automatically');
    expect(result.output).not.toContain('TaskOutput');
    expect(result.output).not.toContain('TaskStop');

    completion.resolve({ summary: 'finished later' });
    await expect(tasks.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('steers the AI away from waiting and gives a resume hint on background launch', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      run_in_background: true,
    });

    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    expect(result.output).toContain('next_step:');
    expect(result.output).toContain(BACKGROUND_AGENT_NEXT_STEP);
    expect(result.output).not.toContain('block=false');
    expect(result.output).toContain('resume_hint:');
    expect(result.output).toContain('Agent(resume="agent-child"');
    expect(result.output).toMatch(/agent_id.*not.*task_id|task_id.*not.*agent_id/i);
    expect(result.output).toMatch(/task\.lost|task\.failed|task\.killed/);
    completion.resolve({ summary: 'finished later' });
  });

  it('reports a background subagent stopped by the task manager as cancelled, not failed', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const context = createAgentToolContext(lifecycle);
    const tasks = context.get(IAgentTaskService);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      run_in_background: true,
    });
    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();

    await expect(tasks.stop(taskId!, 'no longer needed')).resolves.toMatchObject({
      status: 'killed',
    });

    const terminal = lifecycle.publishedEvents
      .filter((event) => event.type === 'subagent.failed' || event.type === 'subagent.cancelled')
      .map((event) => event.type);
    expect(terminal).toEqual(['subagent.cancelled']);
  });

  it('reports a deliberate user interruption when a foreground subagent is cancelled by the user', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const context = createAgentToolContext(lifecycle);
    const controller = new AbortController();

    const resultPromise = executeAgentTool(
      context,
      { prompt: 'Investigate', description: 'Find cause' },
      controller.signal,
    );
    await waitForAssertion(() => {
      expect(context.get(IAgentTaskService).list(false)).toHaveLength(1);
    });
    controller.abort(userCancellationReason());
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.output).toContain('status: failed');
    expect(result.output).toContain('stop_reason: cancelled');
    expect(result.output).toContain('The subagent was stopped before it finished by user.');
    expect(result.output).toContain(NO_PARTIAL_OUTPUT);
    expect(result.output).not.toContain('resume_hint:');
    expect(result.output).toContain('next_step: The user stopped this subagent.');
  });

  it('hands back the text a foreground subagent wrote before the user stopped it', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
      partialOutput: () => 'Found the loop at src/parser.ts:42; not verified yet.',
    });
    const context = createAgentToolContext(lifecycle);
    const controller = new AbortController();

    const resultPromise = executeAgentTool(
      context,
      { prompt: 'Investigate', description: 'Find cause' },
      controller.signal,
    );
    await waitForAssertion(() => {
      expect(context.get(IAgentTaskService).list(false)).toHaveLength(1);
    });
    controller.abort(userCancellationReason());
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.output).toContain('status: failed');
    expect(result.output).toContain('stop_reason: cancelled');
    expect(result.output).toContain(
      `${PARTIAL_OUTPUT_NOTICE}\n\nFound the loop at src/parser.ts:42; not verified yet.`,
    );
    expect(result.output).not.toContain(NO_PARTIAL_OUTPUT);
    expect(result.output).toContain('next_step: The user stopped this subagent.');
  });

  it('keeps a completed foreground subagent result free of partial-output notices', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      partialOutput: () => 'Working notes that should not be repeated.',
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError ?? false).toBe(false);
    expect(result.output).toContain('status: completed');
    expect(result.output).toContain('child result');
    expect(result.output).not.toContain('[partial output]');
    expect(result.output).not.toContain('Working notes that should not be repeated.');
  });

  it('reports the reason when a foreground subagent is stopped for another cause', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        }),
    });
    const context = createAgentToolContext(lifecycle);

    const resultPromise = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await waitForAssertion(() => {
      expect(context.get(IAgentTaskService).list(false)).toHaveLength(1);
    });
    const [task] = context.get(IAgentTaskService).list(false);
    await context.get(IAgentTaskService).stop(task!.taskId, 'Session closed');
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.output).toContain('stop_reason: stopped');
    expect(result.output).toContain(
      'The subagent was stopped before it finished. Reason: Session closed',
    );
    expect(result.output).toContain('resume_hint: Continue with Agent(resume="agent-child"');
    expect(result.output).not.toContain('The user stopped this subagent');
  });

  it('returns the spawned agent id when a foreground subagent times out', async () => {
    const timers = createFakeHostTimers();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const context = createAgentToolContext(lifecycle, appService(IHostTimers, timers));

    const resultPromise = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await waitForAssertion(() => {
      expect(context.get(IAgentTaskService).list(false)).toHaveLength(1);
    });
    await advanceHostTime(timers, DEFAULT_SUBAGENT_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('actual_subagent_type: coder');
    expect(result.output).toContain('status: failed');
    expect(result.output).toContain('subagent error: Agent timed out after 2 hours.');
    expect(result.output).toContain('resume_hint:');
    expect(result.output).toContain('Agent(resume="agent-child", prompt="continue")');
    expect(result.output).toContain('do not set subagent_type');
    expect(result.output).toContain('retains its prior context');
  });

  it('honours the configured subagent timeout over the default', async () => {
    const timers = createFakeHostTimers();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const context = createAgentToolContext(lifecycle, appService(IHostTimers, timers), {
      initialConfig: { subagent: { timeoutMs: 1000 } },
    });

    const resultPromise = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await waitForAssertion(() => {
      expect(context.get(IAgentTaskService).list(false)).toHaveLength(1);
    });
    await advanceHostTime(timers, 1000);
    const result = await resultPromise;

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('subagent error: Agent timed out after 1 second.');
  });
});

describe('Agent tool external backends', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  class FakeBackend implements ISubagentBackend {
    readonly name = 'codex' as const;
    readonly startCalls: SubagentBackendStartRequest[] = [];
    readonly runs: SubagentBackendRun[] = [];

    constructor(private readonly outcome: SubagentBackendResult | Error) {}

    async start(request: SubagentBackendStartRequest): Promise<SubagentBackendRun> {
      this.startCalls.push(request);
      if (this.outcome instanceof Error) throw this.outcome;
      const run: SubagentBackendRun = {
        id: 'fake-run-1',
        result: Promise.resolve(this.outcome),
        dispose: mock(async () => {}),
      };
      this.runs.push(run);
      return run;
    }
  }

  function fakeBackendService(backend: FakeBackend): ISubagentBackendService {
    return {
      _serviceBrand: undefined,
      getBackend: (name) => (name === backend.name ? backend : undefined),
      list: () => [backend],
      start: (name, request) => {
        if (name !== backend.name) {
          return Promise.reject(new Error(`Unknown subagent backend "${name}".`));
        }
        return backend.start(request);
      },
    };
  }

  function backendFlags(enabled = true): TestAgentServiceOverride {
    return appService(
      IFlagService,
      stubFlag((id) => enabled && id === SUBAGENT_BACKENDS_FLAG_ID),
    );
  }

  function createBackendContext(
    backend: FakeBackend,
    ...extra: readonly (TestAgentServiceOverride | TestAgentOptions)[]
  ): TestAgentContext {
    ctx = createTestAgent(sessionService(ISubagentBackendService, fakeBackendService(backend)), ...extra);
    return ctx;
  }

  function agentToolProperties(): Record<string, unknown> | undefined {
    const tool = ctx?.toolsData().find((entry) => entry.name === 'Agent');
    expect(tool).toBeDefined();
    return (tool!.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  }

  it('exposes the backend parameter and description when the flag is on', () => {
    createBackendContext(new FakeBackend({ output: 'ok', stopReason: 'completed' }), backendFlags());

    const tool = ctx!.toolsData().find((entry) => entry.name === 'Agent');
    expect(agentToolProperties()).toHaveProperty('backend');
    expect(tool!.description).toContain('Available backends (pass via backend): codex');
  });

  it('omits the backend parameter and description when the flag is off', () => {
    createBackendContext(new FakeBackend({ output: 'ok', stopReason: 'completed' }), backendFlags(false));

    const tool = ctx!.toolsData().find((entry) => entry.name === 'Agent');
    expect(agentToolProperties()).not.toHaveProperty('backend');
    expect(tool!.description).not.toContain('Available backends');
  });

  it('rejects a backend request while the flag is off', async () => {
    const context = createBackendContext(
      new FakeBackend({ output: 'ok', stopReason: 'completed' }),
      backendFlags(false),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      backend: 'codex',
    });

    expect(result).toEqual({ output: BACKENDS_EXPERIMENTAL_UNAVAILABLE, isError: true });
  });

  it.each([
    [{ model: 'provider/fast' }, 'Cannot use backend with model'],
    [{ subagent_type: 'explore' }, 'Cannot use backend with subagent_type'],
    [{ resume: 'agent-1' }, 'Cannot use backend with resume'],
    [{ run_in_background: true }, 'Cannot use backend with run_in_background'],
  ] as const)('rejects %j combined with backend', async (extra, message) => {
    const context = createBackendContext(
      new FakeBackend({ output: 'ok', stopReason: 'completed' }),
      backendFlags(),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      backend: 'codex',
      ...extra,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain(message);
  });

  it('rejects fork combined with backend', async () => {
    const context = createBackendContext(
      new FakeBackend({ output: 'ok', stopReason: 'completed' }),
      appService(
        IFlagService,
        stubFlag((id) => id === SUBAGENT_BACKENDS_FLAG_ID || id === SUBAGENT_FORK_FLAG_ID),
      ),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      backend: 'codex',
      fork: true,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Cannot use backend with fork');
  });

  it('rejects an unknown backend name with the available list', async () => {
    const context = createBackendContext(
      new FakeBackend({ output: 'ok', stopReason: 'completed' }),
      backendFlags(),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      backend: 'mystery',
    });

    expect(result).toEqual({
      output: 'Unknown backend "mystery". Available backends: codex.',
      isError: true,
    });
  });

  it('dispatches to the backend and formats the completed run', async () => {
    const backend = new FakeBackend({ output: 'backend says hi', stopReason: 'completed' });
    const context = createBackendContext(backend, backendFlags());

    const result = await executeAgentTool(context, {
      prompt: 'do the thing',
      description: 'run backend',
      backend: 'codex',
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('backend: codex');
    expect(result.output).toContain('backend_run_id: fake-run-1');
    expect(result.output).toContain('status: completed');
    expect(result.output).toContain('[summary]\nbackend says hi');
    expect(backend.startCalls).toHaveLength(1);
    expect(backend.startCalls[0]?.prompt).toBe('do the thing');
    expect(backend.startCalls[0]?.cwd).toBe(context.get(ISessionWorkspaceContext).workDir);
    expect(backend.runs[0]?.dispose).toHaveBeenCalled();
  });

  it('formats a failed backend run as an error', async () => {
    const backend = new FakeBackend({ output: 'partial work', stopReason: 'error' });
    const context = createBackendContext(backend, backendFlags());

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      backend: 'codex',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('status: failed');
    expect(result.output).toContain('stop_reason: error');
    expect(result.output).toContain('partial work');
    expect(backend.runs[0]?.dispose).toHaveBeenCalled();
  });

  it('surfaces a dispatch rejection from the backend service', async () => {
    const backend = new FakeBackend(
      new Error(
        'Sandbox mode "read-only" blocks external subagent backends ("codex" would run as a separate process outside engine control).',
      ),
    );
    const context = createBackendContext(backend, backendFlags());

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      backend: 'codex',
    });

    expect(result).toEqual({
      output:
        'subagent error: Sandbox mode "read-only" blocks external subagent backends ("codex" would run as a separate process outside engine control).',
      isError: true,
    });
  });

  it('does not touch the in-process spawn path for a backend run', async () => {
    const lifecycle = createAgentLifecycleStub();
    const backend = new FakeBackend({ output: 'ok', stopReason: 'completed' });
    const context = createTestAgent(
      sessionService(ISubagentBackendService, fakeBackendService(backend)),
      sessionService(IAgentLifecycleService, lifecycle),
      backendFlags(),
    );
    ctx = context;

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      backend: 'codex',
    });

    expect(result.isError).toBeUndefined();
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });
});

describe('AgentSwarmToolInputSchema', () => {
  const spawnInput: AgentSwarmToolInput = {
    description: 'Review files',
    prompt_template: 'Review {{item}}',
    items: ['src/a.ts', 'src/b.ts'],
    subagent_type: 'explore',
  };

  it('accepts item-based swarms up to 128 subagents', () => {
    expect(AgentSwarmToolInputSchema.safeParse(spawnInput).success).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        ...spawnInput,
        items: Array.from({ length: 128 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(true);
  });

  it('rejects more than 128 item-based subagents in the JSON args schema', () => {
    expect(
      AgentSwarmToolInputSchema.safeParse({
        ...spawnInput,
        items: Array.from({ length: 129 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(false);
  });

  it('allows resumed subagents without item-based spawns', () => {
    expect(
      AgentSwarmToolInputSchema.safeParse({
        description: 'Resume one agent',
        resume_agent_ids: {
          'agent-old-1': 'Continue previous review',
        },
      }).success,
    ).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        description: 'Resume two agents',
        resume_agent_ids: {
          'agent-old-1': 'Continue previous review A',
          'agent-old-2': 'Continue previous review B',
        },
      }).success,
    ).toBe(true);
  });

  it('references the models section and omits background and timeout parameters', () => {
    const properties = agentSwarmSchemaProperties<{ description?: string }>();

    expect(properties['model']?.description).toContain('Available models');
    expect(properties).not.toHaveProperty('run_in_background');
    expect(properties).not.toHaveProperty('timeout');
  });
});

describe('AgentSwarm tool description', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    await ctx.dispose();
  });

  function agentSwarmDescription(): string {
    const tool = ctx.toolsData().find((entry) => entry.name === 'AgentSwarm');
    expect(tool).toBeDefined();
    return tool!.description;
  }

  it('documents the {{item}} placeholder', () => {
    ctx = createTestAgent();

    expect(agentSwarmDescription()).toContain('{{item}}');
  });

  it('describes fork as inheriting the current type, model, and tools', () => {
    ctx = createTestAgent(forkFlags());

    expect(agentSwarmDescription()).toContain(
      'inheriting your current agent type, model, and tool set.',
    );
    const properties = agentSwarmParameters()['properties'] as Record<string, unknown>;
    expect(properties['fork']).toMatchObject({
      description: 'Start every item-spawned subagent with a snapshot of your completed conversation history, inheriting your current agent type, model, and tool set.',
    });
  });

  it('omits the models section when no [secondary_model.models] pool is configured', () => {
    ctx = createTestAgent();

    expect(agentSwarmDescription()).not.toContain('Available models');
  });

  it('renders the configured pool as a compact one-line summary', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const description = agentSwarmDescription();

    expect(description).toContain(
      'Available models (pass via model): provider/fast [default], provider/smart.',
    );
    expect(description).not.toContain('primary');
  });

  function agentSwarmParameters(): Record<string, unknown> {
    const tool = ctx.toolsData().find((entry) => entry.name === 'AgentSwarm');
    expect(tool?.parameters).toBeDefined();
    return tool!.parameters!;
  }

  it('strips the model parameter from the advertised schema when no pool is configured', () => {
    ctx = createTestAgent();

    const properties = agentSwarmParameters()['properties'] as Record<string, unknown>;

    expect(properties).not.toHaveProperty('model');
    expect(properties).toHaveProperty('prompt_template');
  });

  it('advertises the model parameter only when the pool offers more than one model', async () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: { defaultModel: 'provider/fast' },
        models: POOL_MODEL_ENTRIES,
      },
    });
    expect(agentSwarmParameters()['properties']).not.toHaveProperty('model');
    expect(agentSwarmDescription()).not.toContain('Available models');
    await ctx.dispose();

    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const properties = agentSwarmParameters()['properties'] as Record<
      string,
      { type?: string; enum?: unknown }
    >;

    expect(properties['model']?.type).toBe('string');
    expect(properties['model']?.enum).toBeUndefined();
  });
});

describe('AgentSwarm tool execution contract', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    await ctx.dispose();
  });

  it('runs item-based swarms through the session swarm service and renders XML results', async () => {
    const runSwarm = mock(
      async (
        args: SessionSwarmRunArgs<unknown>,
      ): Promise<readonly SessionSwarmRunResult<unknown>[]> => {
        return args.tasks.map((task, index) => ({
          task,
          agentId: `agent-explore-${String(index + 1)}`,
          status: 'completed' as const,
          result: index === 0 ? 'explore result a' : 'explore result b',
        }));
      },
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem: async () => undefined,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(swarmServices(swarmService));

    const result = await executeTool(agentSwarmToolInSwarmMode(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
        subagent_type: 'explore',
      },
      signal,
    });

    expect(runSwarm).toHaveBeenCalledWith({
      callerAgentId: 'main',
      tasks: [
        {
          kind: 'spawn',
          data: { kind: 'spawn', index: 1, item: 'src/a.ts', prompt: 'Review src/a.ts' },
          profileName: 'explore',
          parentToolCallId: 'call_swarm',
          prompt: 'Review src/a.ts',
          description: 'Review files #1 (explore)',
          swarmIndex: 1,
          swarmItem: 'src/a.ts',
          runInBackground: false,
          signal,
          timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
          plan: {
            profileName: 'explore',
            model: 'mock-model',
            modelSource: 'inherited',
            thinking: 'off',
            fork: false,
          },
        },
        {
          kind: 'spawn',
          data: { kind: 'spawn', index: 2, item: 'src/b.ts', prompt: 'Review src/b.ts' },
          profileName: 'explore',
          parentToolCallId: 'call_swarm',
          prompt: 'Review src/b.ts',
          description: 'Review files #2 (explore)',
          swarmIndex: 2,
          swarmItem: 'src/b.ts',
          runInBackground: false,
          signal,
          timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
          plan: {
            profileName: 'explore',
            model: 'mock-model',
            modelSource: 'inherited',
            thinking: 'off',
            fork: false,
          },
        },
      ],
    });
    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 2</summary>',
        '<subagent agent_id="agent-explore-1" item="src/a.ts" outcome="completed">explore result a</subagent>',
        '<subagent agent_id="agent-explore-2" item="src/b.ts" outcome="completed">explore result b</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('threads the pool default model into spawn task plans', async () => {
    const runSwarm = mock(
      async (args: SessionSwarmRunArgs): Promise<readonly SessionSwarmRunResult[]> => {
        return args.tasks.map((task, index) => ({
          task,
          agentId: `agent-explore-${String(index + 1)}`,
          status: 'completed' as const,
          result: 'ok',
        }));
      },
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem: async () => undefined,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(swarmServices(swarmService), {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    await executeTool(agentSwarmToolInSwarmMode(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
        subagent_type: 'explore',
      },
      signal,
    });

    expect(runSwarm).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          expect.objectContaining({
            kind: 'spawn',
            plan: {
              profileName: 'explore',
              model: 'provider/fast',
              modelSource: 'secondary_pool',
              thinking: undefined,
              fork: false,
            },
          }),
          expect.objectContaining({
            kind: 'spawn',
            plan: {
              profileName: 'explore',
              model: 'provider/fast',
              modelSource: 'secondary_pool',
              thinking: undefined,
              fork: false,
            },
          }),
        ],
      }),
    );
  });

  it('rejects the removed "primary" choice before starting any subagent', async () => {
    const runSwarm = mock(
      async (args: SessionSwarmRunArgs): Promise<readonly SessionSwarmRunResult[]> => {
        return args.tasks.map((task, index) => ({
          task,
          agentId: `agent-explore-${String(index + 1)}`,
          status: 'completed' as const,
          result: 'ok',
        }));
      },
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem: async () => undefined,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(swarmServices(swarmService), {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap' },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const result = await executeTool(agentSwarmToolInSwarmMode(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
        subagent_type: 'explore',
        model: 'primary',
      },
      signal,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Invalid model "primary". Available models: provider/fast.');
    expect(runSwarm).not.toHaveBeenCalled();
  });

  it('resumes mapped agents before spawning item subagents', async () => {
    const persistedItems: Record<string, string> = {
      'agent-old-1': 'src/old-a.ts',
      'agent-old-2': 'src/old-b.ts',
    };
    const getSwarmItem = mock(
      async ({ agentId }: { readonly agentId: string }) => persistedItems[agentId],
    );
    const runSwarm = mock(
      async (
        args: SessionSwarmRunArgs<unknown>,
      ): Promise<readonly SessionSwarmRunResult<unknown>[]> => {
        return args.tasks.map((task, index) => ({
          task,
          agentId: task.kind === 'resume' ? task.resumeAgentId : `agent-new-${String(index + 1)}`,
          status: 'completed' as const,
          result: `result ${String(index + 1)}`,
        }));
      },
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(swarmServices(swarmService));

    const result = await executeTool(agentSwarmToolInSwarmMode(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Finish review',
        subagent_type: 'explore',
        prompt_template: 'Review {{item}}',
        items: ['src/new.ts'],
        resume_agent_ids: {
          'agent-old-1': 'Continue previous review A',
          'agent-old-2': 'Continue previous review B',
        },
      },
      signal,
    });

    expect(getSwarmItem).toHaveBeenCalledWith({
      callerAgentId: 'main',
      agentId: 'agent-old-1',
    });
    expect(getSwarmItem).toHaveBeenCalledWith({
      callerAgentId: 'main',
      agentId: 'agent-old-2',
    });
    expect(runSwarm).toHaveBeenCalledWith({
      callerAgentId: 'main',
      tasks: [
        {
          kind: 'resume',
          data: {
            kind: 'resume',
            index: 1,
            agentId: 'agent-old-1',
            item: 'src/old-a.ts',
            prompt: 'Continue previous review A',
          },
          profileName: 'subagent',
          parentToolCallId: 'call_swarm',
          prompt: 'Continue previous review A',
          description: 'Finish review #1 (resume)',
          swarmIndex: 1,
          swarmItem: 'src/old-a.ts',
          runInBackground: false,
          resumeAgentId: 'agent-old-1',
          signal,
          timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
        },
        {
          kind: 'resume',
          data: {
            kind: 'resume',
            index: 2,
            agentId: 'agent-old-2',
            item: 'src/old-b.ts',
            prompt: 'Continue previous review B',
          },
          profileName: 'subagent',
          parentToolCallId: 'call_swarm',
          prompt: 'Continue previous review B',
          description: 'Finish review #2 (resume)',
          swarmIndex: 2,
          swarmItem: 'src/old-b.ts',
          runInBackground: false,
          resumeAgentId: 'agent-old-2',
          signal,
          timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
        },
        {
          kind: 'spawn',
          data: {
            kind: 'spawn',
            index: 3,
            item: 'src/new.ts',
            prompt: 'Review src/new.ts',
          },
          profileName: 'explore',
          parentToolCallId: 'call_swarm',
          prompt: 'Review src/new.ts',
          description: 'Finish review #3 (explore)',
          swarmIndex: 3,
          swarmItem: 'src/new.ts',
          runInBackground: false,
          signal,
          timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
          plan: {
            profileName: 'explore',
            model: 'mock-model',
            modelSource: 'inherited',
            thinking: 'off',
            fork: false,
          },
        },
      ],
    });
    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 3</summary>',
        '<subagent mode="resume" agent_id="agent-old-1" item="src/old-a.ts" outcome="completed">result 1</subagent>',
        '<subagent mode="resume" agent_id="agent-old-2" item="src/old-b.ts" outcome="completed">result 2</subagent>',
        '<subagent agent_id="agent-new-3" item="src/new.ts" outcome="completed">result 3</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('reports failed subagents inside the XML result without failing the tool', async () => {
    const runSwarm = mock(
      async (
        args: SessionSwarmRunArgs<unknown>,
      ): Promise<readonly SessionSwarmRunResult<unknown>[]> => [
        {
          task: args.tasks[0]!,
          agentId: 'agent-coder-1',
          status: 'completed' as const,
          result: 'imports are stable',
        },
        {
          task: args.tasks[1]!,
          agentId: 'agent-coder-2',
          status: 'failed' as const,
          error: 'Agent timed out after 30s.',
        },
      ],
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem: async () => undefined,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(swarmServices(swarmService));

    const result = await executeTool(agentSwarmToolInSwarmMode(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      },
      signal,
    });

    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1, failed: 1</summary>',
        '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
        '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
        '<subagent agent_id="agent-coder-2" item="src/b.ts" outcome="failed">Agent timed out after 30s.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('omits the resume hint when incomplete subagents have no agent ids', async () => {
    const runSwarm = mock(
      async (
        args: SessionSwarmRunArgs<unknown>,
      ): Promise<readonly SessionSwarmRunResult<unknown>[]> => [
        {
          task: args.tasks[0]!,
          status: 'failed' as const,
          error: 'Agent did not start.',
        },
        {
          task: args.tasks[1]!,
          status: 'failed' as const,
          error: 'Agent also did not start.',
        },
      ],
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem: async () => undefined,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(swarmServices(swarmService));

    const result = await executeTool(agentSwarmToolInSwarmMode(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      },
      signal,
    });

    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>failed: 2</summary>',
        '<subagent item="src/a.ts" outcome="failed">Agent did not start.</subagent>',
        '<subagent item="src/b.ts" outcome="failed">Agent also did not start.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.output).not.toContain('<resume_hint>');
    expect(result.isError).toBeUndefined();
  });

  it('renders a handoff stop reason on a completed subagent and offers a resume hint', async () => {
    const runSwarm = mock(
      async (
        args: SessionSwarmRunArgs<unknown>,
      ): Promise<readonly SessionSwarmRunResult<unknown>[]> => [
        {
          task: args.tasks[0]!,
          agentId: 'agent-coder-1',
          status: 'completed' as const,
          result: 'imports are stable',
        },
        {
          task: args.tasks[1]!,
          agentId: 'agent-coder-2',
          status: 'completed' as const,
          result: 'Stuck: the same grep keeps returning nothing.',
          stopReason: 'repeat_breaker',
        },
      ],
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem: async () => undefined,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(swarmServices(swarmService));

    const result = await executeTool(agentSwarmToolInSwarmMode(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      },
      signal,
    });

    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 2</summary>',
        '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
        '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
        '<subagent agent_id="agent-coder-2" item="src/b.ts" outcome="completed" stop_reason="repeat_breaker">Stuck: the same grep keeps returning nothing.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('reports partial aborted subagents inside the XML result', async () => {
    const runSwarm = mock(
      async (
        args: SessionSwarmRunArgs<unknown>,
      ): Promise<readonly SessionSwarmRunResult<unknown>[]> => [
        {
          task: args.tasks[0]!,
          agentId: 'agent-coder-1',
          status: 'completed' as const,
          result: 'imports are stable',
        },
        {
          task: args.tasks[1]!,
          agentId: 'agent-coder-2',
          status: 'aborted' as const,
          state: 'started' as const,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          task: args.tasks[2]!,
          status: 'aborted' as const,
          state: 'not_started' as const,
          error:
            'The user manually interrupted this subagent batch before this subagent was started.',
        },
      ],
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem: async () => undefined,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(swarmServices(swarmService));

    const result = await executeTool(agentSwarmToolInSwarmMode(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      },
      signal,
    });

    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1, aborted: 2</summary>',
        '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
        '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
        '<subagent agent_id="agent-coder-2" item="src/b.ts" state="started" outcome="aborted">The user manually interrupted this subagent batch before this subagent finished.</subagent>',
        '<subagent item="src/c.ts" state="not_started" outcome="aborted">The user manually interrupted this subagent batch before this subagent was started.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('declares broad accesses and does not expose permission rule argument matching', async () => {
    ctx = createTestAgent();

    const execution = await agentSwarmToolInSwarmMode(ctx).resolveExecution({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });

    if (execution.isError === true)
      throw new Error('AgentSwarm resolveExecution returned an error');
    expect(execution.accesses).toEqual(ToolAccesses.all());
    expect(execution.approvalRule).toBe('AgentSwarm');
    expect(execution.matchesRule).toBeUndefined();
    expect(execution.description).toBe('Launching agent swarm: Review files');
    expect(execution.display).toMatchObject({
      kind: 'agent_call',
      agent_name: 'swarm (2 subagents)',
      prompt: 'Review files',
    });
  });

  it('counts resumed and item-based subagents in the display name', async () => {
    ctx = createTestAgent();

    const execution = await agentSwarmToolInSwarmMode(ctx).resolveExecution({
      description: 'Finish review',
      prompt_template: 'Review {{item}}',
      items: ['src/new.ts'],
      resume_agent_ids: {
        'agent-old-1': 'Continue previous review A',
        'agent-old-2': 'Continue previous review B',
      },
    });

    if (execution.isError === true)
      throw new Error('AgentSwarm resolveExecution returned an error');
    expect(execution.display).toMatchObject({
      agent_name: 'swarm (3 subagents)',
      prompt: 'Finish review',
    });
  });
});

describe('Agent tools', () => {
  let context: IAgentContextMemoryService;
  let ctx: TestAgentContext;
  let profile: IAgentProfileService;
  let tools: IAgentToolRegistryService;
  let tempHomeDirs: string[] = [];

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      try {
        await ctx.dispose();
      } finally {
        for (const dir of tempHomeDirs) {
          rmSync(dir, { recursive: true, force: true });
        }
        tempHomeDirs = [];
      }
    }
  });

  describe('PreToolUse blocking', () => {
    let exec: ReturnType<typeof mock>;
    let triggered: Array<[string, string, number]>;

    beforeEach(() => {
      exec = mock<IHostProcessService['spawn']>().mockRejectedValue(
        new Error('Bash should not execute'),
      );
      triggered = [];
      const hookEngine = makeHookRunner(
        [
          {
            event: 'PreToolUse',
            matcher: 'Bash',
            command:
              process.platform === 'win32'
                ? 'echo blocked by PreToolUse 1>&2 & exit 2'
                : "echo 'blocked by PreToolUse' >&2; exit 2",
          },
          {
            event: 'PostToolUseFailure',
            matcher: 'Bash',
            command: 'exit 0',
          },
        ],
        {
          onTriggered: (event, target, count) => {
            triggered.push([event, target, count]);
          },
        },
      );
      ctx = createTestAgent(
        execEnvServices({
          processRunner: createFakeProcessRunner({
            spawn: exec as unknown as IHostProcessService['spawn'],
          }),
        }),
        externalHookServices(hookEngine),
      );
      context = ctx.get(IAgentContextMemoryService);
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
    });

    it('blocks tools before permission and emits PostToolUseFailure', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'The hook blocked Bash.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Try Bash' }] });

      await ctx.untilTurnEnd();

      expect(exec).not.toHaveBeenCalled();
      expect(triggered).toEqual([
        ['PreToolUse', 'Bash', 1],
        ['PostToolUseFailure', 'Bash', 1],
      ]);
      expect(JSON.stringify(context.get())).toContain('blocked by PreToolUse');
    });
  });

  describe('successful Bash hook flow', () => {
    let resolved: Array<[string, string, string]>;

    beforeEach(async () => {
      resolved = [];
      const hookEngine = makeHookRunner(
        [
          {
            event: 'PreToolUse',
            matcher: 'Bash',
            command: hookPayloadAssertCommand({
              event: 'PreToolUse',
              toolName: 'Bash',
              toolCallId: 'call_bash',
              toolInputCommand: 'printf hook-output',
            }),
          },
          {
            event: 'PostToolUse',
            matcher: 'Bash',
            command: hookPayloadAssertCommand({
              event: 'PostToolUse',
              toolName: 'Bash',
              toolCallId: 'call_bash',
              toolInputCommand: 'printf hook-output',
              toolOutput: 'hook-output',
            }),
          },
        ],
        {
          onResolved: (event, target, action) => {
            resolved.push([event, target, action]);
          },
        },
      );
      ctx = createTestAgent(
        execEnvServices({ processRunner: createCommandRunner('hook-output') }),
        externalHookServices(hookEngine),
      );
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
      await ctx.rpc.setPermission({ mode: 'auto' });
    });

    it('runs PreToolUse before successful tools and emits PostToolUse with output', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'Bash returned hook-output.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });

      await ctx.untilTurnEnd();

      await waitForAssertion(() => {
        expect(resolved).toEqual([
          ['PreToolUse', 'Bash', 'allow'],
          ['PostToolUse', 'Bash', 'allow'],
        ]);
      });
    });
  });

  describe('failed Bash hook flow', () => {
    let resolved: Array<[string, string, string]>;

    beforeEach(async () => {
      resolved = [];
      const hookEngine = makeHookRunner(
        [
          {
            event: 'PostToolUseFailure',
            matcher: 'Bash',
            command: hookPayloadAssertCommand({
              event: 'PostToolUseFailure',
              toolName: 'Bash',
              toolCallId: 'call_bash',
              toolInputCommand: 'printf hook-output',
              errorMessageIncludes: 'hook-output\nCommand failed with exit code: 2.',
            }),
          },
        ],
        {
          onResolved: (event, target, action) => {
            resolved.push([event, target, action]);
          },
        },
      );
      ctx = createTestAgent(
        execEnvServices({ processRunner: createFailingCommandRunner('hook-output') }),
        externalHookServices(hookEngine),
      );
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
      await ctx.rpc.setPermission({ mode: 'auto' });
    });

    it('emits PostToolUseFailure with payload when a builtin tool execution fails', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'Bash failed.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });

      await ctx.untilTurnEnd();

      await waitForAssertion(() => {
        expect(resolved).toEqual([['PostToolUseFailure', 'Bash', 'allow']]);
      });
    });
  });

  describe('Bash tool call start event', () => {
    beforeEach(async () => {
      ctx = createTestAgent(execEnvServices({ processRunner: createCommandRunner('ok') }));
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
      await ctx.rpc.setPermission({ mode: 'yolo' });
    });

    it('uses builtin descriptions on tool call start events', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'Bash returned ok.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });
      await ctx.untilTurnEnd();

      const started = ctx.allEvents.find(
        (event) => event.type === '[rpc]' && event.event === 'tool.call.started',
      );
      expect(started?.args).toMatchObject({
        description: 'Running: printf hook-output',
      });
    });
  });

  describe('foreground Agent tool recovery', () => {
    beforeEach(() => {
      const lifecycle = createAgentLifecycleStub({
        createAgentIds: ['agent-child'],
        runCompletion: async () => {
          throw new Error(
            'Subagent turn failed before completing its final summary: reason=max_tokens',
          );
        },
      });
      ctx = createTestAgent(sessionService(IAgentLifecycleService, lifecycle));
      wireRealSubagentService(ctx, lifecycle);
    });

    it('continues after a foreground Agent tool returns a max_tokens failure', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will delegate.' }, agentCall());
      ctx.mockNextResponse({ type: 'text', text: 'I recovered from the subagent failure.' });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use an agent' }] });
      await ctx.untilTurnEnd();

      expect(ctx.contextData().history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'call_agent',
            content: [
              expect.objectContaining({
                text: expect.stringContaining('reason=max_tokens'),
              }),
            ],
          }),
          expect.objectContaining({
            role: 'assistant',
            content: [
              expect.objectContaining({
                text: 'I recovered from the subagent failure.',
              }),
            ],
          }),
        ]),
      );
    });

    it('fails an agent run when the final summary is truncated', async () => {
      await ctx.dispose();
      ctx = createTestAgent();
      ctx.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'partial summary' }],
        finishReason: 'truncated',
        rawFinishReason: 'length',
      });

      const run = await runAgentTurn(
        currentAgentHandle(ctx, 'agent-child'),
        { kind: 'prompt', prompt: 'Investigate' },
        { signal },
      );

      await expect(run.completion).rejects.toThrow(
        'Subagent turn failed before completing its final summary: reason=max_tokens',
      );
    });
  });

  describe('registered user tool failure hooks', () => {
    let resolved: Array<[string, string, string]>;

    beforeEach(async () => {
      const lookupCall: ToolCall = {
        type: 'function',
        id: 'call_lookup',
        name: 'Lookup',
        arguments: '{"query":"moon"}',
      };
      resolved = [];
      const hookEngine = makeHookRunner(
        [
          {
            event: 'PostToolUseFailure',
            matcher: 'Lookup',
            command: hookErrorMessageAssertCommand('rich failure text'),
          },
        ],
        {
          onResolved: (event, target, action) => {
            resolved.push([event, target, action]);
          },
        },
      );
      ctx = createTestAgent(externalHookServices(hookEngine));
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.rpc.registerTool({
        name: 'Lookup',
        description: 'Look up a short test value.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      });
      ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    });

    it('passes text from content-part error outputs to PostToolUseFailure hooks', async () => {
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
      await ctx.untilToolCall({
        isError: true,
        output: [{ type: 'text', text: 'rich failure text' }],
      });

      ctx.mockNextResponse({ type: 'text', text: 'The lookup failed.' });
      await ctx.untilTurnEnd();

      await waitForAssertion(() => {
        expect(resolved).toEqual([['PostToolUseFailure', 'Lookup', 'allow']]);
      });
    });
  });

  describe('active builtin tool set', () => {
    beforeEach(() => {
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Write', 'Bash'] });
    });

    it('uses the active builtin tool set as the LLM visible tools', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'ready' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Which tools are active?' }] });

      await ctx.untilTurnEnd();
      expect(renderSnapshot(ctx.lastLlmInput())).toMatchInlineSnapshot(`
      "system: <system-prompt>
      tools: Bash, Write
      messages:
        user: text "Which tools are active?""
    `);
    });
  });

  describe('Bash background mode', () => {
    beforeEach(() => {
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
      tools = ctx.get(IAgentToolRegistryService);
      profile.update({ activeToolNames: ['Bash'] });
    });

    it('disables Bash background mode unless task management tools are active', async () => {
      const bashOnly = ctx.toolsData().find((tool) => tool.name === 'Bash');
      const bashTool = tools.resolve('Bash');
      expect(bashOnly).toBeDefined();
      expect(bashTool).toBeDefined();
      await expect(
        executeTool(bashTool!, {
          turnId: 0,
          toolCallId: 'call_bash',
          args: { command: 'sleep 10', run_in_background: true, description: 'watch' },
          signal,
        }),
      ).resolves.toMatchObject({
        isError: true,
        output:
          'Background execution is not available for this agent because TaskOutput and TaskStop are not enabled.',
      });

      await ctx.rpc.setActiveTools({ names: ['Bash', 'TaskList', 'TaskOutput', 'TaskStop'] });

      const managedBash = ctx.toolsData().find((tool) => tool.name === 'Bash');
      expect(managedBash).toBeDefined();
      expect(managedBash!.description).toContain('run_in_background=true');
    });
  });

  describe('AgentSwarm visibility', () => {
    beforeEach(() => {
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['AgentSwarm'] });
    });

    it('exposes AgentSwarm by default', () => {
      expect(ctx.toolsData().some((tool) => tool.name === 'AgentSwarm')).toBe(true);
    });
  });

  describe('registered user tools', () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };

    beforeEach(async () => {
      ctx = createTestAgent();
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.rpc.registerTool({
        name: 'Lookup',
        description: 'Look up a short test value.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      });
    });

    it('routes registered user tools through tool.call request/response', async () => {
      await ctx.restorePersisted();
      ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
      expect(
        renderSnapshot(
          await ctx.untilToolCall({
            content: 'moon-result',
            output: 'moon-result',
          }),
        ),
      ).toMatchInlineSnapshot(`
        "[wire] permission.set_mode         { "agentId": "main", "mode": "auto", "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "permission": "auto" }
        [wire] tools.register_user_tool    { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "agentId": "main", "time": "<time>" }
        [emit] prompt.submitted            { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Look up moon" } ], "createdAt": "<time>" }
        [wire] turn.prompt                 { "agentId": "main", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "time": "<time>" }
        [emit] turn.prompt                 { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0 }
        [emit] turn.started                { "time": "<time>", "agentId": "main", "turnId": 0, "promptId": "<msg-1>", "origin": { "kind": "user" }, "prompt": "Look up moon" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "id": "<msg-1>", "toolCalls": [], "origin": { "kind": "user" } } ] }
        [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
        [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "id": "<msg-1>", "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
        [wire] agent.message.appended      { "message": { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ] }, "meta": { "source": "input", "promptId": "<msg-1>", "origin": { "kind": "user" }, "tracked": true, "createdAt": "<time>", "userMessageId": "<msg-1>" } }, "time": "<time>", "kind": "event" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" } } ] }
        [wire] agent.turn.started          { "turnId": 0, "queueItemId": "<msg-1>", "time": "<time>", "kind": "event" }
        [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" } }, "time": "<time>" }
        [wire] tool_select.initialized     { "agentId": "main", "tools": [ { "name": "Agent", "description": "Launch a subagent to handle a task in its own context.\\n\\nDo not launch a subagent unless the user explicitly asks for one, including delegation, parallel agents, or a named agent type. Explicit instructions in AGENTS.md or a skill, and user-enabled multi-agent modes, also authorize launching. Large or multi-part tasks and requests for depth, thoroughness, research, or investigation do not; do that work yourself. Agent type descriptions below guide selection only after authorization. Resuming already-authorized work needs no new request. Each subagent starts cold and re-derives context, costing time and tokens.\\n\\nWriting the prompt:\\n- Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\\n- Lookups: put exact paths or commands you already know in the prompt.\\n- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.\\n- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.\\n\\nUsage notes:\\n- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its \`resume\` id) over spawning a fresh instance — the resumed agent keeps its prior context.\\n- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.\\n\\nWhen NOT to use Agent: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.\\n\\nOnce a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.\\n\\n\\nWith \`run_in_background=true\`, the subagent runs detached and its result arrives automatically in a later turn as a synthetic user-role message — for an agent task it states that the subagent finished and points at the output file, so read that file to get the result. Continue with other work or respond to the user, and never fabricate or predict the result. Use it only when you have other work to do meanwhile. When your next step needs the result, run the subagent in the foreground instead of launching it in the background and waiting on it.\\n\\n\\nAvailable agent types (pass via subagent_type):\\n- plan: Read-only implementation planning and architecture design. Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.\\n  Tools: Read, Glob, Grep, WebSearch, FetchURL\\n- coder: General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code. Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.\\n  Tools: Bash, CronCreate, CronDelete, CronList, Edit, ExitSpecMode, Glob, Grep, Read, run_code, Skill, SnapshotList, TaskList, TaskOutput, TaskStop, TodoList, WaitFor, WebSearch, FetchURL, Write, mcp__*\\n- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases: it finds files by patterns (e.g. \\"src/**/*.yaml\\"), searches code for keywords (e.g. \\"database connection\\"), and answers questions about the codebase (e.g. \\"how does the auth module work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"thorough\\" for comprehensive analysis across multiple locations and naming conventions.\\n  Tools: Bash, Read, Glob, Grep, WebSearch, FetchURL", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "subagent_type": { "description": "One of the available agent types (see \\"Available agent types\\" in this tool description). Defaults to \\"coder\\" when omitted.", "type": "string" }, "resume": { "description": "Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.", "type": "string" }, "run_in_background": { "description": "If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.", "type": "boolean" } }, "required": [ "prompt", "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AgentSwarm", "description": "Launch multiple subagents from one prompt template, existing agent resumes, or both.\\n\\nAgentSwarm runs only while swarm mode is on, and only the user can turn swarm mode on. When swarm mode is off, do not call AgentSwarm: the call is rejected and no subagents start.\\n\\nUse AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly \`{{item}}\`. For example, with \`prompt_template\` set to \`Review {{item}} for likely regressions.\` and \`items\` set to \`[\\"src/a.ts\\", \\"src/b.ts\\"]\`, AgentSwarm launches two new subagents with those two concrete prompts. For a few differently-shaped tasks, make separate \`Agent\` calls in one message instead.\\n\\nUse \`resume_agent_ids\` to continue subagents that already exist from earlier work, such as ones that failed or timed out. Pass a flat object: keys are existing \`agent_id\` strings (as reported in a previous swarm's \`<subagent agent_id=\\"...\\">\` output), values are the continuation prompt for that subagent (usually \`\\"continue\\"\` if no extra information is needed). For example, with \`resume_agent_ids\` set to \`{\\"agent-coder-1\\": \\"continue\\", \\"agent-coder-2\\": \\"focus on the imports\\"}\`, AgentSwarm resumes those two existing subagents and spawns no new ones. You may combine \`resume_agent_ids\` with \`items\` to resume some and spawn others; resumed agents always run before fresh spawns and keep their original \`subagent_type\` and model. \`resume_agent_ids\` is a flat record — do not pass an array or a list of \`{item, prompt}\` objects, and do not use \`{{item}}\` as a key: that placeholder only applies to \`prompt_template\`.\\n\\nEach of these is enforced — a violation is rejected before any subagent starts: provide at least 2 \`items\` unless you pass \`resume_agent_ids\`; whenever \`items\` are present, \`prompt_template\` is required and must contain \`{{item}}\`; and the filled-in prompts must be distinct (two items that expand to the same prompt are rejected).\\n\\nUse enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.\\n\\nIf \`AgentSwarm\` is called, that call must be the only tool call in the response.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "description": { "type": "string", "minLength": 1, "description": "Short description for the whole swarm." }, "subagent_type": { "description": "Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.", "type": "string", "minLength": 1 }, "prompt_template": { "description": "Prompt template for each subagent. The {{item}} placeholder is replaced with each item value.", "type": "string", "minLength": 1 }, "items": { "description": "Values used to fill {{item}}. Each item launches one new subagent.", "maxItems": 128, "type": "array", "items": { "type": "string", "minLength": 1 } }, "resume_agent_ids": { "description": "Flat object: keys are existing subagent agent_id strings (from a previous swarm's \`<subagent agent_id=\\"...\\">\` result), values are the continuation prompt for that subagent (e.g. \\"continue\\"). Resumed subagents run before new item-based subagents. Do not pass an array or a list of {item, prompt} objects.", "type": "object", "propertyNames": { "type": "string", "minLength": 1 }, "additionalProperties": { "type": "string", "minLength": 1 } } }, "required": [ "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AskUserQuestion", "description": "Use this tool when you need to ask the user questions with structured options during execution. This allows you to:\\n1. Collect user preferences or requirements before proceeding\\n2. Resolve ambiguous or underspecified instructions\\n3. Let the user decide between implementation approaches as you work\\n4. Present concrete options when multiple valid directions exist\\n\\n**When NOT to use:**\\n- When you can infer the answer from context — be decisive and proceed\\n- Trivial decisions that don't materially affect the outcome\\n\\nOverusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.\\n\\n**Usage notes:**\\n- Question texts must be unique across the call, and option labels must be unique within each question\\n- Group related questions into one call to minimize interruptions\\n- List a recommended option first\\n- The result is JSON with an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked \\"Other\\"); if \`answers\` is empty and a \`note\` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question\\n- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately. The answer arrives automatically in a later turn — you do not need to poll, sleep, or check on it. Continue with other work; never fabricate or predict the answer.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "description": "Whether the user can select multiple options.", "type": "boolean" }, "multiSelect": { "description": "Deprecated camelCase alias of multi_select; prefer multi_select.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." }, "background": { "default": false, "description": "Set true to ask in the background and return immediately with a background task_id; you are notified automatically when the user answers — do not poll with TaskOutput while the question is pending.", "type": "boolean" } }, "required": [ "questions" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, and anything the dedicated tools do not cover.\\n\\n- \`ls\` / \`find\` (list files) → \`Glob\`\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nEach call runs in a fresh shell: variables and \`cd\` do not persist, so pass \`cwd\` or use absolute paths. stdout and stderr are combined and may be truncated; a non-zero exit ends the output with \`Command failed with exit code: N\`. Do not run interactive commands or commands that never exit. Set \`timeout\` for possibly long-running commands. A foreground command that hits its timeout is moved to the background instead of being killed, and you are notified when it completes. The user can also move a running foreground command to the background at any time.\\n\\nFor long-running builds, tests, watchers, or servers that the conversation should not wait on, set \`run_in_background=true\` with a short \`description\`; the call returns a task ID. Set \`disable_timeout=true\` only when the task should run without a timeout. You are notified automatically when the task completes, so return control to the user instead of waiting on it. Use \`TaskOutput\` only for a non-blocking snapshot, and \`TaskStop\` only to cancel.\\n\\n- Use \`&&\` for commands that depend on each other. Issue independent read-only commands (separate \`git show\`, \`ls\`, or status checks) as parallel Bash calls in one response instead of chaining them or stitching their output with \`echo\` separators.\\n- Avoid \`..\` paths outside the working directory, and do not modify files outside it unless explicitly instructed.\\n- Do not use superuser privileges unless explicitly instructed. Run git-mutating commands such as \`git commit\`, \`git push\`, \`git reset\`, and \`git rebase\` only when the user asks for them.\\n- Command availability depends on the host; run \`which <command>\` before relying on an uncommon one. For GitHub work (PRs, issues, CI runs, API queries), prefer the \`gh\` CLI when installed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CreateGoal", "description": "Create a durable goal that the runtime pursues across multiple turns. Call it only when the user explicitly asks you to start a goal or work autonomously toward an outcome, or a host goal-intake prompt asks you to create one. Do not create a goal for greetings, ordinary questions, or requests without a checkable end state.\\n\\nWhen the request is vague, ask the user for the missing completion criterion first; if they clearly insist after you warn them that the wording is vague or risky, create the goal anyway. Include \`completionCriterion\` when the user provides one, or when it can be stated without inventing new requirements. Keep \`objective\` concise and reference long task descriptions by file path. Creating fails if a goal already exists; pass \`replace: true\` only when the user explicitly wants to abandon the current goal and start a new one.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" } }, "required": [ "objective" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronCreate", "description": "Schedule a prompt to be enqueued later in this session, recurring or once.\\n\\nWhen the requested time is approximate, avoid minute 0 and 30 so fires from many users do not land at once: \\"around 9\\" → \`57 8 * * *\`, \\"hourly\\" → \`7 * * * *\`.\\n\\nTasks fire only while this session is alive and idle, and never carry over to a new session. Missed fires collapse into one delivery with \`coalescedCount\` > 1: act on the latest state once. The final fire carries \`stale=\\"true\\"\`, so call CronCreate again with the same \`cron\` and \`prompt\` if the schedule is still wanted.\\n\\nUsers cannot manage cron tasks themselves: after creating one, tell the user its \`id\` and that they can ask you to cancel or change it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "cron": { "type": "string", "description": "5-field cron expression in local time: \\"M H DoM Mon DoW\\" (e.g. \\"*/5 * * * *\\" = every 5 minutes; \\"30 14 28 2 *\\" = Feb 28 at 2:30pm local — a pinned date like this repeats yearly unless you also pass recurring: false)." }, "prompt": { "type": "string", "minLength": 1, "maxLength": 8192, "description": "The prompt to enqueue at each fire time. Limited to 8 KiB (UTF-8)." }, "recurring": { "default": true, "description": "true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for \\"remind me at X\\" one-shot requests with pinned minute/hour/dom/month.", "type": "boolean" } }, "required": [ "cron", "prompt" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronDelete", "description": "Cancel a live cron task by its \`id\`. Fired one-shots and expired tasks are already gone; if an id is not found, call CronList instead of retrying it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "id": { "type": "string", "description": "The cron job id (ULID) returned by CronCreate / CronList." } }, "required": [ "id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronList", "description": "List this session's cron tasks. Read-only. \`stale: true\` marks a recurring task whose next fire is its last. After a context compaction, call this instead of guessing ids.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Edit", "description": "Perform exact replacements in existing files.\\n\\n- Drop the line-number prefix and tab; match only file content.\\n- \`old_string\` must be unique unless \`replace_all\` is set.\\n- If \`old_string\` is ambiguous, add surrounding context.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "EnterSpecMode", "description": "Use this tool when the user asks for a spec, or when a change is large enough that agreeing on the contract before writing code is worth a detour.\\n\\nGetting sign-off on a written spec before implementation prevents wasted effort: the user reviews requirements, design and tasks once, then you execute against that agreed contract instead of guessing.\\n\\n**What spec mode is for.** Plan mode produces a throwaway plan for one session. Spec mode writes documents that live in the repository, get committed alongside the code, and are read again by later sessions and teammates. Reach for it when the artifact should outlive this conversation.\\n\\n**Your workflow — write all four before calling ExitSpecMode:**\\n\\n1. Investigate with read-only tools (Read, Grep, Glob). Use Bash only when needed.\\n2. Write \`requirements.md\` — what to build. State the goal, who it is for, the boundaries, and explicitly what is *out of scope*. A requirement the user did not imply is a defect, not initiative.\\n3. Write \`design.md\` — how to build it. Name the concrete approach (files, functions, contracts), the technical constraints, and the trade-offs you rejected along with why.\\n4. Write \`tasks.md\` — how to verify it. Split the work into tasks small enough to finish and to check independently.\\n5. Call ExitSpecMode for approval. Nothing outside the spec directory can be written until the user approves.\\n\\n**Tasks must carry acceptance criteria.** A task that says \\"implement the export endpoint\\" cannot be verified. Write what must hold when it is done — the specific error, status, field, threshold or boundary that proves it. \\"Handles errors\\" is not a criterion; \\"returns 409 when the email already exists\\" is. Prefer criteria you can check by running something over criteria that need judgement.\\n\\n**Do not restate the project's global rules.** Conventions that already live in AGENTS.md / DEVELOP.md apply everywhere and belong there, not in a spec about one change. Reference them; do not copy them. A spec that repeats global rules goes stale the moment those rules move.\\n\\n**Keep the user in the loop on genuinely open questions.** If the requirements leave a decision that materially changes the design, ask before writing — an invented requirement buried in a spec is harder to notice than a question.\\n\\n**Constraints:**\\n- Writes are restricted to the spec directory until the user approves the spec; other edits are rejected. Call ExitSpecMode when the documents are ready.\\n- Do not create \`progress.md\` while in spec mode — it records implementation progress later, and this mode produces the three required documents above. Writes are not limited to those three: any file inside the spec directory is writable, so \`progress.md\` is accepted if the spec or the user calls for it.\\n- Plan, spec, swarm and tower modes are mutually exclusive. Entering spec mode leaves whichever of the others was active; the result names it, if any. You do not need to exit the other mode yourself.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ExitPlanMode", "description": "Request the user's approval of the plan you wrote to the plan file in plan mode. The tool reads the plan from that file and takes no plan content. The user reviews it before plan mode ends, in every permission mode, and can approve it, ask for revisions, or reject it; if they do not approve, revise the plan and call ExitPlanMode again.\\n\\nWrite the plan for a reviewer: they should be able to judge it quickly, and an implementer should be able to carry it out without making further decisions. Keep it concise, usually in these sections:\\n- Context — why the change is needed and the outcome it should produce.\\n- Approach — the approach you recommend. When the user must choose between genuinely different approaches, describe each briefly and pass them as \`options\`.\\n- Key changes — grouped by behavior or subsystem, not file by file. Name a file only when that makes a change unambiguous; for a change repeated across many files, describe the pattern once and list a few representative paths. Point to existing functions or utilities to reuse, with their paths.\\n- Verification — how to check the result end to end: the tests or commands to run and the scenario to exercise.\\n- Assumptions — each decision you made without the user's input, and the default you chose.\\nAvoid vague filler like \\"improve performance\\" or \\"add tests\\"; say what changes and how you will know it works.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ExitSpecMode", "description": "Use this tool when you are in spec mode and have finished writing the spec documents, and are ready for the user to review them.\\n\\n## How This Tool Works\\n- The requirements, design and tasks documents are read from the spec directory, not passed as parameters.\\n- The user sees all three when they review. In auto permission mode the tool exits spec mode without asking.\\n- All three must be non-empty. A missing or empty document is rejected, naming the file you still have to write.\\n\\n## When to Use\\nUse it only when the spec is genuinely ready to be approved. It does not verify the quality of what you wrote — it checks that the three documents exist and hands them to the user.\\n\\n## What a good spec contains\\n- **Requirements**: the goal, who it is for, the boundaries, and what is explicitly out of scope. A requirement the user did not imply is a defect.\\n- **Design**: the concrete approach — real files, functions and contracts — plus the trade-offs you rejected and why.\\n- **Tasks**: work split small enough to finish and to check, each with acceptance criteria. \\"Handles errors\\" is not a criterion; \\"returns 409 when the email already exists\\" is.\\n\\n## Multiple Approaches\\nIf the design document leaves a genuine choice between approaches, pass them via the \`options\` parameter so the user can pick which one to execute. Each option must correspond to an approach the design document actually describes.\\n\\n## After Approval\\nSpec mode ends and normal tool permissions return. Work through the tasks document, and record progress in the spec's progress file as you go. The progress file is a working note for whoever reads the spec next; it is not gated by this tool.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the design document leaves a genuine choice between approaches, list them here so the user can pick which one to execute. Provide up to 3 options; 2-3 distinct approaches work best. Each option must correspond to an approach the design document actually describes. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "FetchURL", "description": "Fetch content from a URL. The content is returned either as the main text extracted from the page, or as the full response body verbatim; a note at the top of the result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.\\n\\nOnly fully-formed public \`http\`/\`https\` URLs are supported; other schemes and private or loopback addresses are not fetched. Very large pages may be truncated or refused. The fetch carries no login or session for the target site, so pages behind authentication (private repositories, internal dashboards) return a login page or an error instead of the real content — if the text you get back looks like a generic landing or sign-in page, treat that as the login wall, not the answer, and reach the content through a credentialed route (an authenticated CLI or MCP tool) instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "url": { "type": "string", "description": "The URL to fetch content from." } }, "required": [ "url" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "GetGoal", "description": "Read the current goal: its objective, completion criterion, status, budgets with what remains of each, and the terminal reason once it has stopped. Returns \`{ \\"goal\\": null }\` when there is no current goal.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Glob", "description": "Find files by glob pattern, sorted by modification time (most recent first).\\n\\nPowered by ripgrep. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. \`**/fixtures/**\`).\\n\\nGood patterns:\\n- \`*.ts\` — recursive from the search root; \`src/*.ts\` — only directly inside \`src/\`\\n- \`src/**/*.ts\` — recursive beneath \`src/\`\\n- \`*.{ts,tsx}\` and \`{src,test}/**/*.ts\` — brace expansion\\n\\nFollow returned continuation offsets with unchanged search arguments. If results are partial, narrow the search and retry.\\n\\nAvoid broad searches in dependency or build-output directories, especially with \`include_ignored\`; prefer a narrow \`path\` or \`pattern\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "head_limit": { "description": "Maximum number of matching paths to return after offset. Defaults to 100. Pass 0 to remove the match-count limit. The character limit still applies: large pages are saved for Read, and a continuation offset is provided when more paths remain. Search time and output capture limits still apply.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of matching paths to skip. Defaults to 0. Each call searches the current filesystem again; changes can shift results between pages.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Grep", "description": "Search file contents using regular expressions (powered by ripgrep).\\n\\nUse Grep to find unknown content or file locations; use Read directly when inspecting a known file's contents. Do not run \`grep\` or \`rg\` via shell: they bypass workspace policy, output limits, and sensitive-file filtering.\\n\\nWrite patterns in ripgrep regex syntax, which differs from POSIX \`grep\` syntax. For example, braces are special, so escape them as \`\\\\{\` to match a literal \`{\`.\\n\\nHidden files are searched by default.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Knowledge", "description": "Use this tool to interact with the local knowledge base — a structured store of coding standards, pitfalls, architecture decisions, and workflow rules for the current project.\\n\\nThe knowledge base is automatically queried before each turn to inject relevant standards. You can also actively search, add, confirm, or reject entries.\\n\\nSub-commands (pass as the \`action\` parameter):\\n- \`search\`: Find entries relevant to a query, file path, or tags\\n- \`add\`: Record a new standard or pitfall discovered during work\\n- \`confirm\`: Upgrade an AI-learned entry to confirmed (confidence → 1.0)\\n- \`reject\`: Remove an incorrect or outdated entry\\n\\nWhen to use:\\n- After discovering a non-obvious constraint or convention: use \`add\`\\n- When the user corrects you and the correction is a reusable rule: use \`add\`\\n- When reviewing existing entries: use \`search\`\\n- To validate or dismiss auto-learned entries: use \`confirm\` or \`reject\`\\n\\nDo NOT use this tool for:\\n- General knowledge or facts (only project-specific standards)\\n- Temporary per-session preferences\\n- Information already in AGENTS.md (avoid duplication)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "action": { "type": "string", "enum": [ "search", "add", "confirm", "reject" ] }, "query": { "type": "string" }, "scope": { "type": "string" }, "tags": { "type": "string" }, "id": { "type": "string" }, "title": { "type": "string" }, "category": { "type": "string", "enum": [ "coding-style", "pitfall", "architecture", "workflow" ] }, "content": { "type": "string" } }, "required": [ "action" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "source": "user", "origin": "initial" }, { "name": "Memory", "description": "Search and manage persistent memory across sessions.\\r\\n\\r\\nMemory files are markdown documents stored under \`~/.kimi-code/memory/\`, organized by scope:\\r\\n- **global** — cross-project knowledge (architecture decisions, coding standards, tool configs)\\r\\n- **project** — project-specific knowledge tied to the current working directory\\r\\n- **session** — session-specific notes and context\\r\\n\\r\\n## Actions\\r\\n\\r\\n### \`search\`\\r\\nFull-text search over all memory entries. Returns matching snippets with scope and relevance score. Requires \`query\`.\\r\\n\`\`\`\\r\\nMemory({ action: \\"search\\", query: \\"authentication pattern\\" })\\r\\n\`\`\`\\r\\n\\r\\n### \`read\`\\r\\nRead a specific memory file by its relative path.\\r\\n\`\`\`\\r\\nMemory({ action: \\"read\\", path: \\"global/auth-pattern.md\\" })\\r\\n\`\`\`\\r\\n\\r\\n### \`write\`\\r\\nCreate or update a memory file. The \`scope\` determines where it lives:\\r\\n- \`global\` — stored at \`~/.kimi-code/memory/global/\`\\r\\n- \`project\` — stored at \`~/.kimi-code/memory/projects/<projectId>/\`\\r\\n- \`session\` — stored at \`~/.kimi-code/memory/sessions/<sessionId>/\`\\r\\n\\r\\n\`\`\`\\r\\nMemory({\\r\\n  action: \\"write\\",\\r\\n  scope: \\"project\\",\\r\\n  path: \\"auth-pattern\\",\\r\\n  content: \\"# Authentication Pattern\\\\n\\\\nUse JWT with refresh tokens...\\"\\r\\n})\\r\\n\`\`\`\\r\\n\\r\\n### \`list\`\\r\\nList all memory files, optionally filtered by scope.\\r\\n\`\`\`\\r\\nMemory({ action: \\"list\\", scope: \\"global\\" })\\r\\n\`\`\`\\r\\n\\r\\n### \`delete\`\\r\\nDelete a memory file by its relative path.\\r\\n\`\`\`\\r\\nMemory({ action: \\"delete\\", path: \\"global/old-note.md\\" })\\r\\n\`\`\`\\r\\n\\r\\n### \`log\`\\r\\nList the memory repository's recent commits, newest first, each with its short\\r\\nsha, date and message. Use it to pick a revision before \`revert\`.\\r\\n\`\`\`\\r\\nMemory({ action: \\"log\\" })\\r\\n\`\`\`\\r\\n\\r\\n### \`revert\`\\r\\nRoll one memory commit back. Takes the full \`sha\` reported by \`log\`; a short sha\\r\\nis rejected. The search index is resynchronised from disk before the call\\r\\nreturns, so a reverted file stops matching immediately.\\r\\n\`\`\`\\r\\nMemory({ action: \\"revert\\", sha: \\"<full sha>\\" })\\r\\n\`\`\`\\r\\n\\r\\n## Scope semantics\\r\\n\\r\\n- \`search\` covers **every** project and session unless \`scope\` is given; pass\\r\\n  \`scope\` to restrict it to the current project, the global scope, or this\\r\\n  session.\\r\\n- \`write\` defaults to \`project\` and never writes outside the scope you name.\\r\\n- \`list\` defaults to everything; with \`scope\` it returns only that scope of the\\r\\n  current project or session.\\r\\n\\r\\n\`project\` scope is keyed by the repository when there is one: the identity comes\\r\\nfrom the \`origin\` remote first, then from the repository root, and only falls\\r\\nback to the working directory path outside git. A repository with an \`origin\`\\r\\nremote keeps the same project bucket after re-cloning, renaming or moving; a\\r\\nrepository without one keeps it when you work from any directory inside it.\\r\\n\\r\\n## Git memory interaction\\r\\n\\r\\nWhen the \`git_memory\` experiment is enabled, \`write\` additionally requires the\\r\\ncontent to cite a real commit: a 7–40 character hex string that \`git cat-file\`\\r\\nresolves in the session working directory or in the memory repository. A write\\r\\nwithout one is rejected. With the experiment on, every write and delete is\\r\\ncommitted to that repository (\`remember:\`, \`update:\`, \`forget:\`), which is what\\r\\n\`log\` lists and \`revert\` rolls back. With the experiment off, no such\\r\\nrequirement applies and nothing is committed.\\r\\n\\r\\n## When to use\\r\\n\\r\\n- **Before starting a task** — search memory for relevant context from past sessions\\r\\n- **After learning something important** — write it to memory for future reference\\r\\n- **When you encounter a pattern or decision** — persist it so future you doesn't rediscover it\\r\\n- **When debugging** — search for similar past issues and their resolutions\\r\\n\\r\\nMemory persists across sessions and projects. Use it to build up institutional knowledge.\\r\\n\\r\\nThe search index is rebuilt from the files on disk at most once every ten minutes, so\\r\\na file edited outside this tool shows up in \`search\` and \`list\` within that window\\r\\nrather than immediately.\\r\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "action": { "type": "string", "enum": [ "search", "read", "write", "list", "delete", "log", "revert" ], "description": "The memory operation to perform. Required." }, "query": { "description": "Search query (for \`search\` action).", "type": "string" }, "path": { "description": "Memory file path (for \`read\`, \`write\`, \`delete\`). Can include or omit \`.md\` extension. For \`read\`/\`delete\`, this is the full relative path (e.g. \`global/auth.md\`). For \`write\`, this is the filename within the chosen scope.", "type": "string" }, "scope": { "description": "Memory scope (for \`search\`, \`write\`, \`list\`). \`search\` defaults to every scope of every project; \`write\` defaults to \`project\`; \`list\` defaults to all scopes.", "type": "string", "enum": [ "global", "project", "session" ] }, "content": { "description": "Markdown content (for \`write\` action).", "type": "string" }, "sha": { "description": "Memory repository commit sha (for \`revert\` action).", "type": "string" } }, "required": [ "action" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "PowerShell", "description": "Execute a Windows PowerShell script natively (PowerShell 7 \`pwsh\` when available, otherwise Windows PowerShell 5.1). The script runs as a direct PowerShell process — it is not routed through bash.\\n\\n**When to use this instead of Bash:**\\n\\n- The task is inherently PowerShell: Windows registry, services, scheduled tasks, winget, WinGet/MSI installs, COM/WinRM, Windows event logs, NTFS ACLs, certificate store.\\n- You need PowerShell cmdlets or .NET types (\`Get-Service\`, \`Get-ItemProperty\`, \`[System.*]\`).\\n- You are on Windows and about to run \`powershell.exe\` / \`pwsh\` from the Bash tool — do not: the bash→native-PowerShell bridge re-encodes output and corrupts non-ASCII text. Use this tool instead; output is always decoded as UTF-8.\\n\\n**When to keep using Bash:** anything with POSIX shell semantics — pipes over coreutils, git, package managers of the project, build/test runners. File reads/edits/searches belong to \`Read\` / \`Edit\` / \`Glob\` / \`Grep\` regardless of platform.\\n\\n**Behavior:**\\n\\n- The script is passed as a single \`-EncodedCommand\` payload, so quoting and encoding are handled for you; write ordinary PowerShell script text. Interactive input is not supported.\\n- The session runs with \`-NoProfile -NonInteractive\`. Output encoding is pinned to UTF-8, so non-ASCII text (including Chinese) comes back clean.\\n- stdout and stderr are combined and returned as a string. The output may be truncated if it is too long. A non-zero exit ends the result with a \`Command failed with exit code: N\` line; a script killed by its timeout or interrupted by the user ends with its own message instead.\\n- Each call runs in a fresh process: variables and location do not persist between calls. To run in a particular directory, pass the \`cwd\` argument.\\n- Foreground calls default to 60s and allow up to 300s; a foreground call that hits its timeout is moved to the background instead of being killed.\\n\\nIf \`run_in_background=true\`, the script will be started as a background task and this tool will return a task ID instead of waiting for completion. When doing that, you must provide a short \`description\`. Background commands default to 600s timeout and \`timeout\` is capped at 86400s; set \`disable_timeout=true\` only when the task should run without a timeout. You will be automatically notified when the task completes. After starting one, default to returning control to the user instead of immediately waiting on it. Use \`TaskOutput\` only for a non-blocking status/output snapshot — do not wait on a task you just launched. Use \`TaskStop\` only if the task must be cancelled. If a human user wants to inspect background tasks themselves, point them to the background-task panel.\\n\\n**Safety:** do not use this tool to escape the working directory, to modify files outside of it unless instructed, or to run commands that require superuser privileges unless explicitly instructed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The PowerShell script to execute." }, "cwd": { "description": "The working directory in which to run the script. When omitted, the script runs in the session's working directory.", "type": "string" }, "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991, "description": "Optional timeout in seconds for the script to execute." }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the script as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the script. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Read", "description": "Read a text file from the active environment's filesystem. Do not fully trust comments and documentation.\\n\\nThe path may be a \`kimi-file://\` attachment reference. Its bytes come from the current session's storage, independently of the workspace environment. Next Read keeps the reference so pagination also works after a fork. For a binary attachment, the error includes a server-local path when available; a converter must be able to access that filesystem. ReadMediaFile accepts the same reference for images and videos.\\n\\nIf the user provides a concrete file path to a text file, call Read directly. Do not \`Glob\`, \`ls\`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle.\\n\\nWhen you need several files, prefer to read them in parallel: emit multiple \`Read\` calls in a single response instead of reading one file per turn.\\n\\n- Relative paths resolve against the working directory; a path outside the working directory must be absolute.\\n- Output is \`<line-number>\\\\t<content>\` per line. A \`<system>\` status block may follow; it is not part of the file.\\n- Results are bounded by \`max_chars\`: 100000 by default, up to 500000, and by about 500000 divided by four estimated tokens.\\n- If the status block reports an incomplete range, continue with its \`Next Read\` arguments exactly. Do not answer from a partial page when the task requires the remaining content.\\n- **Images and videos** (max 100MB) are sent to the model as multimodal media instead of text; this requires a model with the matching vision capability (\`image_in\` / \`video_in\`). \`region\` and \`full_resolution\` apply only to images; \`line_offset\` and \`n_lines\` apply only to text files.\\n- Large images are downsampled by default when automatic compression can safely fit them within model limits, which can blur fine detail (small text, dense UI). Compute absolute coordinates from the original dimensions reported in the \`<system>\` block, never by measuring the displayed copy. When the \`<system>\` tag reports downsampling and you need that detail, call Read again with the \`region\` parameter (original-image pixel coordinates) to view a crop at full fidelity, or set \`full_resolution\` to true when the whole file fits the per-image byte limit. Re-reading the same file without these parameters just reproduces the same downsampled image.\\n- If automatic compression cannot safely produce an image within model limits, the tool returns an error and does not send the original image. Follow the error: use Bash or an available image-processing tool to create a smaller copy, then read that copy. Do not retry the unchanged file.\\n- After a successful \`Edit\`/\`Write\`, do not re-read solely to prove the write landed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a file or a kimi-file:// attachment reference in the current session. Text files are read as text; image and video files are sent to the model as multimodal content (requires a model with the matching vision capability). Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file (for example, -100 reads the last 100 lines).", "type": "integer", "minimum": -9007199254740991, "maximum": 9007199254740991 }, "column_offset": { "description": "Zero-based character offset within the first line of a forward read, excluding its line-number prefix. Uses JavaScript string length in the displayed text. Copy continuation arguments from the previous result to resume a long line.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "n_lines": { "description": "The number of lines to read. Omit to read toward the end of the file. Results are bounded by max_chars, with continuation arguments when the requested range is incomplete.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "region": { "description": "Images only: view just this rectangle of the image (original-image pixel coordinates). Use after a downsampled full view to inspect fine detail — a region within the size limits is delivered at full fidelity.", "type": "object", "properties": { "x": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Left edge of the crop, in original-image pixels." }, "y": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Top edge of the crop, in original-image pixels." }, "width": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop width, in original-image pixels." }, "height": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop height, in original-image pixels." } }, "required": [ "x", "y", "width", "height" ], "additionalProperties": false }, "full_resolution": { "description": "Images only: skip the default downscaling and view at native resolution. Fails with an explicit error when the payload would exceed the per-image byte limit; use region for files that large.", "type": "boolean" }, "max_chars": { "description": "Maximum characters in the returned text, including line numbers and status. Omit for the configured default; requests above the configured maximum are capped.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "run_code", "description": "Run a TypeScript/JavaScript program in an isolated subprocess and return its console output and completion value.\\n\\n- The program body runs as an async function: top-level \`await\` and \`return\` work (e.g. \`return 1 + 2\`, \`await fetch(...).then(r => r.json())\`).\\n- \`console.log\` / \`console.info\` / \`console.warn\` / \`console.error\` / \`console.debug\` output is captured in emission order.\\n- The completion value must be JSON-serializable (objects, arrays, strings, numbers, booleans, null). \`undefined\` (e.g. a bare \`return\`) reports \`value: undefined\`. Functions, classes, and circular structures fail with an \`invalid-output\` error.\\n- No state survives between calls — each run spawns a fresh subprocess.\\n- The subprocess runs under a memory cap; a program that exceeds it fails with a \`memory-limit\` error and cannot take the host down with it.\\n- The subprocess is a soft isolation boundary, NOT a security sandbox: treat model-written code with the same trust level as a Bash command.\\n- Prefer this tool over Bash for pure computation, data transformation, algorithm verification, parsing, and small scripting tasks that do not need shell features.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "code": { "type": "string", "minLength": 1, "description": "The TypeScript/JavaScript program to run. The body executes as an async function, so top-level await and return work. console.log/info/warn/error/debug output is captured." }, "timeout_ms": { "default": 30000, "description": "Execution budget in milliseconds before the worker is terminated (default 30000).", "type": "integer", "minimum": 1000, "maximum": 120000 } }, "required": [ "code" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "select_tools", "description": "Load tools by exact name, or search for them by capability when the name is unknown. The loadable names are listed in the <tools_added>/<tools_removed> or <tools_relevant> announcements in the system context — use the latest announcement. If you have not seen a loadable-tools announcement in this session, no tools are currently loadable. Pass names to load them, or pass query to search all loadable tools; a search returns candidates only, so call select_tools again with exact names to load the ones you need. The full definitions become available immediately, so you can call them directly in your next tool call. Tools you already have available are called directly, never passed to select_tools.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "names": { "description": "Exact tool names to load, taken from the latest announcement or a prior search result.", "minItems": 1, "type": "array", "items": { "type": "string" } }, "query": { "description": "Capability description to search for when the exact tool name is unknown; returns candidates without loading them.", "type": "string", "minLength": 1 } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "session_query", "description": "Search prior session history: cross-session full-text search over your own workspace's sessions, within-session event search, and fork-lineage tracing.\\n\\nOperations:\\n- \`session_search\`: full-text search across the workspace's sessions. The \`query\` is a literal phrase; results rank sessions by the strongest matching event and include a bounded snippet. Optional filters narrow the corpus: \`session_ids\`, \`created_at_from\`/\`created_at_to\` (inclusive ISO 8601), \`parent_session_ids\`, \`include_root_sessions\`, \`availability\` (\`live\`/\`persisted\`), and event bounds \`event_seq_from\`/\`event_seq_to\`/\`event_time_from\`/\`event_time_to\`/\`event_types\`.\\n- \`event_search\`: full-text search within one session's events (omit \`session_id\` for the current session). Same query semantics; optional \`seq_from\`/\`seq_to\`/\`time_from\`/\`time_to\`/\`event_types\` bounds.\\n- \`session_trace\`: fork lineage of one session (omit \`session_id\` for the current session) — the ancestor chain and descendant trees.\\n\\nQueries are interpreted as data, never as query syntax. Results are capped at 20 entries; narrow the query or add filters to find more.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "operation": { "type": "string", "enum": [ "session_search", "event_search", "session_trace" ], "description": "Which session-query operation to run: session_search (cross-session full-text search), event_search (within-session event search), or session_trace (fork lineage of one session)." }, "operationArgs": { "description": "Operation-specific arguments (validated per operation).", "type": "object", "propertyNames": { "type": "string" }, "additionalProperties": {} } }, "required": [ "operation" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "SetGoalBudget", "description": "Set a hard budget for the current goal, only when the user clearly states one, such as \\"stop after 20 turns\\", \\"use no more than 500k tokens\\", or \\"finish within 30 minutes\\". Do not invent limits, and do not set one for vague wording such as \\"spend some time\\" or \\"try to be quick\\". Convert a compound time to one unit first: \\"2 hours and 3 minutes\\" → \`value: 123, unit: \\"minutes\\"\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] } }, "required": [ "value", "unit" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Skill", "description": "Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<skill-loaded>\` block for it with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "type": "string", "description": "The exact name of the skill to invoke, copied verbatim from the current skill listing." }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "required": [ "skill" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "SnapshotList", "description": "List the versions this session recorded for a file before it was overwritten.\\n\\nWrite and Edit keep a record of the content they replace. This tool reads that record for one path and answers who replaced it, when, and in which session or subagent: each line carries the time, the tool that wrote, the size, a short content hash, and the agent that did it. Versions come newest first; index 1 is the most recent overwrite.\\n\\nIt never returns the recorded content. To put a version back, the user runs \`kimi snapshot restore <path> --previous\` (or \`--hash <sha|id>\` for a specific one).\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "minLength": 1, "description": "File path whose recorded versions to list, as written in the tool call or absolute. The newest version comes first." } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskList", "description": "List background tasks and their current status, including task IDs for \`TaskOutput\`.\\n\\nAfter context compaction, or whenever unsure which tasks are running, call TaskList instead of guessing IDs. With \`active_only=false\`, \`lost\` tasks from previous processes may appear; treat them as terminated.\\n\\nThis tool is read-only and safe in plan mode; it does not return task output.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskOutput", "description": "Retrieve a non-blocking snapshot of a running or completed background task.\\n\\nUse after \`Bash(run_in_background=true)\`, \`Agent(run_in_background=true)\`, or \`AskUserQuestion(background=true)\` to check progress or read completed output. Prefer automatic completion notifications over polling. If your next step depends on task completion, run the task in the foreground instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskStop", "description": "Stop a running background task.\\n\\nOnly use this when a task must genuinely be cancelled — for a task that is\\nfinishing normally, wait for its completion notification or inspect it with\\n\`TaskOutput\` instead of stopping it.\\n\\nGuidelines:\\n- This is a general-purpose stop capability for any background task. It is not\\n  a bash-specific kill.\\n- Stopping a task is destructive: it may leave partial side effects behind.\\n  Use it with care.\\n- If the task has already finished, this tool simply returns its current\\n  status.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TodoList", "description": "Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. The list is shown to the user as a live progress panel, so keep it in step with what you have actually done. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.\\n\\n**When to use:**\\n- Multi-step tasks that span several tool calls\\n- Tracking investigation progress across a large codebase search\\n- Planning a sequence of edits before making them\\n- After receiving new multi-step instructions, capture the requirements as todos\\n\\n**When NOT to use:**\\n- Single-shot answers that complete in one or two tool calls\\n- Trivial requests where tracking adds no clarity\\n- Purely conversational or informational replies\\n\\n**Keeping it current:**\\n- Before you start a tracked task, mark it \`in_progress\`; while work is underway, keep exactly one task \`in_progress\`.\\n- As soon as a task is finished, mark it \`done\`, before you start the next one. Do not batch completions at the end.\\n- Before you write your final message, make sure the list matches what you actually did.\\n- An update can go in the same response as your next tool call; it does not need a step of its own.\\n- Do not re-send an unchanged list. If you are stuck and no available tool can move any task forward, tell the user instead of re-ordering the same todos.\\n\\n**How to use:**\\n- Call with \`todos: [...]\` to replace the full list. Statuses: pending / in_progress / done.\\n- Call with no \`todos\` argument to retrieve the current list without changing it.\\n- Call with \`todos: []\` to clear the list.\\n- Keep titles short and actionable (e.g. \\"Read session-control.ts\\", \\"Add planMode flag to TurnManager\\").\\n- Never mark a task \`done\` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.\\n- If you encounter a blocker, keep the blocked task \`in_progress\` or add a new pending task describing what must be resolved.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "id": { "description": "Stable identifier of the item, as returned by a previous call. Reuse it so an update lands on the same item instead of creating a new one. Omit on first write; missing ids are assigned as T1, T1.1, and so on.", "type": "string" }, "parentId": { "description": "Id of the milestone this item belongs to. Null or omitted for milestones and for a flat list.", "anyOf": [ { "type": "string" }, { "type": "null" } ] }, "kind": { "description": "Milestone groups leaf tasks; task is a leaf unit of work. Defaults to task.", "type": "string", "enum": [ "milestone", "task" ] }, "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." }, "progress": { "description": "Completion percentage 0-100 of an in_progress leaf task. Omit on milestones (computed from children) and on done items (implies 100).", "type": "number", "minimum": 0, "maximum": 100 }, "description": { "description": "Optional longer note about the item.", "type": "string" } }, "required": [ "title", "status" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "UpdateGoal", "description": "Set the status of the current goal. \`active\` resumes a paused or blocked goal when the user explicitly asks you to work on it again. \`complete\` and \`blocked\` end autonomous work: while a goal is active, its full reminder states exactly when each one is warranted; later reminders keep the current goal state and point back to those rules. Follow them, and do not call this tool merely because you finished a slice of work. After \`complete\` or \`blocked\`, write the completion summary or the blocker explanation in your next message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." } }, "required": [ "status" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "WaitFor", "description": "Wait for background tasks to finish without ending the current turn.\\n\\nOnly call this tool when you really have no other work to do and your next step cannot proceed without the result of a running background task (a sub-agent, a background bash command, or a background AskUserQuestion). The call suspends inside the current turn until the task finishes or the timeout elapses, then returns the outcome so you can keep working in the same turn. While waiting, no LLM requests are made, but the user is kept waiting too.\\n\\nWhen background tasks finish, they notify you automatically, so you do not need to busily wait for them.\\n\\nGuidelines:\\n\\n- Before calling WaitFor, think about what else you can do meanwhile: another part of the task, verifying earlier work, or ending your turn with a progress update. If there is anything, do that instead.\\n- Do not call WaitFor right after dispatching work whose result you do not need yet.\\n- After a timeout, prefer moving on to other work over calling WaitFor again; repeated waits keep the user waiting.\\n- Without \`task_id\`, tasks started during the wait are not covered by it; their completion arrives via the usual automatic notification.\\n- With \`task_id\`, the wait ends when that task finishes. An unknown \`task_id\` is an error; a task that has already finished returns immediately.\\n- When no background tasks are running, WaitFor returns immediately without waiting.\\n- Waiting has no side effects on the waited tasks: WaitFor never stops a task, and interrupting the wait (for example, a new user message) leaves every task running.\\n- A finished task's result is delivered exactly once: tasks reported by WaitFor do not also produce an automatic completion notification.\\n- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 90, "description": "Maximum time to wait, in seconds (1-90). Pick it from how long you expect the task to take, not the maximum. A timeout is not an error: the tool returns the tasks that are still running." }, "task_id": { "description": "The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.", "type": "string" } }, "required": [ "timeout" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "WebSearch", "description": "Search the web for information. Use this when you need up-to-date information from the internet.\\n\\nEach result includes its title, its URL, and a snippet, plus its source site and publication date when available. Results are short summaries, not full pages — when a result looks relevant, call the FetchURL tool on its URL to read the full page content. Fetch only the few URLs you actually need. Prefer specific queries, and refine the query if the results don't contain what you need.\\n\\nWhen you rely on a result in your answer, cite its source URL so the user can verify it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "query": { "type": "string", "description": "The query text to search for." } }, "required": [ "query" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Workflow", "description": "Run multi-phase orchestrated agent workflows.\\n\\n## Operations\\n\\n### \`run\` — start a workflow\\nLaunches a workflow in the background. Returns immediately with a \`run_id\`; the result is delivered as a notification when the workflow completes.\\n\\n\`\`\`\\nWorkflow({ operation: \\"run\\", name: \\"deep-research\\", args: \\"How does RAG compare to fine-tuning?\\" })\\n\`\`\`\\n\\nYou can also run an inline script:\\n\`\`\`\\nWorkflow({ operation: \\"run\\", script: \\"export const meta = { name: 'quick', description: '...' };\\\\nphase('search');\\\\nconst result = await agent('Search for...');\\\\nreturn result;\\", args: \\"...\\" })\\n\`\`\`\\n\\nThe script runs under a 30-minute default deadline, counted from launch and covering the whole script, not just its synchronous start. Pass \`deadline_ms\` to raise or lower it for a single run — a long workflow that intentionally runs for hours must ask for the time it needs:\\n\`\`\`\\nWorkflow({ operation: \\"run\\", name: \\"deep-research\\", args: \\"...\\", deadline_ms: 7200000 })\\n\`\`\`\\nA script that exceeds the deadline is aborted: the run ends as \`failed\` with \`Workflow script deadline exceeded\`, and any subagent it started is cancelled. The same applies to a script stuck in a tight synchronous loop with no \`await\`: that kind of loop blocks the process it runs in, so it is cut off at 30 seconds and the run fails.\\n\\n### \`status\` — check progress\\n\`\`\`\\nWorkflow({ operation: \\"status\\", run_id: \\"wf_1\\" })\\n\`\`\`\\n\\n### \`wait\` — block until done\\n\`\`\`\\nWorkflow({ operation: \\"wait\\", run_id: \\"wf_1\\", timeout_ms: 60000 })\\n\`\`\`\\n\\n### \`cancel\` — cancel a running workflow\\n\`\`\`\\nWorkflow({ operation: \\"cancel\\", run_id: \\"wf_1\\" })\\n\`\`\`\\n\\n## Built-in workflows\\n\\n- **deep-research** — Multi-source research with adversarial jury fact-checking. Plans search lines, runs parallel web searches, extracts facts from top sources, cross-checks each fact with 3 jurors (majority reject drops it), and writes a cited report.\\n- **code-review** — Multi-dimensional code review across security, performance, correctness, and maintainability. Runs parallel reviewers and produces a consolidated severity-ranked report.\\n- **test-generator** — Automated test generation. Analyzes source code, plans test cases, generates test files with proper mocks, and validates output.\\n- **refactor-planner** — Refactoring impact analysis and migration planner. Identifies improvement opportunities, assesses risk, and generates a phased plan with rollback steps.\\n- **bug-triage** — Automated bug triage. Parses error logs and stack traces, reads suspect source files, identifies root causes, and generates fixes with reproduction steps.\\n- **pr-description** — PR description generator. Analyzes code diffs, extracts semantic intent, and generates a comprehensive PR body with changelog entries and reviewer guidance.\\n- **architecture-review** — Architecture and dependency analysis. Detects circular dependencies, measures coupling, identifies layer violations, and generates architecture documentation.\\n- **security-audit** — Security vulnerability audit. Scans for OWASP Top 10, hardcoded secrets, injection points, auth flaws, and produces a prioritized remediation plan.\\n- **migration-planner** — Migration and upgrade planner. Analyzes dependency versions, identifies breaking changes, maps code changes, and generates a phased migration plan with compatibility shims.\\n\\n## In-script primitives\\n\\nWorkflow scripts are JavaScript that runs in a sandbox with these injected globals:\\n\\n- **\`agent(prompt, opts?)\`** — Spawn a subagent. Returns the agent's result (parsed JSON if \`opts.schema\` given, else text) or \`null\` on failure. **Never throws.**\\n  - \`opts.agentType\` — subagent profile (default 'coder')\\n  - \`opts.schema\` — JSON schema for structured output\\n  - \`opts.label\` — display label\\n\\n- **\`parallel(thunks)\`** — Run thunks concurrently. Returns array of results.\\n\\n- **\`pipeline(items, ...stages)\`** — Run each item through all stages. No barrier between stages — items flow through independently.\\n\\n- **\`phase(title)\`** — Set the current phase (for progress tracking).\\n\\n- **\`log(message)\`** — Log a message.\\n\\n- **\`readFile(path)\` / \`writeFile(path, content)\` / \`glob(pattern)\` / \`exists(path)\`** — File IO jailed to the workspace root.\\n\\n- **\`args\`** — The \`args\` value passed to \`run\`.\\n\\n- **\`fetch(url, opts?)\`** — Make an HTTP request. Returns \`{ ok, status, body }\`. \`opts\` can have \`method\`, \`headers\`, \`body\`. 15s timeout. Never throws — failures return \`{ ok: false, status: 0, body: errorMessage }\`.\\n\\n- **\`search(query)\`** — Web search. Returns an array of \`{ title, url, snippet }\`. Returns empty array when search is unavailable or fails. Never throws.\\n\\n- **\`exec(command, opts?)\`** — Execute a shell command. Returns \`{ stdout, stderr, exitCode }\`. \`opts\` can have \`timeoutMs\` (default 30s) and \`cwd\` (relative to workspace root). The command runs in the workspace directory. Never throws — non-zero exit codes are returned, not thrown.\\n\\n## When to use\\n\\n- **Deep research** — when the user wants a thorough, multi-source, fact-checked answer\\n- **Code review** — when the user wants a multi-dimensional review of code changes\\n- **Test generation** — when the user wants to add tests for existing untested code\\n- **Refactoring** — when the user wants to plan safe, incremental code improvements\\n- **Bug triage** — when the user reports an error, crash, or test failure\\n- **PR descriptions** — when the user needs to document code changes for a pull request\\n- **Architecture review** — when evaluating system design or detecting design decay\\n- **Security audit** — when auditing code for OWASP Top 10 vulnerabilities\\n- **Migration planning** — when upgrading dependencies or migrating between frameworks\\n- **Complex orchestration** — when a task requires multiple phases of parallel agent work\\n- **Structured pipelines** — when you need to chain agent outputs through transformation stages\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "operation": { "type": "string", "enum": [ "run", "status", "wait", "cancel" ], "description": "The workflow operation to perform." }, "name": { "description": "Built-in or user workflow name (for \`run\`). Mutually exclusive with \`script\`.", "type": "string" }, "script": { "description": "Inline workflow script (for \`run\`). Mutually exclusive with \`name\`.", "type": "string" }, "args": { "description": "Arguments to pass to the workflow (for \`run\`).", "type": "string" }, "run_id": { "description": "Workflow run ID (for \`status\`, \`wait\`, \`cancel\`).", "type": "string" }, "timeout_ms": { "description": "Timeout in milliseconds (for \`wait\`).", "type": "number" }, "deadline_ms": { "description": "Total runtime limit in milliseconds for the script (for \`run\`). Defaults to 1800000 (30 minutes).", "type": "number" } }, "required": [ "operation" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Write", "description": "Create, append to, or replace a file entirely.\\n\\n- Use Write only for new files, complete replacements, or content with little continuity.\\n- Do not create unsolicited documentation files (\`*.md\` write-ups, \`README\`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).\\n- Read before overwriting an existing file.\\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\\n- Write outputs content literally, including supplied line endings: \\\\n stays LF, \\\\r\\\\n stays CRLF.\\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" } ], "time": "<time>" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 2, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nNo tools are currently available for dynamic loading in this session. Do not call select_tools or guess tool names; use the tools you already have. Only a later <tools_added> announcement can make new tools loadable.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "loadable-tools", "disclosure": { "kind": "snapshot", "revision": 0, "tools": [] } } } ] }
        [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nNo tools are currently available for dynamic loading in this session. Do not call select_tools or guess tool names; use the tools you already have. Only a later <tools_added> announcement can make new tools loadable.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "loadable-tools", "disclosure": { "kind": "snapshot", "revision": 0, "tools": [] } } }, "time": "<time>" }
        [wire] plugin.session_start        { "agentId": "main", "content": null, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
        [wire] llm.tools_snapshot          { "agentId": "main", "hash": "<tools-hash>", "tools": [ "Agent", "AgentSwarm", "AskUserQuestion", "Bash", "CreateGoal", "CronCreate", "CronDelete", "CronList", "Edit", "EnterSpecMode", "ExitPlanMode", "ExitSpecMode", "FetchURL", "GetGoal", "Glob", "Grep", "Knowledge", "Lookup", "Memory", "Read", "run_code", "session_query", "SetGoalBudget", "Skill", "SnapshotList", "TaskList", "TaskOutput", "TaskStop", "TodoList", "UpdateGoal", "WaitFor", "WebSearch", "Workflow", "Write" ], "time": "<time>" }
        [wire] llm.request                 { "agentId": "main", "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "<tools-hash>", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "I will look it up." }
        [emit] tool.call.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
        [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 118, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 118, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 118, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 118, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured     { "agentId": "main", "length": 4, "tokens": 134, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 134 }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will look it up." } }, "time": "<time>" }
        [emit] tool.call.started           { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
        [emit] toolCall                    { "turnId": 0, "toolCallId": "call_lookup", "args": { "query": "moon" } }"
      `);
      expect(renderSnapshot(ctx.lastLlmInput())).toMatchInlineSnapshot(`
        "system: <system-prompt>
        tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, CronCreate, CronDelete, CronList, Edit, EnterSpecMode, ExitPlanMode, ExitSpecMode, FetchURL, GetGoal, Glob, Grep, Knowledge, Lookup, Memory, Read, run_code, session_query, SetGoalBudget, Skill, SnapshotList, TaskList, TaskOutput, TaskStop, TodoList, UpdateGoal, WaitFor, WebSearch, Workflow, Write
        messages:
          user: text "Look up moon"
          user: text <auto-mode-enter-reminder>"
      `);

      ctx.mockNextResponse({ type: 'text', text: 'The lookup result is moon-result.' });
      expect(renderSnapshot(await ctx.untilTurnEnd())).toMatchInlineSnapshot(`
        "[wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.call", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }, "time": "<time>" }
        [wire] interaction.request         { "agentId": "main", "id": "<user_tool-1>", "kind": "user_tool", "toolCallId": "call_lookup", "request": { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }, "time": "<time>" }
        [wire] interaction.resolved        { "agentId": "main", "id": "<user_tool-1>", "response": { "content": "moon-result", "output": "moon-result" }, "time": "<time>" }
        [emit] tool.result                 { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "output": "moon-result" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.result", "parentUuid": "<uuid-3>", "toolCallId": "call_lookup", "result": { "output": "moon-result" } }, "time": "<time>" }
        [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 118, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "cache": { "modelAlias": "mock-model", "protocol": "openai", "providerType": "kimi", "messageCount": 2, "historyHash": "<fingerprint>", "thinkingEffort": "off", "inputTokens": 118, "cacheRead": 0, "cacheCreation": 0, "outputTokens": 16 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 118, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-4>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-4>", "turnId": "0", "step": 2 }, "time": "<time>" }
        [wire] llm.request                 { "agentId": "main", "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "<tools-hash>", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "The lookup result is moon-result." }
        [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 138, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 256, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 256, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 256, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured     { "agentId": "main", "length": 6, "tokens": 150, "time": "<time>" }
        [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 150 }
        [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-4>", "usage": { "inputOther": 138, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "cache": { "modelAlias": "mock-model", "protocol": "openai", "providerType": "kimi", "messageCount": 4, "historyHash": "<fingerprint>", "thinkingEffort": "off", "inputTokens": 138, "cacheRead": 0, "cacheCreation": 0, "outputTokens": 12 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "stepUuid": "<uuid-4>", "part": { "type": "text", "text": "The lookup result is moon-result." } }, "time": "<time>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 138, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [wire] agent.message.appended      { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [ { "type": "function", "id": "call_lookup", "name": "Lookup", "arguments": "{\\"query\\":\\"moon\\"}" } ] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 118, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "messageId": "mock-1" } }, "time": "<time>", "kind": "event" }
        [wire] agent.message.appended      { "message": { "message": { "role": "tool", "content": [ { "type": "text", "text": "moon-result" } ], "toolCallId": "call_lookup" }, "meta": { "source": "tool" } }, "time": "<time>", "kind": "event" }
        [wire] agent.message.appended      { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "The lookup result is moon-result." } ], "toolCalls": [] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 138, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "completed", "rawFinishReason": "stop" }, "messageId": "mock-2" } }, "time": "<time>", "kind": "event" }
        [wire] agent.turn.ended            { "turnId": 0, "outcome": "done", "time": "<time>", "kind": "event" }
        [wire] turn.ended                  { "agentId": "main", "turnId": 0, "reason": "completed", "time": "<time>" }
        [emit] turn.ended                  { "time": "<time>", "agentId": "main", "turnId": 0, "reason": "completed" }"
      `);
      expect(renderSnapshot(ctx.lastLlmInput())).toMatchInlineSnapshot(`
        "messages:
          <last>
          assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "moon" }
          tool[call_lookup]: text "moon-result""
      `);
      await ctx.rpc.unregisterTool({ name: 'Lookup' });
      ctx.mockNextResponse({ type: 'text', text: 'No lookup tool is available.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Can you still use Lookup?' }] });

      expect(renderSnapshot(await ctx.untilTurnEnd())).toMatchInlineSnapshot(`
        "[wire] token_counting.turn_recorded   { "agentId": "main", "turnId": 0, "length": 6, "tokens": 150, "time": "<time>" }
        [emit] agent.status.updated           { "time": "<time>", "agentId": "main", "contextTokens": 150 }
        [wire] tools.unregister_user_tool     { "agentId": "main", "name": "Lookup", "time": "<time>" }
        [wire] prompt.completed               { "agentId": "main", "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed", "time": "<time>" }
        [emit] prompt.completed               { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed" }
        [emit] prompt.submitted               { "time": "<time>", "agentId": "main", "promptId": "<msg-2>", "userMessageId": "<msg-2>", "status": "running", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "createdAt": "<time>" }
        [wire] turn.prompt                    { "agentId": "main", "input": [ { "type": "text", "text": "Can you still use Lookup?" } ], "origin": { "kind": "user" }, "promptId": "<msg-2>", "turnId": 1, "time": "<time>" }
        [emit] turn.prompt                    { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Can you still use Lookup?" } ], "origin": { "kind": "user" }, "promptId": "<msg-2>", "turnId": 1 }
        [emit] turn.started                   { "time": "<time>", "agentId": "main", "turnId": 1, "promptId": "<msg-2>", "origin": { "kind": "user" }, "prompt": "Can you still use Lookup?" }
        [emit] context.spliced                { "time": "<time>", "agentId": "main", "start": 6, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "id": "<msg-2>", "toolCalls": [], "origin": { "kind": "user" } } ] }
        [emit] prompt.started                 { "time": "<time>", "agentId": "main", "promptId": "<msg-2>" }
        [wire] context.append_message         { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "id": "<msg-2>", "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
        [wire] agent.message.appended         { "message": { "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ] }, "meta": { "source": "input", "promptId": "<msg-2>", "origin": { "kind": "user" }, "tracked": true, "createdAt": "<time>", "userMessageId": "<msg-2>" } }, "time": "<time>", "kind": "event" }
        [wire] agent.turn.started             { "turnId": 1, "queueItemId": "<msg-2>", "time": "<time>", "kind": "event" }
        [wire] tool_select.tools_changed      { "agentId": "main", "added": [], "removed": [ { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "source": "user", "origin": "initial" } ], "time": "<time>" }
        [emit] context.spliced                { "time": "<time>", "agentId": "main", "start": 7, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\n<tools_removed>\\nLookup\\n</tools_removed>\\n\\nNo tools are currently available for dynamic loading in this session. Do not call select_tools or guess tool names; use the tools you already have. Only a later <tools_added> announcement can make new tools loadable.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "loadable-tools", "disclosure": { "kind": "delta", "revision": 1, "added": [], "removed": [ { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "source": "user", "origin": "initial" } ] } } } ] }
        [wire] context.append_message         { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\n<tools_removed>\\nLookup\\n</tools_removed>\\n\\nNo tools are currently available for dynamic loading in this session. Do not call select_tools or guess tool names; use the tools you already have. Only a later <tools_added> announcement can make new tools loadable.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "loadable-tools", "disclosure": { "kind": "delta", "revision": 1, "added": [], "removed": [ { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "source": "user", "origin": "initial" } ] } } }, "time": "<time>" }
        [emit] turn.step.started              { "time": "<time>", "agentId": "main", "turnId": 1, "step": 1, "stepId": "<uuid-6>" }
        [wire] context.append_loop_event      { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-6>", "turnId": "1", "step": 1 }, "time": "<time>" }
        [wire] llm.request                    { "agentId": "main", "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "<tools-hash>", "messageCount": 7, "turnStep": "1.1", "time": "<time>" }
        [emit] assistant.delta                { "time": "<time>", "agentId": "main", "turnId": 1, "delta": "No lookup tool is available." }
        [wire] usage.record                   { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 242, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated           { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 498, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 498, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 242, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] token_counting.measured        { "agentId": "main", "length": 9, "tokens": 252, "time": "<time>" }
        [emit] agent.status.updated           { "time": "<time>", "agentId": "main", "contextTokens": 252 }
        [emit] turn.step.completed            { "time": "<time>", "agentId": "main", "turnId": 1, "step": 1, "stepId": "<uuid-6>", "usage": { "inputOther": 242, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "cache": { "modelAlias": "mock-model", "protocol": "openai", "providerType": "kimi", "messageCount": 7, "historyHash": "<fingerprint>", "thinkingEffort": "off", "inputTokens": 242, "cacheRead": 0, "cacheCreation": 0, "outputTokens": 10 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [wire] context.append_loop_event      { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-7>", "turnId": "1", "step": 1, "stepUuid": "<uuid-6>", "part": { "type": "text", "text": "No lookup tool is available." } }, "time": "<time>" }
        [wire] context.append_loop_event      { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-6>", "turnId": "1", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 242, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-3", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [wire] agent.message.appended         { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "No lookup tool is available." } ], "toolCalls": [] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 242, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "completed", "rawFinishReason": "stop" }, "messageId": "mock-3" } }, "time": "<time>", "kind": "event" }
        [wire] agent.turn.ended               { "turnId": 1, "outcome": "done", "time": "<time>", "kind": "event" }
        [wire] turn.ended                     { "agentId": "main", "turnId": 1, "reason": "completed", "time": "<time>" }
        [emit] turn.ended                     { "time": "<time>", "agentId": "main", "turnId": 1, "reason": "completed" }"
      `);
      expect(renderSnapshot(ctx.lastLlmInput())).toMatchInlineSnapshot(`
        "messages:
          <last>
          assistant: text "The lookup result is moon-result."
          user: text "Can you still use Lookup?"
          user: text "<system-reminder>\\n<tools_removed>\\nLookup\\n</tools_removed>\\n\\nThe available tools changed during this session. The current model cannot load runtime tool additions with select_tools. Do not call select_tools. Use the tool definitions provided in this request. Removed tools may be unavailable or fail when called.\\n</system-reminder>""
      `);
    });

    it('persists oversized registered user tool results before adding them to context', async () => {
      await ctx.dispose();
      const homeDir = mkdtempSync(join(tmpdir(), 'tool-result-truncation-'));
      tempHomeDirs.push(homeDir);
      ctx = createTestAgent(homeDirServices(homeDir));
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.rpc.registerTool({
        name: 'Lookup',
        description: 'Look up a long test value.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      });

      const fullOutput =
        `${'x'.repeat(99)}\n`.repeat(500) +
        'middle elided from preview\n' +
        `${'x'.repeat(99)}\n`.repeat(10);
      ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
      await ctx.untilToolCall({
        content: fullOutput,
        output: fullOutput,
      });
      ctx.mockNextResponse({ type: 'text', text: 'The lookup output was saved.' });
      await ctx.untilTurnEnd();

      const toolMessage = ctx.compactHistory().find((message) => message.role === 'tool')?.text;
      expect(toolMessage).toContain('Tool output exceeded 50000 characters');
      expect(toolMessage).toContain('tool_name: Lookup');
      expect(toolMessage).toContain('tool_call_id: call_lookup');
      expect(toolMessage).not.toContain('middle elided from preview');

      const outputPath = renderedOutputPath(toolMessage);
      expect(outputPath).toContain(
        join(
          homeDir,
          'sessions/test-workspace/test-session/agents/main/tool-results/Lookup-call_lookup-',
        )
          .split(sep)
          .join('/'),
      );
      expect(readFileSync(outputPath, 'utf8')).toBe(fullOutput);
    });
  });
});

function renderedOutputPath(output: string | undefined): string {
  if (output === undefined) throw new Error('expected tool output');
  const match = /^output_path: (.+)$/m.exec(output);
  if (match === null) throw new Error('expected tool output to include output_path');
  return match[1]!;
}

function bashCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: '{"command":"printf hook-output","timeout":60}',
  };
}

function createFailingCommandRunner(stdout: string): IHostProcessService {
  function createProcess(): IHostProcess {
    return {
      _serviceBrand: undefined,
      stdin: { write: mock(), end: mock() } as unknown as Writable,
      stdout: Readable.from([stdout]),
      stderr: Readable.from(['']),
      pid: 42,
      exitCode: 2,
      wait: mock().mockResolvedValue(2) as IHostProcess['wait'],
      kill: mock().mockResolvedValue(undefined) as IHostProcess['kill'],
      dispose: mock().mockResolvedValue(undefined) as IHostProcess['dispose'],
    };
  }
  return createFakeProcessRunner({
    spawn: mock().mockImplementation(async () => createProcess()),
  });
}

function agentCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_agent',
    name: 'Agent',
    arguments: JSON.stringify({
      prompt: 'Investigate deeply',
      description: 'Investigate deeply',
      subagent_type: 'coder',
    }),
  };
}

function hookErrorMessageAssertCommand(expected: string): string {
  const script = [
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  const payload = JSON.parse(input);',
    `  if (payload.error?.message === ${JSON.stringify(expected)}) process.exit(0);`,
    "  console.error(payload.error?.message ?? '<missing>');",
    '  process.exit(2);',
    '});',
  ].join('');
  return `node -e ${JSON.stringify(script)}`;
}

function hookPayloadAssertCommand(expected: {
  readonly event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';
  readonly toolName: string;
  readonly toolCallId: string;
  readonly toolInputCommand: string;
  readonly toolOutput?: string;
  readonly errorMessageIncludes?: string;
}): string {
  const script = [
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  const payload = JSON.parse(input);',
    `  if (payload.hook_event_name !== ${JSON.stringify(expected.event)}) throw new Error('bad event: ' + payload.hook_event_name);`,
    `  if (payload.tool_name !== ${JSON.stringify(expected.toolName)}) throw new Error('bad tool_name: ' + payload.tool_name);`,
    `  if (payload.tool_call_id !== ${JSON.stringify(expected.toolCallId)}) throw new Error('bad tool_call_id: ' + payload.tool_call_id);`,
    `  if (payload.tool_input?.command !== ${JSON.stringify(expected.toolInputCommand)}) throw new Error('bad command: ' + payload.tool_input?.command);`,
    expected.toolOutput === undefined
      ? ''
      : `  if (payload.tool_output !== ${JSON.stringify(expected.toolOutput)}) throw new Error('bad tool_output: ' + payload.tool_output);`,
    expected.toolOutput === undefined
      ? ''
      : "  if (payload.error !== undefined) throw new Error('unexpected error payload');",
    expected.errorMessageIncludes === undefined
      ? ''
      : `  if (typeof payload.error?.message !== 'string' || !payload.error.message.includes(${JSON.stringify(expected.errorMessageIncludes)})) throw new Error('bad error: ' + payload.error?.message);`,
    expected.errorMessageIncludes === undefined
      ? ''
      : "  if (payload.tool_output !== undefined) throw new Error('unexpected tool_output: ' + payload.tool_output);",
    '  process.exit(0);',
    '});',
    "process.on('uncaughtException', (error) => { console.error(error.message); process.exit(2); });",
  ]
    .filter((line) => line.length > 0)
    .join('');
  return `node -e ${JSON.stringify(script)}`;
}
