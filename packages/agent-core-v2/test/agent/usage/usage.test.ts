import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { SILENT_TEST_LOGGER, TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { CompactionCompleted } from '#/agent/fullCompaction/compactionOps';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { AgentCacheBreakService } from '#/agent/usage/cacheBreakService';
import type { CacheObservation } from '#/agent/usage/cacheObservation';
import { AgentCacheProbeService } from '#/agent/usage/cacheProbeService';
import { type UsageRecordedContext, type UsageStatus } from '#/agent/usage/usage';
import type { Event2 } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import { EventBusService } from '#/app/event/eventBusService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { TokenUsage } from '#human/llm/usage';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { SessionUsageService } from '#/session/usage/sessionUsageService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'usage-test';

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let dispatcher: IEventDispatcher;
let svc: ISessionUsageService;
let agent: AgentContext;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAgentStateService, new AgentStateService());
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(ISessionUsageService, new SyncDescriptor(SessionUsageService));
  log = ix.get(IAppendLogStore);
  registerTestAgentWire(ix, testWireScope(SCOPE, KEY), {
    log,
    eventBus: ix.get(IEventBus),
  });
  dispatcher = registerTestEventDispatcher(ix);
  svc = ix.get(ISessionUsageService);
  agent = ix.get(IAgentScopeContext).agentContext;
});

afterEach(() => disposables.dispose());

async function readRecords(): Promise<WireRecord[]> {
  await dispatcher.flush();
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(
    testWireScope(SCOPE, KEY),
    AGENT_WIRE_RECORD_KEY,
  )) {
    out.push(record);
  }
  return out;
}

function createFreshHost(logKey: string): {
  readonly dispatcher: IEventDispatcher;
  readonly usage: ISessionUsageService;
  readonly agent: AgentContext;
  readonly freshLog: IAppendLogStore;
} {
  const freshIx = disposables.add(new TestInstantiationService());
  freshIx.stub(IFileSystemStorageService, new InMemoryStorageService());
  freshIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  freshIx.set(ISessionUsageService, new SyncDescriptor(SessionUsageService));
  const freshLog = freshIx.get(IAppendLogStore);
  registerTestAgentWire(freshIx, testWireScope(SCOPE, logKey), {
    log: freshLog,
  });
  const freshDispatcher = registerTestEventDispatcher(freshIx);
  return {
    dispatcher: freshDispatcher,
    usage: freshIx.get(ISessionUsageService),
    agent: freshIx.get(IAgentScopeContext).agentContext,
    freshLog,
  };
}

const a1 = { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 };
const a2 = { inputOther: 10, output: 20, inputCacheRead: 30, inputCacheCreation: 40 };
const b1 = { inputOther: 100, output: 200, inputCacheRead: 300, inputCacheCreation: 400 };

describe('SessionUsageService (wire-backed)', () => {
  it('accumulates usage by model', async () => {
    await svc.record(agent, 'model-a', a1);
    await svc.record(agent, 'model-a', a2);
    await svc.record(agent, 'model-b', b1);

    expect(svc.status(agent)).toEqual({
      byModel: {
        'model-a': { inputOther: 11, output: 22, inputCacheRead: 33, inputCacheCreation: 44 },
        'model-b': b1,
      },
      total: { inputOther: 111, output: 222, inputCacheRead: 333, inputCacheCreation: 444 },
      currentTurn: undefined,
    });
  });

  it('tracks current turn usage by turn id', async () => {
    await svc.record(agent, 'model-a', a1);
    await svc.record(agent, 'model-a', a2, { type: 'turn', turnId: 1 });
    await svc.record(agent, 'model-b', b1, { type: 'turn', turnId: 1 });

    expect(svc.status(agent)).toMatchObject({
      total: { inputOther: 111, output: 222, inputCacheRead: 333, inputCacheCreation: 444 },
      currentTurn: { inputOther: 110, output: 220, inputCacheRead: 330, inputCacheCreation: 440 },
    });

    await svc.record(
      agent,
      'model-a',
      { inputOther: 5, output: 6, inputCacheRead: 7, inputCacheCreation: 8 },
      {
        type: 'turn',
        turnId: 2,
      },
    );

    expect(svc.status(agent).currentTurn).toEqual({
      inputOther: 5,
      output: 6,
      inputCacheRead: 7,
      inputCacheCreation: 8,
    });
  });

  it('returns immutable status snapshots', async () => {
    await svc.record(agent, 'model-a', a1);
    const snapshot = svc.status(agent);

    await svc.record(agent, 'model-a', a2);

    expect(snapshot).toEqual({
      byModel: { 'model-a': a1 },
      total: a1,
      currentTurn: undefined,
    });
  });

  it('emits agent.status.updated with the usage snapshot after each live record', async () => {
    const events: Event2[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));

    await svc.record(agent, 'model-a', a1);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'agent.status.updated',
        usage: {
          byModel: { 'model-a': a1 },
          total: a1,
          currentTurn: undefined,
        } satisfies UsageStatus,
      }),
    ]);
  });

  it('fires onDidRecord with the live usage context', async () => {
    const contexts: UsageRecordedContext[] = [];
    disposables.add(
      svc.onDidRecord((ctx) => {
        contexts.push(ctx);
      }),
    );

    await svc.record(agent, 'model-a', a1, { type: 'turn', turnId: 7, step: 2 });

    expect(contexts).toEqual([
      {
        agent,
        model: 'model-a',
        usage: a1,
        source: { type: 'turn', turnId: 7, step: 2 },
        firstRecord: true,
        usageReported: true,
      },
    ]);
  });

  it('marks firstRecord on the first live record only', async () => {
    const contexts: UsageRecordedContext[] = [];
    disposables.add(svc.onDidRecord((ctx) => contexts.push(ctx)));

    await svc.record(agent, 'model-a', a1);
    await svc.record(agent, 'model-b', b1);
    await svc.record(agent, 'model-a', a2);

    expect(contexts.map((ctx) => ctx.firstRecord)).toEqual([true, false, false]);
  });

  it('does not mark firstRecord when usage was restored from persisted records', async () => {
    await svc.record(agent, 'model-a', a1);
    const records = await readRecords();

    const fresh = createFreshHost('usage-first-record-replay');
    await restoreTestEventDispatcher(
      fresh.dispatcher,
      fresh.freshLog,
      testWireScope(SCOPE, 'usage-first-record-replay'),
      records,
    );

    const contexts: UsageRecordedContext[] = [];
    disposables.add(fresh.usage.onDidRecord((ctx) => contexts.push(ctx)));
    await fresh.usage.record(fresh.agent, 'model-a', a2);

    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.firstRecord).toBe(false);
  });

  it('rejects a context the lifecycle never issued', async () => {
    const forged = { agentId: agent.agentId, generation: agent.generation } as AgentContext;

    await expect(svc.record(forged, 'model-a', a1)).rejects.toThrow(
      'is not a lifecycle-issued context',
    );
    expect(() => svc.status(forged)).toThrow('is not a lifecycle-issued context');
  });

  it('dispatch persists flat { type, model, usage, usageScope } records (no payload key)', async () => {
    await svc.record(agent, 'model-a', a1);

    const records = await readRecords();
    expect(records).toEqual([
      {
        type: 'usage.record',
        agentId: 'test-agent',
        model: 'model-a',
        usage: a1,
        usageScope: 'session',
        time: expect.any(Number),
      },
    ]);
    expect('payload' in records[0]!).toBe(false);
  });

  it('marks turn-scoped sources with usageScope only (no turnId or context persisted)', async () => {
    await svc.record(agent, 'model-a', a1, { type: 'turn', turnId: 7, step: 2 });

    const records = await readRecords();
    expect(records).toEqual([
      {
        type: 'usage.record',
        agentId: 'test-agent',
        model: 'model-a',
        usage: a1,
        usageScope: 'turn',
        time: expect.any(Number),
      },
    ]);
  });

  it('replay rebuilds usage from persisted records on a fresh dispatcher (silent)', async () => {
    await svc.record(agent, 'model-a', a1);
    await svc.record(agent, 'model-a', a2, { type: 'turn', turnId: 1 });
    const records = await readRecords();

    const fresh = createFreshHost('usage-replay');

    await restoreTestEventDispatcher(
      fresh.dispatcher,
      fresh.freshLog,
      testWireScope(SCOPE, 'usage-replay'),
      records,
    );

    expect(fresh.usage.status(fresh.agent).byModel).toEqual({
      'model-a': { inputOther: 11, output: 22, inputCacheRead: 33, inputCacheCreation: 44 },
    });

    const written: WireRecord[] = [];
    for await (const record of fresh.freshLog.read<WireRecord>(
      testWireScope(SCOPE, 'usage-replay'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      written.push(record);
    }
    expect(written[0]).toMatchObject({ type: 'metadata' });
    expect(written.slice(1)).toEqual(records);
  });

  it('replays legacy turn context records into byModel totals only (currentTurn is not rebuilt)', async () => {
    const fresh = createFreshHost('usage-legacy-context-replay');

    await restoreTestEventDispatcher(
      fresh.dispatcher,
      fresh.freshLog,
      testWireScope(SCOPE, 'usage-legacy-context-replay'),
      [
        {
          type: 'usage.record',
          model: 'model-a',
          usage: a1,
          usageScope: 'turn',
          turnId: 1,
          context: { type: 'turn', turnId: 9, step: 3 },
        },
      ],
    );

    expect(fresh.usage.status(fresh.agent)).toEqual({
      byModel: { 'model-a': a1 },
      total: a1,
      currentTurn: undefined,
    });
  });
});

describe('AgentCacheBreakService', () => {
  function cache(overrides: Partial<CacheObservation> = {}): CacheObservation {
    return {
      modelAlias: 'model-a',
      protocol: 'anthropic',
      providerType: 'kimi',
      messageCount: 10,
      historyHash: 'history-a',
      thinkingEffort: 'off',
      inputTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
      outputTokens: 0,
      ...overrides,
    };
  }

  function usage(cacheRead: number, inputOther = 100): TokenUsage {
    return { inputOther, output: 10, inputCacheRead: cacheRead, inputCacheCreation: 0 };
  }

  function create(): {
    service: AgentCacheBreakService;
    track2: ReturnType<typeof mock>;
    compaction: Emitter<CompactionCompleted>;
  } {
    const track2 = mock();
    const compaction = new Emitter<CompactionCompleted>();
    disposables.add(compaction);
    ix.stub(ITelemetryService, {
      _serviceBrand: undefined,
      track2,
    } as unknown as ITelemetryService);
    ix.stub(ILogService, SILENT_TEST_LOGGER);
    ix.stub(IEventBus, {
      _serviceBrand: undefined,
      subscribe: (listener: (event: unknown) => void) => compaction.event(listener),
    } as unknown as IEventBus);
    const service = disposables.add(ix.createInstance(AgentCacheBreakService));
    return { service, track2, compaction };
  }

  it('keeps silent until two measured steps exist', () => {
    const { service, track2 } = create();

    expect(service.observe({ usage: usage(10_000), cache: cache(), now: 1_000 })).toBeUndefined();
    expect(track2).not.toHaveBeenCalled();
  });

  it('ignores steps without a cache observation', () => {
    const { service, track2 } = create();

    service.observe({ usage: usage(10_000) });
    const result = service.observe({ usage: usage(1_000) });

    expect(result).toBeUndefined();
    expect(track2).not.toHaveBeenCalled();
  });

  it('reports a sharp cache-read drop as unexplained', () => {
    const { service, track2 } = create();
    service.observe({ usage: usage(10_000), cache: cache(), now: 1_000 });

    const result = service.observe({ usage: usage(5_000), cache: cache(), now: 4_000 });

    expect(result?.cause).toBe('unexplained');
    expect(result?.cacheReadDropRatio).toBe(0.5);
    expect(result?.intervalMs).toBe(3_000);
    expect(track2).toHaveBeenCalledWith('cache_break_detected', {
      turn_id: undefined,
      step_no: undefined,
      cause: 'unexplained',
      prev_model: 'model-a',
      curr_model: 'model-a',
      prev_effort: 'off',
      curr_effort: 'off',
      prev_projection: undefined,
      curr_projection: undefined,
      prev_message_count: 10,
      curr_message_count: 10,
      prev_input_cache_read: 10_000,
      curr_input_cache_read: 5_000,
      prev_input_other: 100,
      curr_input_other: 100,
      prev_output: 10,
      curr_output: 10,
      prev_input_cache_creation: 0,
      curr_input_cache_creation: 0,
      cache_read_drop_ratio: 0.5,
      interval_ms: 3_000,
    });
  });

  it('ignores a drop inside the ratio gate', () => {
    const { service, track2 } = create();
    service.observe({ usage: usage(100_000), cache: cache() });

    expect(service.observe({ usage: usage(96_000), cache: cache() })).toBeUndefined();
    expect(track2).not.toHaveBeenCalled();
  });

  it('ignores a drop under the token threshold', () => {
    const { service, track2 } = create();
    service.observe({ usage: usage(4_000), cache: cache() });

    expect(service.observe({ usage: usage(2_500), cache: cache() })).toBeUndefined();
    expect(track2).not.toHaveBeenCalled();
  });

  it('classifies a model switch', () => {
    const { service } = create();
    service.observe({ usage: usage(10_000), cache: cache() });

    const result = service.observe({
      usage: usage(5_000),
      cache: cache({ modelAlias: 'model-b' }),
    });

    expect(result?.cause).toBe('model_switch');
  });

  it('classifies an effort switch', () => {
    const { service } = create();
    service.observe({ usage: usage(10_000), cache: cache() });

    const result = service.observe({
      usage: usage(5_000),
      cache: cache({ thinkingEffort: 'high' }),
    });

    expect(result?.cause).toBe('effort_switch');
  });

  it('classifies a projection change', () => {
    const { service } = create();
    service.observe({ usage: usage(10_000), cache: cache() });

    const result = service.observe({
      usage: usage(5_000),
      cache: cache({ projection: 'media-degraded' }),
    });

    expect(result?.cause).toBe('projection_change');
  });

  it('classifies a shrinking message count as a prefix reset', () => {
    const { service } = create();
    service.observe({ usage: usage(10_000), cache: cache({ messageCount: 10 }) });

    const result = service.observe({
      usage: usage(5_000),
      cache: cache({ messageCount: 8 }),
    });

    expect(result?.cause).toBe('prefix_reset');
  });

  it('skips unmeasured usage without replacing the baseline', () => {
    const { service, track2 } = create();
    service.observe({ usage: usage(10_000), cache: cache() });
    const unmeasured: TokenUsage = {
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    };

    service.observe({ usage: unmeasured, cache: cache() });
    const result = service.observe({ usage: usage(5_000), cache: cache() });

    expect(result?.previous.usage.inputCacheRead).toBe(10_000);
    expect(track2).toHaveBeenCalledTimes(1);
  });

  it('resets when compaction finishes', () => {
    const { service, track2, compaction } = create();
    service.observe({ usage: usage(10_000), cache: cache() });

    compaction.fire(new CompactionCompleted({ agentId: 'main', result: {} as never }));
    const result = service.observe({ usage: usage(5_000), cache: cache() });

    expect(result).toBeUndefined();
    expect(track2).not.toHaveBeenCalled();
  });

  it('resets the baseline on demand', () => {
    const { service } = create();
    service.observe({ usage: usage(10_000), cache: cache() });

    service.reset();

    expect(service.observe({ usage: usage(5_000), cache: cache() })).toBeUndefined();
  });
});
