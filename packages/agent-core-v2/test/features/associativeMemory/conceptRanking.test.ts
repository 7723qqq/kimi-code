import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import type { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { buildEvalService } from './eval-corpus';

const CLUSTERS: readonly (readonly [string, readonly string[]])[] = [
  [
    'deploy',
    [
      'the rollout pauses when error rates climb',
      'the artifact is signed before promotion',
      'the canary slice takes one percent traffic',
      'the promotion window closes on friday',
    ],
  ],
  [
    'billing',
    [
      'the invoice rounds the prorated amount',
      'the charge retries on card decline',
      'the refund posts within five days',
      'the ledger reconciles at midnight',
    ],
  ],
  [
    'search',
    [
      'the shard splits by tenant id',
      'the index rebuilds offline nightly',
      'the query planner prefers the small shard',
      'the snippet highlights matched tokens',
    ],
  ],
];

const CUES = [
  'rollout artifact canary promotion',
  'invoice charge refund ledger',
  'shard index query snippet',
];

const TOP_N = 5;

async function withService<T>(task: (service: AssociativeMemoryService) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-ranking-'));
  const service = buildEvalService(homeDir);
  try {
    return await task(service);
  } finally {
    service.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

describe('associative memory concept ranking', () => {
  it('keeps the concept inside the top results for a cue spread across members', async () => {
    await withService(async (service) => {
      for (const [, notes] of CLUSTERS) for (const note of notes) await service.writeNote(note);
      for (let round = 0; round < 4; round += 1) {
        for (const cue of CUES) {
          await service.recall({
            cue,
            limit: 8,
            maxTokens: undefined,
            includeHistory: false,
            reinforce: true,
          });
        }
      }
      expect((await service.stats('project')).concepts).toBeGreaterThan(0);

      for (const cue of CUES) {
        const recalled = await service.recall({
          cue,
          limit: TOP_N,
          maxTokens: undefined,
          includeHistory: false,
        });
        expect(recalled.items.map((item) => item.kind)).toContain('concept');
      }
    });
  });

  it('keeps the concept reachable when the cue matches a single member', async () => {
    await withService(async (service) => {
      for (const [, notes] of CLUSTERS) for (const note of notes) await service.writeNote(note);
      for (let round = 0; round < 4; round += 1) {
        for (const cue of CUES) {
          await service.recall({
            cue,
            limit: 8,
            maxTokens: undefined,
            includeHistory: false,
            reinforce: true,
          });
        }
      }
      const recalled = await service.recall({
        cue: 'canary slice',
        limit: 5,
        maxTokens: undefined,
        includeHistory: false,
      });
      expect(recalled.items.length).toBeGreaterThan(0);
      expect(recalled.items[0]?.kind).toBe('atom');
    });
  });
});
