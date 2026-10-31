import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryRepo } from '#/app/memory/memoryRepo';
import { MemoryTool, type MemoryToolInput } from '#/app/memory/tools/memoryTool';
import { HostProcessService } from '#/os/backends/host/hostProcessService';
import type { IHostProcessService } from '#/os/interface/hostProcess';

async function run(tool: MemoryTool, args: MemoryToolInput) {
  const execution = await tool.resolveExecution(args);
  if (!('execute' in execution)) throw new Error('expected a runnable execution');
  return execution.execute({} as never);
}

async function makeTool(homeDir: string, flagOn: boolean, repo: MemoryRepo) {
  const puts: { sha?: string; intent?: string; appliesTo?: readonly string[] }[] = [];
  const store = {
    list: async () => [] as string[],
    get: async () => undefined,
    put: async (entry: { sha?: string; intent?: string; appliesTo?: readonly string[] }) => {
      puts.push(entry);
    },
  };
  const tool = new MemoryTool(
    store as never,
    { cwd: homeDir } as never,
    { agentId: 'main' } as never,
    { homeDir } as never,
    repo,
    { enabled: () => flagOn } as never,
    new HostProcessService() as unknown as IHostProcessService,
  );
  return { tool, puts };
}

function makeRepo(homeDir: string) {
  return new MemoryRepo(
    new HostProcessService() as unknown as IHostProcessService,
    { homeDir } as never,
    { debug() {}, warn() {}, error() {}, info() {} } as never,
  );
}

describe('memory tool audit loop', () => {
  it('writes, commits, lists and reverts a memory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'memorytool-'));
    const repo = makeRepo(homeDir);
    const { mkdir, writeFile } = await import('node:fs/promises');
    const memoryDir = join(homeDir, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, 'seed.md'), '# seed\n', 'utf-8');
    await repo.commit('remember: seed');
    const [seed] = await repo.logCommits(1);

    const { tool, puts } = await makeTool(homeDir, true, repo);
    const written = await run(tool, {
      action: 'write',
      path: 'note.md',
      scope: 'global',
      content: `# note\n\nderived from ${seed!.sha}`,
    });
    expect(written.isError).toBeFalsy();
    expect(written.output).toContain('commit:');

    const commits = await repo.logCommits(10);
    expect(commits.some((c) => c.message === 'remember: note')).toBe(true);
    const stored = puts.at(-1);
    expect(stored?.sha).toBe(commits.find((c) => c.message === 'remember: note')?.sha);
    expect(stored?.intent).toBe('note');

    const logged = await run(tool, { action: 'log' });
    expect(logged.output).toContain('remember: note');

    const target = commits.find((c) => c.message === 'remember: note');
    const reverted = await run(tool, { action: 'revert', sha: target!.sha });
    expect(reverted.isError).toBeFalsy();
    const after = await repo.logCommits(10);
    expect(after.some((c) => c.message.startsWith('Revert'))).toBe(true);
    expect(await readFile(join(memoryDir, 'note.md'), 'utf-8').catch(() => null)).toBeNull();
  });

  it('refuses a write that references no existing git object', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'memorytool-'));
    const { tool } = await makeTool(homeDir, true, makeRepo(homeDir));
    const result = await run(tool, {
      action: 'write',
      path: 'note.md',
      scope: 'global',
      content: '# note\n\nno reference here',
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('must reference an existing git commit sha');
  });

  it('keeps the pre-flag behaviour when the flag is off', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'memorytool-'));
    const repo = makeRepo(homeDir);
    const { tool } = await makeTool(homeDir, false, repo);
    const result = await run(tool, {
      action: 'write',
      path: 'note.md',
      scope: 'global',
      content: '# note\n\nfree prose without any reference',
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).not.toContain('commit:');
    expect(await repo.logCommits(5)).toHaveLength(0);
  });
});
