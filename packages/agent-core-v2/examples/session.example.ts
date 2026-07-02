/**
 * Scenario: the **session** slice — `sessionLifecycle` + `sessionMetadata`.
 *
 * Shows the session as a durable, tracked entity and how the slice's domains
 * compose: `ISessionLifecycleService` (App) creates Session child scopes —
 * seeding each with its identity and storage and materializing its metadata —
 * and tracks the live set, while each session's `ISessionMetadata` (Session)
 * reads and updates the persisted document through the App `storage` service.
 *
 * Wiring: the real composition root (`_harness`) provides every collaborator
 * (storage, skill catalog, log, …) so the slice runs for real against a temp
 * `KIMI_CODE_HOME`. Sessions are created through the lifecycle service itself.
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/session.example.ts
 */

import { afterEach, describe, expect, test } from 'vitest';

import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';

import { createSliceHost, type SliceHost } from './_harness';

describe('session slice (sessionLifecycle + sessionMetadata)', () => {
  let host: SliceHost;
  afterEach(() => host?.dispose());

  test('creates, tracks, persists, and closes sessions', async () => {
    host = createSliceHost({ homeDir: process.env['KIMI_CODE_HOME']! });
    const lifecycle = host.app.accessor.get(ISessionLifecycleService);

    const first = await lifecycle.create({ sessionId: 'demo-a', workDir: process.env['KIMI_CODE_HOME']! });
    await lifecycle.create({ sessionId: 'demo-b', workDir: process.env['KIMI_CODE_HOME']! });
    expect(lifecycle.list().map((h) => h.id)).toEqual(expect.arrayContaining(['demo-a', 'demo-b']));

    const meta = first.accessor.get(ISessionMetadata);
    await meta.ready;
    await meta.setTitle('first session');
    expect((await meta.read()).title).toBe('first session');

    await lifecycle.close('demo-b');
    expect(lifecycle.list().map((h) => h.id)).not.toContain('demo-b');
  });
});
