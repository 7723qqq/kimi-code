import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { stubBootstrap } from '../../app/bootstrap/stubs';

function buildService(homeDir: string, atomBudget: number): AssociativeMemoryService {
  const bootstrap = { ...stubBootstrap(homeDir), cwd: join(homeDir, 'project') };
  return new (class extends AssociativeMemoryService {
    constructor() {
      super(
        bootstrap as never,
        { enabled: () => true } as never,
        { debug() {}, info() {}, warn() {}, error() {} } as never,
        { register: () => ({ dispose() {} }) } as never,
        { get: () => [] } as never,
        { cwd: join(homeDir, 'project') } as never,
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
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-evict-'));
  try {
    return await task(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

describe('associative memory eviction', () => {
  it('records an audit entry when the atom budget forces a deletion', async () => {
    await withDir(async (homeDir) => {
      const service = buildService(homeDir, 2);
      try {
        for (let index = 0; index < 8; index += 1) {
          await service.writeNote(`the subsystem number ${index} keeps its own record`);
        }
        const stats = await service.stats('project');
        expect(stats.atoms - stats.suppressed).toBe(2);
        expect(stats.suppressed).toBeGreaterThan(0);

        const audit = await service.audit(20);
        const evictions = audit.filter((entry) => entry.kind === 'evict_atoms');
        expect(evictions.length).toBeGreaterThan(0);
        expect(Number(evictions[0]!.detail['count'])).toBeGreaterThan(0);
        const ids = evictions[0]!.detail['ids'];
        expect(Array.isArray(ids)).toBe(true);
        expect((ids as string[]).length).toBeGreaterThan(0);
      } finally {
        service.dispose();
      }
    });
  });

  it('retires the isolated atom and keeps the well connected one', async () => {
    await withDir(async (homeDir) => {
      const service = buildService(homeDir, 2);
      try {
        await service.writeNote('the shared cache policy governs every subsystem');
        await service.writeNote('the alpha subsystem reads the shared cache policy');
        await service.writeNote('the beta subsystem writes the shared cache policy');
        await service.writeNote('the gamma subsystem reads the shared cache policy');
        await service.writeNote('the delta subsystem writes the shared cache policy');
        await service.writeNote('the epsilon subsystem reads the shared cache policy');
        await service.writeNote('an isolated note about the office kitchen');
        await service.writeNote('an isolated note about the office printer');

        const listed = await service.list({ kind: 'atom', limit: 20, scope: 'project' });
        const live = await service.stats('project');
        expect(live.atoms - live.suppressed).toBe(2);
        const isolated = await service.recall({
          cue: 'office kitchen printer',
          limit: 5,
          maxTokens: undefined,
          includeHistory: false,
        });
        expect(isolated.items.some((item) => item.text.includes('office'))).toBe(false);
        const hub = await service.recall({
          cue: 'shared cache policy',
          limit: 5,
          maxTokens: undefined,
          includeHistory: false,
        });
        expect(hub.items.length).toBeGreaterThan(0);
        expect(listed.atoms.length).toBe(8);
      } finally {
        service.dispose();
      }
    });
  });

  it('keeps a retired atom visible to history recall', async () => {
    await withDir(async (homeDir) => {
      const service = buildService(homeDir, 1);
      try {
        for (let index = 0; index < 8; index += 1) {
          await service.writeNote(`the cache subsystem keeps record number ${index}`);
        }
        const query = { cue: 'cache subsystem', limit: 8, maxTokens: undefined, includeHistory: false };
        const live = await service.recall(query);
        const history = await service.recall({ ...query, includeHistory: true });
        expect(history.items.length).toBeGreaterThan(live.items.length);
        const retired = history.items.filter((item) => !live.items.some((kept) => kept.id === item.id));
        expect(retired.length).toBeGreaterThan(0);
      } finally {
        service.dispose();
      }
    });
  });

  it('keeps every atom when the budget is not exceeded', async () => {
    await withDir(async (homeDir) => {
      const service = buildService(homeDir, 100);
      try {
        for (let index = 0; index < 6; index += 1) {
          await service.writeNote(`the subsystem number ${index} keeps its own record`);
        }
        const stats = await service.stats('project');
        expect(stats.atoms).toBe(6);
        expect(stats.suppressed).toBe(0);
        const audit = await service.audit(20);
        expect(audit.some((entry) => entry.kind === 'evict_atoms')).toBe(false);
      } finally {
        service.dispose();
      }
    });
  });
});
