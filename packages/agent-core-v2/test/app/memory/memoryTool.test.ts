import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryRepo } from '#/app/memory/memoryRepo';
import { MemoryTool } from '#/app/memory/tools/memoryTool';
import { HostProcessService } from '#/os/backends/host/hostProcessService';
import type { IHostProcessService } from '#/os/interface/hostProcess';

const SHA_A = 'a'.repeat(40);

function makeTool(homeDir: string, flagOn: boolean, repo: MemoryRepo) {
  const store = {
    list: async () => [] as string[],
    get: async () => undefined,
    put: async () => undefined,
  };
  return new MemoryTool(
    store as never,
    { cwd: homeDir } as never,
    { agentId: 'main' } as never,
    { homeDir } as never,
    repo,
    { enabled: () => flagOn } as never,
    new HostProcessService() as unknown as IHostProcessService,
  );
}

describe('memory tool audit loop', () => {
  it('writes, commits, lists and reverts a memory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'memorytool-'));
    const repo = new MemoryRepo(
      new HostProcessService() as unknown as IHostProcessService,
      { homeDir } as never,
      { debug() {}, warn() {}, error() {}, info() {} } as never,
    );
    const { mkdir, writeFile } = await import('node:fs/promises');
    const memoryDir = join(homeDir, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, 'seed.md'), '# seed\n', 'utf-8');
    await repo.commit('remember: seed');
    const [seed] = await repo.logCommits(1);

    const tool = makeTool(homeDir, true, repo);
    const written = await tool.resolveExecution({
      action: 'write',
      path: 'note.md',
      scope: 'global',
      content: `# note\n\nderived from ${seed!.sha}`,
    }).execute({} as never);
    expect(written.isError).toBeFalsy();
    expect(written.output).toContain('commit:');

    const commits = await repo.logCommits(10);
    expect(commits.some((c) => c.message === 'remember: note')).toBe(true);

    const logged = await tool.resolveExecution({ action: 'log' }).execute({} as never);
    expect(logged.output).toContain('remember: note');

    const target = commits.find((c) => c.message === 'remember: note');
    const reverted = await tool
      .resolveExecution({ action: 'revert', sha: target!.sha })
      .execute({} as never);
    expect(reverted.isError).toBeFalsy();
    const after = await repo.logCommits(10);
    expect(after.some((c) => c.message.startsWith('Revert'))).toBe(true);
  });

  it('refuses a write that references no existing git object', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'memorytool-'));
    const repo = new MemoryRepo(
      new HostProcessService() as unknown as IHostProcessService,
      { homeDir } as never,
      { debug() {}, warn() {}, error() {}, info() {} } as never,
    );
    const tool = makeTool(homeDir, true, repo);
    const result = await tool
      .resolveExecution({
        action: 'write',
        path: 'note.md',
        scope: 'global',
        content: '# note\n\nno reference here',
      })
      .execute({} as never);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('must reference an existing git commit sha');
  });

  it('keeps the pre-flag behaviour when the flag is off', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'memorytool-'));
    const repo = new MemoryRepo(
      new HostProcessService() as unknown as IHostProcessService,
      { homeDir } as never,
      { debug() {}, warn() {}, error() {}, info() {} } as never,
    );
    const tool = makeTool(homeDir, false, repo);
    const result = await tool
      .resolveExecution({
        action: 'write',
        path: 'note.md',
        scope: 'global',
        content: '# note\n\nfree prose without any reference',
      })
      .execute({} as never);
    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain('commit:');
    expect(await repo.logCommits(5)).toHaveLength(0);
  });
});
