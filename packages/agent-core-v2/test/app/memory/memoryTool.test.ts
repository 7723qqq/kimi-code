import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getLocale, setLocale } from '@moonshot-ai/kimi-i18n';

import { MemoryRepo } from '#/app/memory/memoryRepo';
import { legacyProjectIdFromCwd, projectIdFromCwd } from '#/app/memory/memoryPaths';
import { MemoryTool, type MemoryToolInput } from '#/app/memory/tools/memoryTool';
import { HostProcessService } from '#/os/backends/host/hostProcessService';
import type { IHostProcessService } from '#/os/interface/hostProcess';

const previousLocale = getLocale();
beforeAll(() => setLocale('en'));
afterAll(() => setLocale(previousLocale));

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
    reconcile: async () => {},
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

  it('caps how many candidate references it resolves', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'memorytool-'));
    let spawned = 0;
    const process = {
      spawn: async () => {
        spawned += 1;
        return {
          pid: 1,
          stdin: { end() {} },
          stdout: (async function* () {})(),
          wait: async () => 1,
        };
      },
    } as unknown as IHostProcessService;
    const store = {
      list: async () => [] as string[],
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
      reconcile: async () => {},
    };
    const tool = new MemoryTool(
      store as never,
      { cwd: homeDir } as never,
      { agentId: 'main' } as never,
      { homeDir } as never,
      makeRepo(homeDir),
      { enabled: () => true } as never,
      process,
    );
    const content = Array.from(
      { length: 20 },
      (_, index) => `ref ${'a'.repeat(6)}${index.toString(16).padStart(2, '0')}`,
    ).join('\n');
    const result = await run(tool, { action: 'write', path: 'note.md', scope: 'global', content });
    expect(result.isError).toBe(true);
    expect(spawned).toBeLessThanOrEqual(16);
  });

  it('deletes from the root it writes to, not one derived from the session directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'memorytool-'));
    const entry = {
      path: 'global/old-note.md',
      scope: 'global' as const,
      scopeId: '',
      type: 'note' as const,
      title: 'old',
      body: '# old',
      fingerprint: 'fp',
      updatedAt: 1,
    };
    const deleted: string[] = [];
    const store = {
      list: async () => [entry.path],
      get: async (p: string) => (p === entry.path ? entry : undefined),
      put: async () => {},
      delete: async (p: string) => {
        deleted.push(p);
      },
      reconcile: async () => {},
    };
    const tool = new MemoryTool(
      store as never,
      { cwd: homeDir } as never,
      { agentId: 'main' } as never,
      { homeDir } as never,
      makeRepo(homeDir),
      { enabled: () => false } as never,
      new HostProcessService() as unknown as IHostProcessService,
    );
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = join(homeDir, 'memory', 'global');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'old-note.md'), '# old', 'utf-8');

    const result = await run(tool, { action: 'delete', path: 'global/old-note.md' });

    expect(result.isError).toBeFalsy();
    expect(deleted).toEqual(['global/old-note.md']);
    expect(await readFile(join(dir, 'old-note.md'), 'utf-8').catch(() => null)).toBeNull();
  });

  it('moves a bucket written under the old path key onto the repository key', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const homeDir = await mkdtemp(join(tmpdir(), 'memorytool-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'memoryproject-'));
    await mkdir(join(projectDir, '.git'), { recursive: true });
    await writeFile(
      join(projectDir, '.git', 'config'),
      '[remote "origin"]\n\turl = git@example.com:team/repo.git\n',
      'utf-8',
    );
    const legacy = legacyProjectIdFromCwd(projectDir);
    const next = projectIdFromCwd(projectDir);
    expect(legacy).not.toBe(next);

    const legacyDir = join(homeDir, 'memory', 'projects', legacy);
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'note.md'), '# note', 'utf-8');

    let reconciled = 0;
    const store = {
      list: async () => [] as string[],
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
      reconcile: async () => {
        reconciled += 1;
      },
    };
    const tool = new MemoryTool(
      store as never,
      { cwd: projectDir } as never,
      { agentId: 'main' } as never,
      { homeDir } as never,
      makeRepo(homeDir),
      { enabled: () => false } as never,
      new HostProcessService() as unknown as IHostProcessService,
    );

    await run(tool, { action: 'list' });

    expect(reconciled).toBe(1);
    expect(
      await readFile(join(homeDir, 'memory', 'projects', next, 'note.md'), 'utf-8'),
    ).toBe('# note');
    expect(await readFile(join(legacyDir, 'note.md'), 'utf-8').catch(() => null)).toBeNull();
  });
});
