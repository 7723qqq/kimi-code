/**
 * Scenario: the **DI Scope** foundation — how resolution follows the tree.
 *
 * Not a business slice but the model every other slice rests on. Two rules,
 * shown with real services: a Core-scoped service (`ILogService`) resolves to
 * the same instance whether you ask the Core scope or a child Session scope
 * (it is found by walking up), while a Session-scoped service
 * (`ISessionMetadata`) is one distinct instance per session, so two sessions
 * hold independent state. Loads only `log` and `session-metadata`.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, test } from 'vitest';

import type { ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, type Scope, type ScopeSeed } from '#/_base/di/scope';
import { bootstrap } from '#/bootstrap/bootstrap';
import { ILogService, sessionLogSeed } from '#/log/log';
import { logSeed, resolveLoggingConfig } from '#/log/logConfig';
import { sessionContextSeed } from '#/session-context/sessionContext';
import '#/log/index';
import '#/session-metadata/index';
import { ISessionMetadata } from '#/session-metadata/sessionMetadata';
import { FileStorageService } from '#/storage/fileStorageService';
import { IAtomicDocumentStorage } from '#/storage/storageService';

/** Route the atomic-document access pattern to a file-backed store at `homeDir`. */
function diskStorageSeed(homeDir: string): ScopeSeed {
  return [[IAtomicDocumentStorage as ServiceIdentifier<unknown>, new FileStorageService(homeDir)]];
}

describe('di scope foundation (Core singletons vs. per-Session instances)', () => {
  let homeDir: string;
  let core: Scope;

  beforeEach(() => {
    const resolved = process.env['KIMI_CODE_HOME'];
    if (resolved === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    homeDir = resolved;
    mkdirSync(homeDir, { recursive: true });
    core = bootstrap({}, [
      ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
      ...diskStorageSeed(homeDir),
    ]).core;
  });
  afterEach(() => {
    core.dispose();
  });

  function createSession(sessionId: string): Scope {
    const sessionDir = join(homeDir, 'sessions', 'example', sessionId);
    return core.createChild(LifecycleScope.Session, sessionId, {
      extra: [
        ...sessionContextSeed({
          _serviceBrand: undefined,
          sessionId,
          workspaceId: 'example',
          sessionDir,
          metaScope: 'session-meta',
        }),
        ...sessionLogSeed(sessionId, sessionDir),
      ],
    });
  }

  test('Core services are shared; Session services are per-session', async () => {
    console.log('KIMI_CODE_HOME =', homeDir);
    const sessionA = createSession('scope-a');
    const sessionB = createSession('scope-b');

    const logFromCore = core.accessor.get(ILogService);
    const logFromSession = sessionA.accessor.get(ILogService);
    console.log('Core ILogService shared across scopes:', logFromCore === logFromSession);

    const metaA = sessionA.accessor.get(ISessionMetadata);
    const metaB = sessionB.accessor.get(ISessionMetadata);
    await Promise.all([metaA.ready, metaB.ready]);
    console.log('Session ISessionMetadata differs per session:', metaA !== metaB);

    await metaA.setTitle('session A');
    await metaB.setTitle('session B');
    const [a, b] = await Promise.all([metaA.read(), metaB.read()]);
    console.log('  A title:', a.title);
    console.log('  B title:', b.title);
  });
});
