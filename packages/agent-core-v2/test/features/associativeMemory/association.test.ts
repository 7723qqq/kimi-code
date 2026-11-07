import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import type { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { buildEvalService } from './eval-corpus';

async function withService<T>(task: (service: AssociativeMemoryService) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-link-'));
  const service = buildEvalService(homeDir);
  try {
    return await task(service);
  } finally {
    service.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

const query = (cue: string) => ({
  cue,
  limit: 8,
  maxTokens: undefined,
  includeHistory: false,
});

describe('associative memory linking', () => {
  it('recalls a memory that shares no term with the cue, through one bridge', async () => {
    await withService(async (service) => {
      await service.writeNote('the retention policy keeps logs for ninety days');
      await service.writeNote('the retention policy is audited quarterly by compliance');
      await service.writeNote('compliance asks for the audit trail export');

      const recalled = await service.recall(query('ninety days'));
      const texts = recalled.items.map((item) => item.text);
      expect(texts.some((text) => text.includes('keeps logs'))).toBe(true);
      expect(texts.some((text) => text.includes('audit trail export'))).toBe(true);
    });
  });

  it('does not link two memories that only share a stop word', async () => {
    await withService(async (service) => {
      await service.writeNote('the alpha');
      await service.writeNote('the beta');
      const stats = await service.stats('project');
      expect(stats.atoms).toBe(2);
      expect(stats.edges).toBe(0);
    });
  });

  it('links two memories that share a content term through a prefix', async () => {
    await withService(async (service) => {
      await service.writeNote('the deploy pipeline signs the artifact');
      await service.writeNote('deployment signing happens before promotion');
      const stats = await service.stats('project');
      expect(stats.edges).toBeGreaterThan(0);
    });
  });

  it('spreads from an older memory towards a newer one', async () => {
    await withService(async (service) => {
      await service.writeNote('the cache ttl resets on restart');
      await service.writeNote('the cache ttl is documented in the runbook');

      const recalled = await service.recall(query('cache ttl'));
      expect(recalled.items.length).toBe(2);
    });
  });
});
