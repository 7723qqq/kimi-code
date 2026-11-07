import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import type { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { buildEvalService } from './eval-corpus';

const TEXT = 'the cache layer sets a 30 second ttl on entries';

async function withDir<T>(task: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-index-'));
  try {
    return await task(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function firstAtomText(service: AssociativeMemoryService): Promise<string | undefined> {
  const listed = await service.list({ kind: 'atom', limit: 5, scope: 'project' });
  return listed.atoms[0]?.text;
}

describe('associative memory atom index', () => {
  it('keeps atom text resolvable after a rebuild and a reopen', async () => {
    await withDir(async (homeDir) => {
      const service = buildEvalService(homeDir);
      try {
        await service.writeNote(TEXT);
        await service.rebuild();
        expect(await firstAtomText(service)).toBe(TEXT);
      } finally {
        service.dispose();
      }

      const reopened = buildEvalService(homeDir);
      try {
        expect(await firstAtomText(reopened)).toBe(TEXT);
      } finally {
        reopened.dispose();
      }
    });
  });

  it('resolves multi atom notes to their own slices', async () => {
    await withDir(async (homeDir) => {
      const service = buildEvalService(homeDir);
      try {
        await service.writeNote('# Title\nfirst paragraph\n\nsecond paragraph');
        const listed = await service.list({ kind: 'atom', limit: 10, scope: 'project' });
        expect(listed.atoms).toHaveLength(2);
        expect(listed.atoms[0]?.text).toBe('# Title\nfirst paragraph');
        expect(listed.atoms[1]?.text).toBe('second paragraph');
      } finally {
        service.dispose();
      }
    });
  });

});
