/**
 * Scenario: the **DI Scope** foundation — how resolution follows the tree.
 *
 * Not a business slice but the model every other slice rests on. Two rules,
 * shown with real services resolved through the composition root (`_harness`):
 *
 *   - an **App-scoped** service (`ILogService`) resolves to the same instance
 *     whether you ask the App scope or a child Session scope — resolution walks
 *     up the tree and finds the one App instance;
 *   - a **Session-scoped** service (`ISessionMetadata`) is one distinct instance
 *     per session, so two sessions hold independent state.
 *
 * Wiring: the real composition root (`_harness`) provides every service; we open
 * two Session scopes to show the per-session isolation.
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/scope.example.ts
 */

import { afterEach, describe, expect, test } from 'vitest';

import { ILogService } from '#/app/log/log';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { createSliceHost, type SliceHost } from './_harness';

describe('di scope foundation (App singletons vs. per-Session instances)', () => {
  let host: SliceHost;
  afterEach(() => host?.dispose());

  test('App services are shared; Session services are per-session', async () => {
    host = createSliceHost({ homeDir: process.env['KIMI_CODE_HOME']! });
    const sessionA = host.session;
    const sessionB = host.newSession('scope-b');

    // App-scoped service: the same instance is visible from App and Session.
    const logFromApp = host.app.accessor.get(ILogService);
    const logFromSession = sessionA.accessor.get(ILogService);
    expect(logFromApp).toBe(logFromSession);

    // Session-scoped service: each session gets its own instance + state.
    const metaA = sessionA.accessor.get(ISessionMetadata);
    const metaB = sessionB.accessor.get(ISessionMetadata);
    expect(metaA).not.toBe(metaB);
    await Promise.all([metaA.ready, metaB.ready]);

    await metaA.setTitle('session A');
    await metaB.setTitle('session B');
    const [a, b] = await Promise.all([metaA.read(), metaB.read()]);
    expect(a.title).toBe('session A');
    expect(b.title).toBe('session B');
  });
});
