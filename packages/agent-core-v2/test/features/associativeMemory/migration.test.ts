import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { legacyProjectIdFromCwd, projectIdFromCwd } from '#/app/memory/memoryPaths';
import { AssociativeMemoryService } from '#/features/associativeMemory/service';
import { AssociativeMemoryStore } from '#/features/associativeMemory/store';
import type { Atom } from '#/features/associativeMemory/types';

import { stubBootstrap } from '../../app/bootstrap/stubs';

function buildService(homeDir: string, cwd: string): AssociativeMemoryService {
  const bootstrap = { ...stubBootstrap(homeDir), cwd };
  return new (class extends AssociativeMemoryService {
    constructor() {
      super(
        bootstrap as never,
        { enabled: () => true } as never,
        { debug() {}, info() {}, warn() {}, error() {} } as never,
        { register: () => ({ dispose() {} }) } as never,
        { get: () => [] } as never,
        { cwd } as never,
        { list: async () => [], get: async () => undefined, setReadOnly() {} } as never,
      );
    }
    protected override now(): number {
      return 1_000;
    }
  })();
}

function atom(scopeKey: string, text: string): Atom {
  return {
    id: 'atom-1',
    noteId: 'n1',
    scopeKey,
    nodeType: 'atom',
    text,
    spanStart: 0,
    spanEnd: text.length,
    terms: ['cache', 'ttl'],
    vector: { cache: 1, ttl: 1 },
    denseVector: undefined,
    conceptId: undefined,
    baseWeight: 1,
    confidence: 1,
    replayPriority: 0,
    pinned: false,
    suppressed: false,
    validFrom: 1,
    validUntil: undefined,
    isDeleted: false,
    createdAt: 1,
    lastActivatedAt: 1,
  };
}

describe('associative memory project scope migration', () => {
  it('moves a store written under the old path key onto the repository key', async () => {
    const homeDir = await mkdtemp(join(os.tmpdir(), 'assoc-migrate-'));
    const projectDir = await mkdtemp(join(os.tmpdir(), 'assoc-project-'));
    try {
      await mkdir(join(projectDir, '.git'), { recursive: true });
      await writeFile(
        join(projectDir, '.git', 'config'),
        '[remote "origin"]\n\turl = git@example.com:team/repo.git\n',
        'utf-8',
      );
      const legacy = legacyProjectIdFromCwd(projectDir);
      const current = projectIdFromCwd(projectDir);
      expect(legacy).not.toBe(current);

      const storeRoot = join(homeDir, 'store', 'associative-memory');
      const text = 'the cache layer sets a 30 second ttl on entries';
      const seed = await AssociativeMemoryStore.open(legacy, storeRoot);
      await seed.putNote({ id: 'n1', scopeKey: legacy, text, createdAt: 1, source: 'legacy' });
      await seed.putAtom(atom(legacy, text));
      await seed.close();
      expect(existsSync(join(storeRoot, legacy))).toBe(true);

      const service = buildService(homeDir, projectDir);
      try {
        const stats = await service.stats('project');
        expect(stats.atoms).toBe(1);
        expect(stats.notes).toBe(1);
        const recalled = await service.recall({
          cue: 'cache ttl',
          limit: 5,
          maxTokens: undefined,
          includeHistory: false,
        });
        expect(recalled.items.length).toBeGreaterThan(0);
      } finally {
        service.dispose();
      }

      expect(existsSync(join(storeRoot, legacy))).toBe(false);
      expect(existsSync(join(storeRoot, current))).toBe(true);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('leaves an existing store on the current key untouched', async () => {
    const homeDir = await mkdtemp(join(os.tmpdir(), 'assoc-migrate-'));
    const projectDir = await mkdtemp(join(os.tmpdir(), 'assoc-project-'));
    try {
      const storeRoot = join(homeDir, 'store', 'associative-memory');
      const service = buildService(homeDir, projectDir);
      try {
        await service.writeNote('the cache layer sets a 30 second ttl on entries');
      } finally {
        service.dispose();
      }
      const current = projectIdFromCwd(projectDir);
      expect(existsSync(join(storeRoot, current))).toBe(true);

      const reopened = buildService(homeDir, projectDir);
      try {
        await reopened.writeNote('the billing invoice proration rounds down');
        const stats = await reopened.stats('project');
        expect(stats.notes).toBe(2);
      } finally {
        reopened.dispose();
      }
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
