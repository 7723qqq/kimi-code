import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import type { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { buildEvalService } from './eval-corpus';

async function withService<T>(task: (service: AssociativeMemoryService) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-interference-'));
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

describe('associative memory interference', () => {
  it('keeps two conflicting but similar memories both retrievable', async () => {
    await withService(async (service) => {
      await service.writeNote('the cache ttl is 30 seconds');
      await service.writeNote('the cache ttl is 60 seconds');

      const stats = await service.stats('project');
      expect(stats.notes).toBe(2);
      expect(stats.atoms).toBe(2);
      expect(stats.suppressed).toBe(0);

      const recalled = await service.recall(query);
      const texts = recalled.items.map((item) => item.text);
      expect(texts.some((text) => text.includes('30 seconds'))).toBe(true);
      expect(texts.some((text) => text.includes('60 seconds'))).toBe(true);
    });
  });

  it('does not merge two memories that differ in one value', async () => {
    await withService(async (service) => {
      const first = await service.writeNote('the cache ttl is 30 seconds');
      const second = await service.writeNote('the cache ttl is 60 seconds');
      expect(first.decision).toBe('added');
      expect(second.decision).toBe('added');
      expect(second.noteId).not.toBe(first.noteId);
    });
  });

  it('treats punctuation-only differences as the same memory', async () => {
    await withService(async (service) => {
      await service.writeNote('the cache ttl is 30 seconds');
      const repeated = await service.writeNote('the cache ttl is 30 seconds!');
      expect(repeated.decision).toBe('noop');
    });
  });
});
