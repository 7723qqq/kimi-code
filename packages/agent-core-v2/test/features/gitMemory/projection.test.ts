import { describe, expect, it } from 'bun:test';

import { projectFileBlock, projectRepoBlock, projectSignalBlock } from '#/features/gitMemory/projection';
import type { CommitRecord } from '#/features/gitMemory/types';

function commit(sha: string, files: string[]): CommitRecord {
  return {
    sha,
    date: '2026-10-30',
    author: 'luozihao',
    subject: 'refactor(tui): move panel toggling out of the editor',
    files,
  };
}

describe('projection', () => {
  it('renders sha, date, author, subject and the path list', () => {
    const block = projectRepoBlock([commit('a'.repeat(40), ['apps/tui/a.ts'])]);
    expect(block.startsWith('<repo-memory>')).toBe(true);
    expect(block.endsWith('</repo-memory>')).toBe(true);
    expect(block).toContain(`Commit ${'a'.repeat(7)} 2026-10-30 luozihao`);
    expect(block).toContain('refactor(tui): move panel toggling out of the editor');
    expect(block).toContain('apps/tui/a.ts');
  });

  it('emits no computed count for a commit that touched several files', () => {
    const block = projectRepoBlock([commit('a'.repeat(40), ['a.ts', 'b.ts', 'c.ts'])]);
    expect(block).not.toContain('3 files');
    expect(block).not.toContain('3 个');
    expect(block).not.toMatch(/\b\d+\s+files\b/);
  });

  it('emits no imperative conclusion', () => {
    const block = projectRepoBlock([commit('a'.repeat(40), ['a.ts'])]);
    expect(block.toLowerCase()).not.toContain('must');
    expect(block.toLowerCase()).not.toContain('should');
    expect(block.toLowerCase()).not.toContain('you need to');
  });

  it('omits the path list and the count for a bulk commit', () => {
    const many = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
    const block = projectRepoBlock([commit('a'.repeat(40), many)]);
    expect(block).toContain('Commit aaaaaaa 2026-10-30 luozihao');
    expect(block).toContain('refactor(tui): move panel toggling out of the editor');
    expect(block).not.toContain('f0.ts');
    expect(block).not.toMatch(/\b\d+\s+files\b/);
  });

  it('renders the same records to the same bytes', () => {
    const records = [commit('a'.repeat(40), ['a.ts']), commit('b'.repeat(40), ['b.ts'])];
    expect(projectRepoBlock(records)).toBe(projectRepoBlock(records));
  });

  it('renders a file block and a signal block', () => {
    const records = [commit('a'.repeat(40), ['a.ts'])];
    expect(projectFileBlock('a.ts', records, new Set())).toContain('<file-memory path="a.ts">');
    expect(projectSignalBlock('a.ts', records, new Set())).toContain('<repo-memory signal="a.ts">');
  });

  it('points at an already rendered commit instead of repeating it', () => {
    const records = [commit('a'.repeat(40), ['a.ts'])];
    const seen = new Set([records[0]!.sha]);
    const block = projectFileBlock('b.ts', records, seen);
    expect(block).toContain('see commit aaaaaaa above');
    expect(block).not.toContain('refactor(tui): move panel');
  });

  it('imports no provider, model client or agent runtime', async () => {
    const source = await Bun.file(
      new URL('../../../src/features/gitMemory/projection.ts', import.meta.url),
    ).text();
    expect(source).not.toMatch(/llm-adapter|provider|model-requester|agentRuntime/i);
  });
});
