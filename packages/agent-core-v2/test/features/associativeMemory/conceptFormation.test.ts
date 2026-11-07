import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { resetRendered } from '#/agent/injection/renderedLines';
import { AssociativeMemoryService } from '#/features/associativeMemory/service';
import type { AssociativeMemoryStore } from '#/features/associativeMemory/store';

import { stubBootstrap } from '../../app/bootstrap/stubs';
import { buildEvalService } from './eval-corpus';

const CLUSTER = [
  'the cache layer keeps a warm copy of the response',
  'the cache layer evicts entries under memory pressure',
  'the cache layer resets the ttl on restart',
  'the cache layer warms on startup',
  'the cache layer logs the hit rate',
];

async function withService<T>(task: (service: AssociativeMemoryService) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-concept-'));
  const service = buildEvalService(homeDir);
  try {
    return await task(service);
  } finally {
    service.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

function buildSession(homeDir: string, sessionId: string): AssociativeMemoryService {
  resetRendered();
  const bootstrap = { ...stubBootstrap(homeDir), cwd: join(homeDir, 'project') };
  return new (class extends AssociativeMemoryService {
    constructor() {
      super(
        bootstrap as never,
        { enabled: () => true } as never,
        { debug() {}, info() {}, warn() {}, error() {} } as never,
        { register: () => ({ dispose() {} }) } as never,
        { get: () => [] } as never,
        { cwd: join(homeDir, 'project'), sessionId } as never,
      );
    }
    protected override now(): number {
      return 1_000;
    }
  })();
}

async function storeOf(service: AssociativeMemoryService): Promise<AssociativeMemoryStore> {
  const scopeKey = await (
    service as unknown as { projectScopeKey(): Promise<string> }
  ).projectScopeKey();
  return (
    service as unknown as { ensureStore(key: string): Promise<AssociativeMemoryStore> }
  ).ensureStore(scopeKey);
}

const query = {
  cue: 'cache layer memory pressure',
  limit: 8,
  maxTokens: undefined,
  includeHistory: false,
  reinforce: true,
};

describe('associative memory concept formation', () => {
  it('forms a concept once the same atoms are recalled together repeatedly', async () => {
    await withService(async (service) => {
      for (const note of CLUSTER) await service.writeNote(note);
      expect((await service.stats('project')).concepts).toBe(0);

      for (let round = 0; round < 4; round += 1) await service.recall(query);

      const stats = await service.stats('project');
      expect(stats.concepts).toBeGreaterThan(0);
      const listed = await service.list({ kind: 'concept', limit: 5, scope: 'project' });
      expect(listed.concepts.length).toBeGreaterThan(0);

      const recalled = await service.recall({ ...query, reinforce: false });
      const kinds = recalled.items.map((item) => item.kind);
      expect(kinds).toContain('concept');

      const target = listed.concepts[0]!;
      await service.labelConcept(target.id, 'cache lifecycle');
      const labelled = (await service.list({ kind: 'concept', limit: 5, scope: 'project' })).concepts;
      expect(labelled[0]?.label).toBe('cache lifecycle');
      const autoLabel = listed.concepts[0]!.label.split(' ');
      expect(new Set(autoLabel).size).toBe(autoLabel.length);
      expect(labelled[0]?.labelSource).toBe('llm');
    });
  });

  it('surfaces the concept for a cue spread across its members', async () => {
    await withService(async (service) => {
      for (const note of CLUSTER) await service.writeNote(note);
      const spread = {
        cue: 'warm evict ttl startup hit',
        limit: 5,
        maxTokens: undefined,
        includeHistory: false,
        reinforce: true,
      };
      for (let round = 0; round < 4; round += 1) await service.recall(spread);
      const recalled = await service.recall({ ...spread, reinforce: false });
      const kinds = recalled.items.slice(0, 3).map((item) => item.kind);
      expect(kinds).toContain('concept');
    });
  });

  it('accumulates co-activation across injected sessions so a concept can form', async () => {
    const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-inject-'));
    try {
      const seed = buildSession(homeDir, 'seed');
      for (const note of CLUSTER) await seed.writeNote(note);
      seed.dispose();

      for (let round = 0; round < 4; round += 1) {
        const session = buildSession(homeDir, `inject-${String(round)}`);
        const block = await session.signalBlock('the cache layer memory pressure');
        expect(block).toContain('cache layer');
        session.dispose();
      }

      const check = buildSession(homeDir, 'check');
      expect((await check.stats('project')).concepts).toBeGreaterThan(0);
      check.dispose();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('records co-activation on injection without strengthening edges', async () => {
    await withService(async (service) => {
      for (const note of CLUSTER) await service.writeNote(note);
      const store = await storeOf(service);
      const before = new Map(store.listEdges().map((edge) => [edge.id, edge.weight]));
      const beforeCooc = store.listCooccurrences().reduce((sum, cooc) => sum + cooc.count, 0);

      await service.signalBlock('the cache layer memory pressure');

      const after = new Map(store.listEdges().map((edge) => [edge.id, edge.weight]));
      const afterCooc = store.listCooccurrences().reduce((sum, cooc) => sum + cooc.count, 0);
      expect(afterCooc).toBeGreaterThan(beforeCooc);
      for (const [id, weight] of before) expect(after.get(id)).toBe(weight);
      for (const edge of store.listEdges()) {
        if (before.has(edge.id)) continue;
        expect(edge.kind).not.toBe('hebbian');
      }
    });
  });
});
