import { isAbsolute, relative, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IAgentFileSystem } from '#/agentFs';
import { IFsService } from '#/agentFs/fs';
import { FsService } from '#/agentFs/fsService';
import { IProcessRunner, type IProcess } from '#/process';
import { IWorkspaceContext } from '#/workspaceContext';

const WORK_DIR = '/repo';

function stubWorkspace(): IWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir: WORK_DIR,
    additionalDirs: [],
    setWorkDir: () => {},
    resolve: (rel) => (isAbsolute(rel) ? rel : resolve(WORK_DIR, rel)),
    isWithin: (abs) => {
      const r = relative(WORK_DIR, abs);
      return r === '' || (!r.startsWith('..') && !isAbsolute(r));
    },
    assertAllowed: (abs) => abs,
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  };
}

function fakeFs(files: Record<string, string>): IAgentFileSystem {
  const fileMap = new Map(Object.entries(files));
  const dirSet = new Set<string>(['']);
  for (const p of fileMap.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(parts.slice(0, i).join('/'));
    }
  }
  return {
    _serviceBrand: undefined,
    cwd: WORK_DIR,
    readText: async (p) => {
      const c = fileMap.get(p);
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    },
    writeText: async () => {},
    readBytes: async () => new Uint8Array(),
    writeBytes: async () => {},
    stat: async (p) => {
      if (fileMap.has(p)) {
        return { isFile: true, isDirectory: false, size: fileMap.get(p)!.length };
      }
      if (dirSet.has(p)) return { isFile: false, isDirectory: true, size: 0 };
      throw new Error(`ENOENT: ${p}`);
    },
    readdir: async (p) => {
      const prefix = p === '.' || p === '' ? '' : `${p}/`;
      const children = new Set<string>();
      for (const f of fileMap.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first !== undefined && first.length > 0) children.add(first);
      }
      return [...children];
    },
    glob: async () => [],
    mkdir: async () => {},
    withCwd: () => {
      throw new Error('not implemented');
    },
  };
}

function fakeProcess(stdout: string, stderr: string, exitCode: number): IProcess {
  return {
    stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
    stdout: Readable.from([stdout]),
    stderr: Readable.from([stderr]),
    pid: 1,
    wait: () => Promise.resolve(exitCode),
    kill: () => Promise.resolve(),
  };
}

type RunHandler = (args: readonly string[]) => {
  stdout: string;
  stderr?: string;
  exitCode: number;
};

function fakeRunner(handler: RunHandler): IProcessRunner {
  return {
    _serviceBrand: undefined,
    exec: async (args) => {
      const r = handler(args);
      return fakeProcess(r.stdout, r.stderr ?? '', r.exitCode);
    },
  };
}

beforeEach(() => {
  _clearScopedRegistryForTests();
  registerScopedService(
    LifecycleScope.Session,
    IFsService,
    FsService,
    InstantiationType.Delayed,
    'agentFs',
  );
});

let host: ReturnType<typeof createScopedTestHost> | undefined;

afterEach(() => {
  host?.dispose();
  host = undefined;
});

function makeSession(files: Record<string, string>, handler: RunHandler): IFsService {
  host = createScopedTestHost();
  const session = host.child(LifecycleScope.Session, 's1', [
    stubPair(IWorkspaceContext, stubWorkspace()),
    stubPair(IAgentFileSystem, fakeFs(files)),
    stubPair(IProcessRunner, fakeRunner(handler)),
  ]);
  return session.accessor.get(IFsService);
}

const emptyHandler: RunHandler = () => ({ stdout: '', exitCode: 0 });

describe('FsService.gitStatus', () => {
  it('returns branch, entries, numstat, and null pull request', async () => {
    const fs = makeSession({}, (args) => {
      const cmd = args.join(' ');
      if (cmd.includes('--is-inside-work-tree')) return { stdout: 'true\n', exitCode: 0 };
      if (cmd.includes('status --porcelain')) {
        return { stdout: '## main...origin/main\n M src/a.ts\n', exitCode: 0 };
      }
      if (cmd.includes('--verify') && cmd.includes('HEAD')) return { stdout: '', exitCode: 0 };
      if (cmd.includes('--numstat')) return { stdout: '3\t1\tsrc/a.ts\n', exitCode: 0 };
      if (args[0] === 'gh') return { stdout: '', exitCode: 1 };
      return { stdout: '', exitCode: 0 };
    });
    const result = await fs.gitStatus({});
    expect(result.branch).toBe('main');
    expect(result.entries).toEqual({ 'src/a.ts': 'modified' });
    expect(result.additions).toBe(3);
    expect(result.deletions).toBe(1);
    expect(result.pullRequest).toBeNull();
  });

  it('throws FS_GIT_UNAVAILABLE when not a git repo', async () => {
    const fs = makeSession({}, () => ({
      stdout: '',
      stderr: 'not a git repository',
      exitCode: 128,
    }));
    await expect(fs.gitStatus({})).rejects.toMatchObject({ code: 'fs.git_unavailable' });
  });
});

describe('FsService.diff', () => {
  it('returns the unified diff for a tracked file', async () => {
    const fs = makeSession({ 'src/a.ts': 'content' }, (args) => {
      const cmd = args.join(' ');
      if (cmd.includes('--is-inside-work-tree')) return { stdout: 'true\n', exitCode: 0 };
      if (cmd.includes('status --porcelain')) return { stdout: ' M src/a.ts\n', exitCode: 0 };
      if (cmd.includes('--verify') && cmd.includes('HEAD')) return { stdout: '', exitCode: 0 };
      if (cmd.includes('diff') && cmd.includes('HEAD')) {
        return { stdout: '-old\n+new\n', exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    });
    const result = await fs.diff({ path: 'src/a.ts' });
    expect(result.path).toBe('src/a.ts');
    expect(result.diff).toContain('+new');
    expect(result.truncated).toBe(false);
  });

  it('rejects paths that escape the workspace', async () => {
    const fs = makeSession({}, emptyHandler);
    await expect(fs.diff({ path: '../etc/passwd' })).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
  });
});

describe('FsService.search', () => {
  it('finds files by fuzzy query and respects the result cap', async () => {
    const fs = makeSession(
      { 'src/foo.ts': '', 'src/bar.ts': '', 'README.md': '' },
      emptyHandler,
    );
    const result = await fs.search({ query: 'foo', limit: 50, follow_gitignore: false });
    const paths = result.items.map((i) => i.path);
    expect(paths).toContain('src/foo.ts');
    expect(paths).not.toContain('src/bar.ts');
  });
});

describe('FsService.grep', () => {
  it('falls back to the node implementation when rg is unavailable', async () => {
    const fs = makeSession(
      { 'src/a.ts': 'hello world\nfoo bar\nhello again\n' },
      (args) => {
        if (args[0] === 'rg' && args[1] === '--version') return { stdout: '', exitCode: 1 };
        return { stdout: '', exitCode: 0 };
      },
    );
    const result = await fs.grep({
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: false,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.matches).toHaveLength(2);
  });

  it('uses rg when available and parses its JSON output', async () => {
    const rgJson = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'src/a.ts' } } }),
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'src/a.ts' },
          lines: { text: 'hello world\n' },
          line_number: 1,
          submatches: [{ start: 0, end: 5 }],
        },
      }),
      JSON.stringify({ type: 'end', data: { path: { text: 'src/a.ts' } } }),
      '',
    ].join('\n');
    const fs = makeSession({}, (args) => {
      if (args[0] === 'rg' && args[1] === '--version') {
        return { stdout: 'ripgrep 14.1.0', exitCode: 0 };
      }
      if (args[0] === 'rg' && args.includes('--json')) return { stdout: rgJson, exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    });
    const result = await fs.grep({
      pattern: 'hello',
      regex: false,
      case_sensitive: true,
      follow_gitignore: true,
      max_files: 200,
      max_matches_per_file: 50,
      max_total_matches: 5000,
      context_lines: 0,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.matches[0]?.text).toBe('hello world');
  });
});
