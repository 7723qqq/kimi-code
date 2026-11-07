import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryRepo } from '#/app/memory/memoryRepo';
import { HostProcessService } from '#/os/backends/host/hostProcessService';
import type { IHostProcessService } from '#/os/interface/hostProcess';

async function makeRepo(): Promise<{
  repo: MemoryRepo;
  homeDir: string;
  memoryDir: string;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), 'memoryrepo-'));
  const memoryDir = join(homeDir, 'memory');
  await mkdir(memoryDir, { recursive: true });
  const process = new HostProcessService();
  const repo = new MemoryRepo(
    process as unknown as IHostProcessService,
    { homeDir } as never,
    { debug() {}, warn() {}, error() {}, info() {} } as never,
  );
  return { repo, homeDir, memoryDir };
}

describe('memory repo', () => {
  it('commits a written memory and lists the commit', async () => {
    const { repo, memoryDir } = await makeRepo();
    await writeFile(join(memoryDir, 'note.md'), '# note\n', 'utf-8');
    expect(await repo.commit('remember: note')).toBe(true);
    const commits = await repo.logCommits(5);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.message).toBe('remember: note');
    expect(commits[0]?.sha.length).toBe(40);
  });

  it('maps every touched path to its newest commit in one call', async () => {
    const { repo, memoryDir } = await makeRepo();
    await writeFile(join(memoryDir, 'alpha.md'), 'first', 'utf-8');
    await writeFile(join(memoryDir, 'beta.md'), 'other', 'utf-8');
    expect(await repo.commit('remember: alpha and beta')).toBe(true);
    const first = await repo.recentCommitShas(20);
    const alphaFirst = first.get('alpha.md');
    const betaFirst = first.get('beta.md');
    expect(alphaFirst?.length).toBe(40);
    expect(betaFirst).toBe(alphaFirst);

    await writeFile(join(memoryDir, 'alpha.md'), 'second', 'utf-8');
    expect(await repo.commit('remember: alpha again')).toBe(true);
    const second = await repo.recentCommitShas(20);
    expect(second.get('alpha.md')).not.toBe(alphaFirst);
    expect(second.get('beta.md')).toBe(betaFirst);
  });

  it('reverts a commit and restores the previous content', async () => {
    const { repo, memoryDir } = await makeRepo();
    await writeFile(join(memoryDir, 'note.md'), 'first\n', 'utf-8');
    await repo.commit('remember: first');
    await writeFile(join(memoryDir, 'note.md'), 'second\n', 'utf-8');
    await repo.commit('remember: second');
    expect((await readFile(join(memoryDir, 'note.md'), 'utf-8')).trim()).toBe('second');

    const commits = await repo.logCommits(10);
    const second = commits.find((c) => c.message === 'remember: second');
    expect(await repo.revert(second!.sha)).toBe(true);
    expect((await readFile(join(memoryDir, 'note.md'), 'utf-8')).trim()).toBe('first');
  });

  it('reports a failed revert without throwing', async () => {
    const { repo } = await makeRepo();
    await repo.commit('remember: something');
    expect(await repo.revert('0'.repeat(40))).toBe(false);
  });

  it('serialises concurrent commits', async () => {
    const { repo, memoryDir } = await makeRepo();
    await writeFile(join(memoryDir, 'note.md'), 'x\n', 'utf-8');
    const results = await Promise.all([repo.commit('remember: one'), repo.commit('remember: two')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const commits = await repo.logCommits(10);
    expect(commits).toHaveLength(1);
  });
});
