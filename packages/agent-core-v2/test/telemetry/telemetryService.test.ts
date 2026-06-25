import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import {
  type TelemetryClient,
  type TelemetryProperties,
  ITelemetryService,
  TelemetryService,
} from '#/telemetry/index';

class CapturingClient implements TelemetryClient {
  readonly events: { event: string; properties?: TelemetryProperties }[] = [];
  flushCalls = 0;
  shutdownCalls = 0;
  track(event: string, properties?: TelemetryProperties): void {
    this.events.push({ event, properties });
  }
  flush(): void {
    this.flushCalls += 1;
  }
  shutdown(): void {
    this.shutdownCalls += 1;
  }
}

describe('TelemetryService (unit)', () => {
  it('noop by default — does not throw', () => {
    const svc = new TelemetryService();
    expect(() => svc.track('evt', { a: 1 })).not.toThrow();
  });

  it('merges bound context into tracked properties', () => {
    const client = new CapturingClient();
    const svc = new TelemetryService({ sessionId: 's1' });
    svc.setDelegate(client);
    svc.track('turn.start', { agentId: 'main' });
    expect(client.events[0]).toEqual({
      event: 'turn.start',
      properties: { sessionId: 's1', agentId: 'main' },
    });
  });

  it('withContext merges context and shares the delegate', () => {
    const client = new CapturingClient();
    const root = new TelemetryService({ sessionId: 's1' });
    root.setDelegate(client);
    const child = root.withContext({ agentId: 'main', turnId: 't1' });
    child.track('tool.call', { name: 'bash' });
    expect(client.events[0]?.properties).toEqual({
      sessionId: 's1',
      agentId: 'main',
      turnId: 't1',
      name: 'bash',
    });
  });

  it('per-call properties override bound context on key collision', () => {
    const client = new CapturingClient();
    const svc = new TelemetryService({ sessionId: 's1' });
    svc.setDelegate(client);
    svc.track('evt', { sessionId: 'override' });
    expect(client.events[0]?.properties?.['sessionId']).toBe('override');
  });

  it('fans out to every sink passed via clients', () => {
    const a = new CapturingClient();
    const b = new CapturingClient();
    const svc = new TelemetryService({ clients: [a, b] });
    svc.track('evt', { x: 1 });
    expect(a.events).toEqual([{ event: 'evt', properties: { x: 1 } }]);
    expect(b.events).toEqual([{ event: 'evt', properties: { x: 1 } }]);
  });

  it('addSink registers a sink and its disposable removes it', () => {
    const a = new CapturingClient();
    const b = new CapturingClient();
    const svc = new TelemetryService({ client: a });
    const disposable = svc.addSink(b);
    svc.track('first');
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    disposable.dispose();
    svc.track('second');
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(1);
  });

  it('removeSink stops delivery to that sink', () => {
    const a = new CapturingClient();
    const b = new CapturingClient();
    const svc = new TelemetryService({ clients: [a, b] });
    svc.removeSink(a);
    svc.track('evt');
    expect(a.events).toHaveLength(0);
    expect(b.events).toHaveLength(1);
  });

  it('setEnabled(false) drops track; setEnabled(true) resumes', () => {
    const client = new CapturingClient();
    const svc = new TelemetryService({ client });
    svc.setEnabled(false);
    svc.track('dropped');
    expect(client.events).toHaveLength(0);
    svc.setEnabled(true);
    svc.track('sent');
    expect(client.events).toEqual([{ event: 'sent', properties: {} }]);
  });

  it('withContext child inherits enabled state at creation', () => {
    const client = new CapturingClient();
    const root = new TelemetryService({ client });
    root.setEnabled(false);
    const child = root.withContext({ turnId: 't1' });
    child.track('dropped');
    expect(client.events).toHaveLength(0);
  });

  it('flush fans out to every sink', async () => {
    const a = new CapturingClient();
    const b = new CapturingClient();
    const svc = new TelemetryService({ clients: [a, b] });
    await svc.flush();
    expect(a.flushCalls).toBe(1);
    expect(b.flushCalls).toBe(1);
  });

  it('shutdown fans out to every sink', async () => {
    const a = new CapturingClient();
    const b = new CapturingClient();
    const svc = new TelemetryService({ clients: [a, b] });
    await svc.shutdown();
    expect(a.shutdownCalls).toBe(1);
    expect(b.shutdownCalls).toBe(1);
  });

  it('flush is a no-op for sinks without flush', async () => {
    const minimal: TelemetryClient = { track() {} };
    const svc = new TelemetryService({ client: minimal });
    await expect(svc.flush()).resolves.toBeUndefined();
    await expect(svc.shutdown()).resolves.toBeUndefined();
  });
});

describe('TelemetryService (error isolation)', () => {
  beforeEach(() => setUnexpectedErrorHandler(() => {}));
  afterEach(() => resetUnexpectedErrorHandler());

  it('a throwing sink does not prevent delivery to other sinks', () => {
    const bad: TelemetryClient = {
      track() {
        throw new Error('boom');
      },
    };
    const good = new CapturingClient();
    const svc = new TelemetryService({ clients: [bad, good] });
    expect(() => svc.track('evt')).not.toThrow();
    expect(good.events).toEqual([{ event: 'evt', properties: {} }]);
  });

  it('flush tolerates a rejecting sink and still flushes the rest', async () => {
    const bad: TelemetryClient = {
      track() {},
      async flush() {
        throw new Error('boom');
      },
    };
    const good = new CapturingClient();
    const svc = new TelemetryService({ clients: [bad, good] });
    await expect(svc.flush()).resolves.toBeUndefined();
    expect(good.flushCalls).toBe(1);
  });

  it('shutdown tolerates a rejecting sink and still shuts down the rest', async () => {
    const bad: TelemetryClient = {
      track() {},
      async shutdown() {
        throw new Error('boom');
      },
    };
    const good = new CapturingClient();
    const svc = new TelemetryService({ clients: [bad, good] });
    await expect(svc.shutdown()).resolves.toBeUndefined();
    expect(good.shutdownCalls).toBe(1);
  });
});

describe('ITelemetryService (scoped)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Core,
      ITelemetryService,
      TelemetryService,
      InstantiationType.Eager,
      'telemetry',
    );
  });

  it('resolves from the Core scope', () => {
    const host = createScopedTestHost();
    const svc = host.core.accessor.get(ITelemetryService);
    expect(() => svc.track('scoped')).not.toThrow();
    host.dispose();
  });
});
