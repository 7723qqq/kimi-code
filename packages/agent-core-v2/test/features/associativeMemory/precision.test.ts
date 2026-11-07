import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import type { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { buildEvalService } from './eval-corpus';

async function withService<T>(task: (service: AssociativeMemoryService) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-precision-'));
  const service = buildEvalService(homeDir);
  try {
    return await task(service);
  } finally {
    service.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

const query = {
  cue: 'cache ttl seconds',
  limit: 8,
  maxTokens: undefined,
  includeHistory: false,
};

const STRONG = 'the cache ttl is 30 seconds';
const RING = [
  'the cache layer keeps entries warm',
  'the ttl policy lives in the config file',
  'seconds matter for the reporting window',
  'the cache window closes at midnight',
];

describe('associative memory precision', () => {
  it('ranks a full match above a ring of partial matches', async () => {
    await withService(async (service) => {
      for (const note of RING) await service.writeNote(note);
      await service.writeNote(STRONG);

      const recalled = await service.recall(query);
      expect(recalled.items[0]?.text).toBe(STRONG);
    });
  });

  it('does not let spreading pull unrelated neighbours into the result', async () => {
    await withService(async (service) => {
      for (const note of RING) await service.writeNote(note);
      await service.writeNote(STRONG);

      const recalled = await service.recall(query);
      const texts = recalled.items.map((item) => item.text);
      expect(texts).toContain(STRONG);
      expect(recalled.items.length).toBeLessThanOrEqual(RING.length + 1);
    });
  });

  it('orders identical input the same way every time', async () => {
    await withService(async (service) => {
      for (const note of RING) await service.writeNote(note);
      await service.writeNote(STRONG);

      const first = await service.recall(query);
      const second = await service.recall(query);
      expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    });
  });

  it('keeps a full match first when the ring pattern repeats', async () => {
    await withService(async (service) => {
      for (let round = 0; round < 3; round += 1) {
        for (const note of RING) await service.writeNote(`${note} round ${round}`);
      }
      await service.writeNote(STRONG);

      const recalled = await service.recall({ ...query, limit: 5 });
      expect(recalled.items[0]?.text).toBe(STRONG);
    });
  });
});
