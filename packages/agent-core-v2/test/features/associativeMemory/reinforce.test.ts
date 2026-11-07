import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import type { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { buildEvalService } from './eval-corpus';

async function withService<T>(task: (service: AssociativeMemoryService) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-reinforce-'));
  const service = buildEvalService(homeDir);
  try {
    return await task(service);
  } finally {
    service.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

const passive = { cue: 'cache ttl', limit: 5, maxTokens: undefined, includeHistory: false };
const explicit = { ...passive, reinforce: true };

async function snapshot(service: AssociativeMemoryService) {
  const recalled = await service.recall(passive);
  return recalled.items.map((item) => ({ id: item.id, score: Number(item.score.toFixed(6)) }));
}

describe('associative memory reinforcement', () => {
  it('does not drift when memories are only injected, not asked for', async () => {
    await withService(async (service) => {
      await service.writeNote('the cache layer sets a 30 second ttl on entries');
      await service.writeNote('the cache eviction runs under memory pressure');
      const before = await snapshot(service);
      for (let turn = 0; turn < 5; turn += 1) {
        await service.recall(passive);
        await service.recall(passive);
      }
      expect(await snapshot(service)).toEqual(before);
    });
  });

  it('keeps recalling the same items when reinforcement is requested', async () => {
    await withService(async (service) => {
      await service.writeNote('the cache layer sets a 30 second ttl on entries');
      await service.writeNote('the cache eviction runs under memory pressure');
      const first = await service.recall(explicit);
      const second = await service.recall(explicit);
      expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
      expect(second.items.length).toBeGreaterThan(0);
    });
  });

  it('leaves the store edge count unchanged by passive recall', async () => {
    await withService(async (service) => {
      await service.writeNote('the cache layer sets a 30 second ttl on entries');
      await service.writeNote('the cache eviction runs under memory pressure');
      const before = await service.stats('project');
      await service.recall(passive);
      const after = await service.stats('project');
      expect(after.edges).toBe(before.edges);
      expect(after.atoms).toBe(before.atoms);
    });
  });
});
