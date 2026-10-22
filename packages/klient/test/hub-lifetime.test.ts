import { rm } from 'node:fs/promises';

import { describe, expect, it, mock } from 'bun:test';

import type { EventSourceRef, IDisposable, KlientChannel, ScopeRef } from '../src/core/channel.js';
import { createKlientFromChannel } from '../src/core/klient.js';
import { createKlient } from '../src/transports/memory/index.js';
import { makeEngine } from './helpers/engine.js';

/**
 * A26/F3: an event hub used to be allocated and pinned in the klient's hub Set
 * the moment a session/agent handle was created, so a handle used only for
 * calls (`get()`, `update()`, `setTitle()`) left one `EventHub` — holding the
 * channel and the scope — behind for the life of the process. Only
 * `klient.close()` ever cleared the Set, so `hubs` had degenerated from
 * "active subscriptions" into "every handle ever created".
 *
 * The hub is now memoized behind the handle's `events` getter, so allocation
 * and tracking both start at the first subscription.
 *
 * What separates the two shapes observably is the tracked-hub count: the
 * handle object itself was collectible in both shapes (the hub never points
 * back at the handle), so a `WeakRef` on the handle is not a discriminator —
 * it is asserted below only as a sanity check, with the count doing the work.
 */

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Records subscriptions so a test can prove `close()` still tears them down. */
class RecordingChannel implements KlientChannel {
  readonly subscriptions: Array<{ scope: ScopeRef; source: EventSourceRef }> = [];
  readonly disposed = mock();

  call(): Promise<unknown> {
    return Promise.resolve(undefined);
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterableIterator<unknown> {
    // stub — streaming is not exercised here
  }

  listen(scope: ScopeRef, source: EventSourceRef): IDisposable {
    this.subscriptions.push({ scope, source });
    return {
      dispose: () => {
        this.disposed();
      },
    };
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe('event hub lifetime', () => {
  it('tracks no hub for handles used only for calls, and memoizes the hub it hands out', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    try {
      // Only the global hub exists on a fresh klient (it is off the hot path,
      // so it stays eager).
      expect(klient.__hubCountForTest?.()).toBe(1);

      const created = await klient.global.sessions.create({ workDir: process.cwd() });
      const session = klient.session(created.id);
      await session.get();
      // A real call through the handle, including a second one that would
      // re-create the handle in a caller loop, must not add a hub.
      await session.update({ title: 'hub lifetime' });
      expect(klient.__hubCountForTest?.()).toBe(1);

      const agent = session.agent('main');
      expect(agent.events === agent.events).toBe(true);
      expect(klient.__hubCountForTest?.()).toBe(2);

      // `events` is a stable, memoized object per handle.
      const sessionHub = session.events;
      expect(sessionHub).toBe(session.events);
      expect(klient.__hubCountForTest?.()).toBe(3);

      // A lazily created hub keeps the pre-existing idle lifecycle: once it
      // has no listeners, subs, or error listeners, the owner stops tracking
      // it.
      const subscription = sessionHub.onError(() => undefined);
      subscription.dispose();
      await tick();
      expect(klient.__hubCountForTest?.()).toBe(2);
    } finally {
      await klient.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });

  it('does not grow the hub count with the number of call-only handles', async () => {
    const { homeDir, app } = await makeEngine();
    const klient = createKlient({ scope: app });
    try {
      // node-sdk issues one `session(...)` per RPC; under the eager shape each
      // of these left a hub (and its scope) pinned until `close()`.
      for (let i = 0; i < 25; i += 1) {
        const handle = klient.session(`s-lifetime-${i}`);
        await handle.get().catch(() => undefined);
      }
      expect(klient.__hubCountForTest?.()).toBe(1);

      let ref: WeakRef<object> | undefined;
      {
        const handle = klient.session('s-lifetime-discarded');
        ref = new WeakRef(handle as object);
      }
      const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
      bun?.gc(true);
      await tick(1);
      bun?.gc(true);
      // Sanity check only (see the file comment): both the broken and the
      // fixed shape collect the handle, because the hub never holds it.
      expect(ref?.deref()).toBeUndefined();
      expect(klient.__hubCountForTest?.()).toBe(1);
    } finally {
      await klient.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
  });

  it('still tears down a lazily created hub on klient.close()', async () => {
    const channel = new RecordingChannel();
    const klient = createKlientFromChannel(channel);
    const session = klient.session('s1');
    const dispose = session.events.on('metadata.changed', () => undefined);
    expect(channel.subscriptions).toHaveLength(1);
    expect(channel.subscriptions[0]?.scope).toEqual({ sessionId: 's1' });

    const agentDispose = session.agent('main').events.on('turn.started', () => undefined);
    expect(channel.subscriptions).toHaveLength(2);
    expect(channel.subscriptions[1]?.scope).toEqual({ sessionId: 's1', agentId: 'main' });
    await klient.close();
    expect(channel.disposed).toHaveBeenCalledTimes(2);

    // Disposables handed out before `close()` are inert afterwards.
    dispose.dispose();
    agentDispose.dispose();
    expect(channel.disposed).toHaveBeenCalledTimes(2);
  });
});
