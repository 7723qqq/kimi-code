import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import type { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { buildEvalService } from './eval-corpus';

const runbook = (suffix: string): string =>
  [
    `step one alpha performs the ${suffix} release`,
    'step two beta verifies the artifact',
    'step three gamma promotes the build',
  ].join('\n\n');

async function withService<T>(task: (service: AssociativeMemoryService) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-procedure-'));
  const service = buildEvalService(homeDir);
  try {
    return await task(service);
  } finally {
    service.dispose();
    await rm(homeDir, { recursive: true, force: true });
  }
}

describe('associative memory procedure formation', () => {
  it('recognises the same ordered runbook written more than once', async () => {
    await withService(async (service) => {
      await service.writeNote(runbook('first'));
      expect((await service.stats('project')).procedures).toBe(0);
      await service.writeNote(runbook('second'));

      const stats = await service.stats('project');
      expect(stats.procedures).toBeGreaterThan(0);

      const listed = await service.list({ kind: 'procedure', limit: 5, scope: 'project' });
      expect(listed.procedures.length).toBeGreaterThan(0);
      expect(listed.procedures[0]!.stepIds.length).toBe(3);
    });
  });

  it('keeps the steps in the order they were written', async () => {
    await withService(async (service) => {
      await service.writeNote(runbook('first'));
      await service.writeNote(runbook('second'));
      const listed = await service.list({ kind: 'procedure', limit: 5, scope: 'project' });
      const atoms = await service.list({ kind: 'atom', limit: 50, scope: 'project' });
      const textById = new Map(atoms.atoms.map((atom) => [atom.id, atom.text]));
      const steps = (listed.procedures[0]?.stepIds ?? []).map((id) => textById.get(id) ?? '');
      expect(steps[0]).toContain('step one');
      expect(steps[1]).toContain('step two');
      expect(steps[2]).toContain('step three');
    });
  });

  it('surfaces the procedure during recall', async () => {
    await withService(async (service) => {
      await service.writeNote(runbook('first'));
      await service.writeNote(runbook('second'));
      const recalled = await service.recall({
        cue: 'release artifact build',
        limit: 8,
        maxTokens: undefined,
        includeHistory: false,
      });
      expect(recalled.items.map((item) => item.kind)).toContain('procedure');
    });
  });

  it('does not form a procedure from a single occurrence', async () => {
    await withService(async (service) => {
      await service.writeNote(runbook('only'));
      expect((await service.stats('project')).procedures).toBe(0);
    });
  });
});
