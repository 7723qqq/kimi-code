import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import type { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { resetRendered } from '#/agent/injection/renderedLines';

import { buildEvalService } from './eval-corpus';

async function withService<T>(task: (service: AssociativeMemoryService) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-injection-'));
  const service = buildEvalService(homeDir);
  try {
    return await task(service);
  } finally {
    service.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

describe('associative memory injection', () => {
  it('does not repeat the same line twice in a row', async () => {
    resetRendered();
    await withService(async (service) => {
      await service.writeNote('the cache layer sets a 30 second ttl on entries');
      expect((await service.signalBlock('cache ttl')).length).toBeGreaterThan(0);
      expect(await service.signalBlock('cache ttl')).toBe('');
    });
  });

  it('does not let one agent suppress another agent in the same process', async () => {
    const a = await mkdtemp(join(os.tmpdir(), 'associative-a-'));
    const b = await mkdtemp(join(os.tmpdir(), 'associative-b-'));
    const serviceA = buildEvalService(a);
    const serviceB = buildEvalService(b);
    try {
      const note = 'the cache layer sets a 30 second ttl on entries';
      await serviceA.writeNote(note);
      await serviceB.writeNote(note);
      expect((await serviceA.signalBlock('cache ttl')).length).toBeGreaterThan(0);
      expect((await serviceB.signalBlock('cache ttl')).length).toBeGreaterThan(0);
    } finally {
      serviceA.dispose();
      serviceB.dispose();
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });

  it('stays silent when nothing matches the cue', async () => {
    await withService(async (service) => {
      await service.writeNote('the cache layer sets a 30 second ttl on entries');
      expect(await service.signalBlock('quarterly hiring plan')).toBe('');
    });
  });
});
