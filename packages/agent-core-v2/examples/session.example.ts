/**
 * Scenario: the **session** slice — `sessionLifecycle` + `sessionMetadata`.
 *
 * Shows the session as a durable, tracked entity and how the slice's domains
 * compose: `ISessionLifecycleService` (App) creates Session child scopes —
 * seeding each with its identity and storage and materializing its metadata —
 * and tracks the live set, while each session's `ISessionMetadata` (Session)
 * reads and updates the persisted document through the App `storage` service.
 * The host is the production `bootstrap` composition root (real file-backed
 * storage rooted under `.vitest-results/kimi-code-{timestamp}/`); only the
 * slice's barrels are imported, so nothing outside it is loaded.
 */

import { mkdirSync } from 'node:fs';

import { afterEach, beforeEach, describe, test } from 'vitest';

import type { ServiceIdentifier } from '#/_base/di/instantiation';
import type { Scope, ScopeSeed } from '#/_base/di/scope';
import { bootstrap } from '#/app/bootstrap/bootstrap';
import { logSeed, resolveLoggingConfig } from '#/app/log/logConfig';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import '#/app/sessionLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import '#/session/sessionMetadata';
import { FileStorageService } from '#/app/storage/fileStorageService';
import { IAtomicDocumentStorage } from '#/app/storage/storageService';

/** Route the atomic-document access pattern to a file-backed store at `homeDir`. */
function diskStorageSeed(homeDir: string): ScopeSeed {
  return [[IAtomicDocumentStorage as ServiceIdentifier<unknown>, new FileStorageService(homeDir)]];
}

describe('session slice (sessionLifecycle + sessionMetadata)', () => {
  let homeDir: string;
  let app: Scope;

  beforeEach(() => {
    const resolved = process.env['KIMI_CODE_HOME'];
    if (resolved === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    homeDir = resolved;
    mkdirSync(homeDir, { recursive: true });
    app = bootstrap({}, [
      ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
      ...diskStorageSeed(homeDir),
    ]).app;
  });
  afterEach(() => {
    app.dispose();
  });

  test('creates, tracks, persists, and closes sessions', async () => {
    console.log('KIMI_CODE_HOME =', homeDir);
    const lifecycle = app.accessor.get(ISessionLifecycleService);

    const first = await lifecycle.create({ sessionId: 's1', workDir: homeDir });
    await lifecycle.create({ sessionId: 's2', workDir: homeDir });
    console.log('live after create:', lifecycle.list().map((h) => h.id));

    const meta = first.accessor.get(ISessionMetadata);
    await meta.ready;
    console.log('s1 initial:', await meta.read());
    await meta.setTitle('first session');
    console.log('s1 after setTitle:', await meta.read());

    await lifecycle.close('s2');
    console.log('live after close(s2):', lifecycle.list().map((h) => h.id));
  });
});
