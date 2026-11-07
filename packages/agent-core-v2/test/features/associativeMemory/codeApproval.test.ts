import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import type { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { buildEvalService } from './eval-corpus';

async function withService<T>(task: (service: AssociativeMemoryService) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-approval-'));
  const service = buildEvalService(homeDir);
  try {
    return await task(service);
  } finally {
    service.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

const PROPOSAL = {
  id: 'no-internal-host',
  pattern: 'internal-host',
  regex: false,
  action: 'block_write',
  scope: 'note',
  reason: 'internal host leak',
};

describe('associative memory code approval', () => {
  it('approves the very first proposal when no code file exists yet', async () => {
    await withService(async (service) => {
      await service.proposeRule(PROPOSAL);
      const approved = await service.approveProposal(0);
      expect(approved.id).toBe('no-internal-host');
    });
  });

  it('enforces an approved rule on later writes', async () => {
    await withService(async (service) => {
      await service.proposeRule(PROPOSAL);
      await service.approveProposal(0);
      const blocked = await service.writeNote('the internal-host value is 10.0.0.5');
      expect(blocked.blockedByCode).toBe(true);
      const allowed = await service.writeNote('the public docs live on example.com');
      expect(allowed.blockedByCode).toBe(false);
    });
  });

  it('records both the proposal and the approval in the audit log', async () => {
    await withService(async (service) => {
      await service.proposeRule(PROPOSAL);
      await service.approveProposal(0);
      const kinds = new Set((await service.audit(20)).map((entry) => entry.kind));
      expect(kinds.has('code_proposed')).toBe(true);
      expect(kinds.has('code_approved')).toBe(true);
    });
  });

  it('drops the stale recall target after a rebuild', async () => {
    await withService(async (service) => {
      await service.writeNote('the cache layer sets a 30 second ttl on entries');
      await service.recall({
        cue: 'cache ttl',
        limit: 5,
        maxTokens: undefined,
        includeHistory: false,
      });
      await service.rebuild('project');
      const result = await service.reconsolidate(undefined, 'the cache layer sets a 60 second ttl');
      expect(result.noteId).toBe('');
      expect(result.atomIds).toEqual([]);
    });
  });
});
