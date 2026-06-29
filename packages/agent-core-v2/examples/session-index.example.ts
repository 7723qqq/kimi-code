/**
 * Scenario: the **session-index** module — a business-specific Store composed
 * from lower-level persistence Stores.
 *
 * Shows how a real Domain Service builds a query read-model by aggregating two
 * more fundamental Stores. `FileSessionIndex` (`ISessionIndex`) enumerates the
 * persisted session set with `IStorageService.list` (workspace and session
 * directories) and reads each session's `state.json` with
 * `IAtomicDocumentStore.get`, projecting the raw documents into
 * `Page<SessionSummary>`. It is the "business-specific Store" case from the
 * persistence layering rules: named after the domain because its semantics
 * (enumerate / filter / page sessions) are unique, not a generic access
 * pattern.
 *
 * The `state.json` documents are the same ones `session-metadata` writes during
 * `session-lifecycle.create`; here they are seeded directly through the real
 * `IAtomicDocumentStore` so the scenario stays focused on the index read-model
 * rather than the session write path. All Services come from `src/`; nothing
 * here defines a new Service.
 */

import { mkdirSync } from 'node:fs';

import { afterEach, beforeEach, describe, test } from 'vitest';
import { relative } from 'pathe';

import type { Scope } from '#/_base/di/scope';
import { bootstrap } from '#/bootstrap/bootstrap';
import { IBootstrapService } from '#/bootstrap';
import '#/bootstrap/index';
import { ISessionIndex, type SessionSummary } from '#/session-index';
import '#/session-index/index';
import { IAtomicDocumentStore } from '#/storage';
import '#/storage/index';

const META_SCOPE = 'session-meta';
const META_KEY = 'state.json';

interface SeedMeta {
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
}

describe('session-index module (business Store over storage Stores)', () => {
  let homeDir: string;
  let core: Scope;
  let sessionsScope: string;
  let docs: IAtomicDocumentStore;
  let index: ISessionIndex;

  beforeEach(async () => {
    const resolved = process.env['KIMI_CODE_HOME'];
    if (resolved === undefined) {
      throw new Error('KIMI_CODE_HOME is not set; globalSetup should have initialized it');
    }
    homeDir = resolved;
    mkdirSync(homeDir, { recursive: true });

    core = bootstrap({ homeDir }).core;
    const layout = core.accessor.get(IBootstrapService);
    sessionsScope = relative(layout.homeDir, layout.sessionsDir);
    docs = core.accessor.get(IAtomicDocumentStore);
    index = core.accessor.get(ISessionIndex);

    await seed('ws-a', 's1', {
      title: 'first session',
      createdAt: 1000,
      updatedAt: 1000,
      archived: false,
    });
    await seed('ws-a', 's2', {
      title: 'most recently active',
      createdAt: 2000,
      updatedAt: 3000,
      archived: false,
    });
    await seed('ws-a', 's3', {
      title: 'archived session',
      createdAt: 1500,
      updatedAt: 2500,
      archived: true,
    });
    await seed('ws-b', 's4', {
      title: 'other workspace',
      createdAt: 500,
      updatedAt: 500,
      archived: false,
    });
  });

  afterEach(() => {
    core.dispose();
  });

  async function seed(workspaceId: string, sessionId: string, meta: SeedMeta): Promise<void> {
    await docs.set(`${sessionsScope}/${workspaceId}/${sessionId}/${META_SCOPE}`, META_KEY, {
      id: sessionId,
      ...meta,
    });
  }

  test('enumerates, filters, pages, and counts persisted sessions', async () => {
    const print = (label: string, items: readonly SessionSummary[]): void => {
      console.log(label, items.map((s) => `${s.id}(${s.workspaceId}${s.archived ? ',archived' : ''})`));
    };

    print('1) list({}) — non-archived, newest updatedAt first:', (await index.list({})).items);

    print('2) list({ workspaceId: "ws-a" }):', (await index.list({ workspaceId: 'ws-a' })).items);

    print(
      '3) list({ includeArchived: true }):',
      (await index.list({ includeArchived: true })).items,
    );

    print('4) list({ limit: 2 }) — top two by updatedAt:', (await index.list({ limit: 2 })).items);

    console.log('5) get("s4"):', await index.get('s4'));

    console.log('6) countActive("ws-a"):', await index.countActive('ws-a'));
  });
});
