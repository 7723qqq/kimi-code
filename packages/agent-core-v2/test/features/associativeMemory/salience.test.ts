import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import type { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { buildEvalService } from './eval-corpus';

async function withService<T>(task: (service: AssociativeMemoryService) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-salience-'));
  const service = buildEvalService(homeDir);
  try {
    return await task(service);
  } finally {
    service.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

const query = {
  cue: 'cache ttl',
  limit: 5,
  maxTokens: undefined,
  includeHistory: false,
};

describe('associative memory salience', () => {
  it('flips the order when the second placed memory is pinned', async () => {
    await withService(async (service) => {
      await service.writeNote('the cache ttl lives in the config file');
      await service.writeNote('the cache ttl defaults to thirty seconds');

      const before = await service.recall(query);
      expect(before.items.length).toBeGreaterThan(1);
      const runnerUp = before.items[1]!;
      const first = before.items[0]!;
      await service.pin(runnerUp.id);

      const after = await service.recall(query);
      expect(after.items[0]?.id).toBe(runnerUp.id);
      expect(after.items[1]?.id).toBe(first.id);
    });
  });

  it('exposes salience in the explain trace', async () => {
    await withService(async (service) => {
      const written = await service.writeNote('the cache ttl is 30 seconds');
      const atomId = written.atomIds[0];
      expect(atomId).toBeDefined();
      await service.pin(atomId!);

      const explained = await service.explain(query);
      const seeds = explained.trace.filter((node) => node.kind === 'seed');
      const salient = seeds.find((node) => node.id === atomId);
      expect(salient?.salience).toBe(2);
    });
  });

  it('caps the boost so pinning repeatedly cannot dominate a peer outright', async () => {
    await withService(async (service) => {
      const peer = await service.writeNote('the cache ttl lives in the config file');
      const pinned = await service.writeNote('the cache ttl defaults to thirty seconds');
      const pinnedId = pinned.atomIds[0];
      expect(pinnedId).toBeDefined();
      for (let round = 0; round < 20; round += 1) await service.pin(pinnedId!);

      const recalled = await service.recall(query);
      const pinnedScore = recalled.items.find((item) =>
        item.text.includes('defaults to thirty seconds'),
      )?.score;
      const peerScore = recalled.items.find((item) => item.text.includes('config file'))?.score;
      expect(pinnedScore).toBeDefined();
      expect(peerScore).toBeDefined();
      expect(pinnedScore!).toBeLessThan(peerScore! * 2 + 0.5);
      expect(peer.atomIds.length).toBeGreaterThan(0);
    });
  });
});
