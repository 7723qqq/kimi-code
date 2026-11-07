import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import type { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { buildEvalService } from './eval-corpus';

async function withService<T>(task: (service: AssociativeMemoryService) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-dedupe-'));
  const service = buildEvalService(homeDir);
  try {
    return await task(service);
  } finally {
    service.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function atomCount(service: AssociativeMemoryService): Promise<number> {
  const stats = await service.stats('project');
  return stats.atoms;
}

describe('associative memory write merge', () => {
  it('treats an identical note as a no-op and keeps the original note', async () => {
    await withService(async (service) => {
      const text = 'the cache layer sets a 30 second ttl on entries';
      const first = await service.writeNote(text);
      expect(first.decision).toBe('added');
      const before = await atomCount(service);

      const second = await service.writeNote(text);
      expect(second.decision).toBe('noop');
      expect(second.noteId).toBe(first.noteId);
      expect(second.atomIds).toEqual([]);
      expect(await atomCount(service)).toBe(before);

      const audit = await service.audit(10);
      expect(audit.some((entry) => entry.kind === 'write_noop')).toBe(true);
      const stats = await service.stats('project');
      expect(stats.notes).toBe(1);
    });
  });

  it('treats the same terms in another order as the same note', async () => {
    await withService(async (service) => {
      const first = await service.writeNote('cache ttl entries 30 second');
      const second = await service.writeNote('30 second cache ttl entries');
      expect(second.decision).toBe('noop');
      expect(second.noteId).toBe(first.noteId);
      expect(await atomCount(service)).toBe(1);
    });
  });

  it('records the discarded body so a merge is recoverable from the audit log', async () => {
    await withService(async (service) => {
      const first = await service.writeNote('the cache holds the index');
      const second = await service.writeNote('the index holds the cache');
      expect(second.decision).toBe('noop');

      const audit = await service.audit(5);
      const entry = audit.find((item) => item.kind === 'write_noop');
      expect(entry?.detail['noteId']).toBe(first.noteId);
      expect(entry?.detail['discarded']).toBe('the index holds the cache');
    });
  });

  it('keeps unrelated notes apart', async () => {
    await withService(async (service) => {
      const first = await service.writeNote('the cache layer sets a 30 second ttl on entries');
      const second = await service.writeNote('the billing invoice proration rounds down');
      expect(first.decision).toBe('added');
      expect(second.decision).toBe('added');
      expect(second.noteId).not.toBe(first.noteId);
      expect(await atomCount(service)).toBe(2);
    });
  });

  it('does not grow the atom count when the same note is written repeatedly', async () => {
    await withService(async (service) => {
      const text = 'the deploy rollout pauses on error rates';
      let peak = 0;
      for (let index = 0; index < 8; index += 1) {
        await service.writeNote(text);
        peak = Math.max(peak, await atomCount(service));
      }
      expect(peak).toBe(1);
      expect((await service.stats('project')).notes).toBe(1);
    });
  });

  it('does not supersede an atom when the same note is written again', async () => {
    await withService(async (service) => {
      const text = 'the cache ttl is 30 seconds';
      const first = await service.writeNote(text);
      const second = await service.writeNote(text);
      expect(second.decision).toBe('noop');
      const stats = await service.stats('project');
      expect(stats.suppressed).toBe(0);
      const recalled = await service.recall({
        cue: 'cache ttl',
        limit: 5,
        maxTokens: undefined,
        includeHistory: false,
      });
      expect(recalled.items.map((item) => item.noteId)).toContain(first.noteId);
    });
  });
});
