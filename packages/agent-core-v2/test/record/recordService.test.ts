import { describe, expect, it, vi } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { createServices } from '#/_base/di/test';
import { OrderedHookSlot } from '#/hooks';
import { IAgentWireRecordService } from '#/agent/wireRecord';
import type { WireRecord, WireRecordRestoredContext } from '#/agent/wireRecord';
import {
  AgentRecordService,
  IAgentRecordService,
  type AgentRecord,
} from '#/agent/record';
import type { AgentEvent } from '@moonshot-ai/protocol';
import type { AgentReplayRecordPayload } from '#/agent/replayBuilder/types';

declare module '#/agent/record' {
  interface AgentRecordMap {
    'test.fact': { value: number };
  }
}

interface StubHost {
  readonly record: IAgentRecordService;
  readonly wire: ReturnType<typeof createWireStub>;
  readonly dispose: () => void;
}

function createWireStub() {
  const appended: unknown[] = [];
  const resumers = new Map<string, (record: unknown) => void | Promise<void>>();
  const hooks = {
    onRestoredRecord: new OrderedHookSlot<WireRecordRestoredContext>(),
    onResumeEnded: new OrderedHookSlot<{}>(),
  };
  let restoring: { time?: number } | null = null;
  return {
    appended,
    resumers,
    hooks,
    append: vi.fn((record: unknown) => appended.push(record)),
    register: vi.fn((type: string, resumer: (record: unknown) => void | Promise<void>) => {
      resumers.set(type, resumer);
      return toDisposable(() => resumers.delete(type));
    }),
    restore: vi.fn(async () => ({}) as { warning?: string }),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    getRecords: vi.fn(() => []),
    get restoring() {
      return restoring;
    },
    setRestoring(value: { time?: number } | null) {
      restoring = value;
    },
    postRestoring: false,
  };
}

function createHost(captureLiveRecords = false): StubHost {
  const wire = createWireStub();
  const disposables = new DisposableStore();
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      reg.definePartialInstance(IAgentWireRecordService, wire);
    },
  });
  // Seed the leading static `options` argument (range) so createInstance does
  // not warn about a static/service-dependency conflict.
  ix.set(IAgentRecordService, new SyncDescriptor(AgentRecordService, [{}]));
  const record = ix.get(IAgentRecordService);
  record.captureLiveRecords = captureLiveRecords;
  return {
    record,
    wire,
    dispose: () => disposables.dispose(),
  };
}

describe('AgentRecordService facade', () => {
  it('append fans out to durable + live + replay facets', () => {
    const host = createHost(true);
    const live: AgentEvent[] = [];
    host.record.on((event) => live.push(event));
    host.record.define('test.fact', {
      toLive: (r) => ({ type: 'test.live', value: r.value }) as unknown as AgentEvent,
      toReplay: (r) =>
        ({ type: 'message', value: r.value }) as unknown as AgentReplayRecordPayload,
    });

    host.record.append({ type: 'test.fact', value: 42 });

    expect(host.wire.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'test.fact', value: 42 }),
    );
    expect(live).toContainEqual(expect.objectContaining({ type: 'test.live', value: 42 }));
    expect(host.record.buildReplay()).toContainEqual(
      expect.objectContaining({ type: 'message', value: 42 }),
    );
    host.dispose();
  });

  it('append omits facets that are not declared', () => {
    const host = createHost(true);
    const live: AgentEvent[] = [];
    host.record.on((event) => live.push(event));
    host.record.define('test.fact', {});

    host.record.append({ type: 'test.fact', value: 1 });

    expect(host.wire.append).toHaveBeenCalledTimes(1);
    expect(live).toHaveLength(0);
    expect(host.record.buildReplay()).toHaveLength(0);
    host.dispose();
  });

  it('live append does not feed the replay buffer unless captureLiveRecords is set', () => {
    const host = createHost(false);
    host.record.define('test.fact', {
      toReplay: (r) =>
        ({ type: 'message', value: r.value }) as unknown as AgentReplayRecordPayload,
    });

    host.record.append({ type: 'test.fact', value: 7 });

    expect(host.wire.append).toHaveBeenCalledTimes(1);
    expect(host.record.buildReplay()).toHaveLength(0);
    host.dispose();
  });

  it('signal emits live only and never persists or captures replay', () => {
    const host = createHost(true);
    const live: AgentEvent[] = [];
    host.record.on((event) => live.push(event));

    host.record.signal({ type: 'test.delta', delta: 'x' } as unknown as AgentEvent);

    expect(live).toContainEqual(expect.objectContaining({ type: 'test.delta', delta: 'x' }));
    expect(host.wire.append).not.toHaveBeenCalled();
    expect(host.record.buildReplay()).toHaveLength(0);
    host.dispose();
  });

  it('define registers the resumer with wireRecord and forwards the record', async () => {
    const host = createHost();
    const resume = vi.fn();
    host.record.define('test.fact', { resume });

    expect(host.wire.register).toHaveBeenCalledWith('test.fact', expect.any(Function), undefined);
    const registered = host.wire.resumers.get('test.fact');
    expect(registered).toBeDefined();
    await registered?.({ type: 'test.fact', value: 7 });

    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ value: 7 }));
    host.dispose();
  });

  it('captures replay during restore through the onRestoredRecord hook', async () => {
    const host = createHost();
    host.record.define('test.fact', {
      toReplay: (r) =>
        ({ type: 'message', value: r.value }) as unknown as AgentReplayRecordPayload,
    });
    host.wire.setRestoring({ time: 123 });

    await host.wire.hooks.onRestoredRecord.run({
      record: { type: 'test.fact', value: 5 } as unknown as WireRecord,
      stop: false,
    });

    expect(host.record.buildReplay()).toContainEqual(
      expect.objectContaining({ type: 'message', value: 5, time: 123 }),
    );
    host.dispose();
  });

  it('suppresses live emission while restoring', () => {
    const host = createHost();
    const live: AgentEvent[] = [];
    host.record.on((event) => live.push(event));
    host.record.define('test.fact', {
      toLive: (r) => ({ type: 'test.live', value: r.value }) as unknown as AgentEvent,
    });
    host.wire.setRestoring({ time: 1 });

    host.record.append({ type: 'test.fact', value: 3 });

    expect(host.wire.append).toHaveBeenCalledTimes(1);
    expect(live).toHaveLength(0);
    host.dispose();
  });

  it('dispose returned by define unregisters the resumer and facets', () => {
    const host = createHost(true);
    const subscription = host.record.define('test.fact', { resume: vi.fn() });
    expect(host.wire.resumers.has('test.fact')).toBe(true);

    subscription.dispose();

    expect(host.wire.resumers.has('test.fact')).toBe(false);
    // Facet removed: append should no longer fan out (still persists).
    host.record.append({ type: 'test.fact', value: 1 });
    expect(host.wire.append).toHaveBeenCalledTimes(1);
    host.dispose();
  });
});
