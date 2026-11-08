import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { stubBootstrap } from '../../app/bootstrap/stubs';

function build(homeDir: string, atomBudget: number): AssociativeMemoryService {
  const bootstrap = { ...stubBootstrap(homeDir), cwd: join(homeDir, 'project') };
  return new (class extends AssociativeMemoryService {
    constructor() {
      super(
        bootstrap as never,
        { enabled: () => true } as never,
        { debug() {}, info() {}, warn() {}, error() {} } as never,
        { register: () => ({ dispose() {} }) } as never,
        { get: () => [] } as never,
        { cwd: join(homeDir, 'project'), sessionId: homeDir } as never,
        { list: async () => [], get: async () => undefined, setReadOnly() {} } as never,
      );
    }
    protected override atomBudget(): number {
      return atomBudget;
    }
    protected override now(): number {
      return 1_000;
    }
  })();
}

async function withDir<T>(task: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-scope-'));
  try {
    return await task(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

const query = (scope: 'project' | 'global' | 'all') => ({
  cue: 'cache ttl seconds',
  limit: 8,
  maxTokens: undefined,
  includeHistory: false,
  scope,
});

describe('associative memory scope isolation', () => {
  it('keeps a global memory when the project store is under capacity pressure', async () => {
    await withDir(async (homeDir) => {
      const service = build(homeDir, 2);
      try {
        await service.writeNote('the cache ttl seconds policy is global', 'global');
        for (let index = 0; index < 8; index += 1) {
          await service.writeNote(`the cache ttl seconds project note ${index}`, 'project');
        }

        const globalOnly = await service.recall(query('global'));
        expect(globalOnly.items.some((item) => item.text.includes('is global'))).toBe(true);

        const all = await service.recall(query('all'));
        expect(all.items.some((item) => item.text.includes('is global'))).toBe(true);
        expect(all.items.some((item) => item.text.includes('project note'))).toBe(true);
      } finally {
        service.dispose();
      }
    });
  });

  it('keeps project and global results separate when a scope is named', async () => {
    await withDir(async (homeDir) => {
      const service = build(homeDir, 100);
      try {
        await service.writeNote('the cache ttl seconds policy is global', 'global');
        await service.writeNote('the cache ttl seconds policy is per project', 'project');

        const projectOnly = await service.recall(query('project'));
        expect(projectOnly.items.some((item) => item.text.includes('per project'))).toBe(true);
        expect(projectOnly.items.some((item) => item.text.includes('is global'))).toBe(false);

        const globalOnly = await service.recall(query('global'));
        expect(globalOnly.items.some((item) => item.text.includes('is global'))).toBe(true);
        expect(globalOnly.items.some((item) => item.text.includes('per project'))).toBe(false);
      } finally {
        service.dispose();
      }
    });
  });

  it('returns memories from both stores for the combined scope', async () => {
    await withDir(async (homeDir) => {
      const service = build(homeDir, 100);
      try {
        await service.writeNote('the cache ttl seconds policy is global', 'global');
        await service.writeNote('the cache ttl seconds policy is per project', 'project');

        const all = await service.recall(query('all'));
        const texts = all.items.map((item) => item.text).join(' ');
        expect(texts).toContain('is global');
        expect(texts).toContain('per project');
      } finally {
        service.dispose();
      }
    });
  });

  it('injects a global memory while the project store is under capacity pressure', async () => {
    await withDir(async (homeDir) => {
      const service = build(homeDir, 2);
      try {
        await service.writeNote('the cache ttl seconds policy is global', 'global');
        for (let index = 0; index < 8; index += 1) {
          await service.writeNote(`the cache ttl seconds project note ${index}`, 'project');
        }

        const block = await service.signalBlock('cache ttl seconds');
        expect(block).toContain('is global');
      } finally {
        service.dispose();
      }
    });
  });

  it('keeps scores from both stores on a comparable scale', async () => {
    await withDir(async (homeDir) => {
      const service = build(homeDir, 100);
      try {
        await service.writeNote('the cache ttl seconds policy is global', 'global');
        await service.writeNote('the cache ttl seconds policy is per project', 'project');

        const all = await service.recall(query('all'));
        const scores = all.items.map((item) => item.score);
        const highest = Math.max(...scores);
        const lowest = Math.min(...scores);
        expect(lowest).toBeGreaterThan(highest * 0.2);
      } finally {
        service.dispose();
      }
    });
  });
});
