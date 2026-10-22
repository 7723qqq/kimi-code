import { describe, expect, it, mock } from 'bun:test';
import { join } from 'node:path';

import {
  createGitStatusCache,
  formatGitBadge,
  type GitCommandOptions,
  type GitCommandResult,
  type GitStatusDeps,
} from '#/utils/git/git-status';

const START_MS = Date.parse('2026-04-24T00:00:00Z');
const REPO_DIR = '/tmp/repo';
const GIT = '/usr/bin/git';
const GH = '/usr/bin/gh';
const DEFAULT_GIT_DIR = 'C:/repo/.git';

interface CommandCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: GitCommandOptions;
}

interface FakeWatcher {
  closed: boolean;
  close(): Promise<void>;
  emit(): void;
}

interface GitScript {
  readonly gitDir?: string | null;
  readonly status?: string | null;
  readonly diff?: string | null;
  readonly gh?: string | null;
  readonly ghThrows?: boolean;
  readonly holdStatus?: boolean;
}

interface FakeGitOptions {
  readonly script?: GitScript;
  readonly resolveCommand?: (command: string, cwd: string) => string | undefined;
}

interface FakeGit {
  readonly deps: Partial<GitStatusDeps>;
  readonly calls: CommandCall[];
  readonly watchers: FakeWatcher[];
  readonly watchCalls: string[];
  setNow(nowMs: number): void;
  setScript(script: GitScript): void;
  releaseStatus(stdout: string | null): void;
}

function gitCalls(calls: readonly CommandCall[], subcommand: string): CommandCall[] {
  return calls.filter(
    (call) => call.command === GIT && call.args.some((arg) => arg === subcommand),
  );
}

function createFakeGit(options: FakeGitOptions = {}): FakeGit {
  let script: GitScript = options.script ?? {};
  let nowMs = START_MS;
  let releaseStatus: (stdout: string | null) => void = () => {};
  const calls: CommandCall[] = [];
  const watchers: FakeWatcher[] = [];
  const watchCalls: string[] = [];

  function respondGit(args: readonly string[]): Promise<GitCommandResult | null> {
    if (args.some((arg) => arg === 'rev-parse')) {
      if (script.gitDir === null) return Promise.resolve({ code: 128, stdout: '' });
      return Promise.resolve({ code: 0, stdout: `${script.gitDir ?? DEFAULT_GIT_DIR}\n` });
    }
    if (args.some((arg) => arg === 'status')) {
      if (script.holdStatus === true) {
        return new Promise((resolve) => {
          releaseStatus = (stdout) => {
            resolve(stdout === null ? { code: 1, stdout: '' } : { code: 0, stdout });
          };
        });
      }
      if (script.status === null) return Promise.resolve({ code: 1, stdout: '' });
      return Promise.resolve({ code: 0, stdout: script.status ?? '## main\n' });
    }
    if (args.some((arg) => arg === 'diff')) {
      return Promise.resolve({ code: 0, stdout: script.diff ?? '' });
    }
    return Promise.resolve({ code: 1, stdout: '' });
  }

  const deps: Partial<GitStatusDeps> = {
    now: () => nowMs,
    resolveCommand: options.resolveCommand ?? ((command) => `/usr/bin/${command}`),
    exec: (command, args, execOptions) => {
      calls.push({ command, args, options: execOptions });
      if (command === GH) {
        if (script.ghThrows === true) throw Object.assign(new Error('spawn ENOTDIR'));
        const gh = script.gh;
        if (gh === undefined || gh === null) return Promise.resolve(null);
        return Promise.resolve({ code: 0, stdout: gh });
      }
      return respondGit(args);
    },
    watch: (headPath, onChange) => {
      watchCalls.push(headPath);
      const watcher: FakeWatcher = {
        closed: false,
        close: () => {
          watcher.closed = true;
          return Promise.resolve();
        },
        emit: () => {
          onChange();
        },
      };
      watchers.push(watcher);
      return watcher;
    },
  };

  return {
    deps,
    calls,
    watchers,
    watchCalls,
    setNow: (value) => {
      nowMs = value;
    },
    setScript: (value) => {
      script = value;
    },
    releaseStatus: (stdout) => {
      releaseStatus(stdout);
    },
  };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe('git status cache', () => {
  it('reads the cache without blocking and refreshes status on a 30s TTL', async () => {
    const git = createFakeGit({
      script: {
        status: '## main...origin/main [ahead 2, behind 1]\n M src/app.ts\n',
        diff: '4\t1\tsrc/app.ts\n',
      },
    });
    const cache = createGitStatusCache(REPO_DIR, { deps: git.deps });
    expect(git.calls).toHaveLength(0);
    expect(cache.getStatus()).toBeNull();
    expect(git.calls).toHaveLength(0);

    await drain();

    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 2,
      behind: 1,
      diffAdded: 4,
      diffDeleted: 1,
      pullRequest: null,
    });
    expect(gitCalls(git.calls, 'rev-parse')).toHaveLength(1);
    expect(gitCalls(git.calls, 'status')).toHaveLength(1);
    expect(gitCalls(git.calls, 'diff')).toHaveLength(1);
    expect(gitCalls(git.calls, 'branch')).toHaveLength(0);
    expect(git.calls).toHaveLength(4);

    cache.getStatus();
    await drain();
    expect(gitCalls(git.calls, 'status')).toHaveLength(1);

    git.setNow(START_MS + 30_000);
    cache.getStatus();
    await drain();
    expect(gitCalls(git.calls, 'status')).toHaveLength(2);
    expect(gitCalls(git.calls, 'rev-parse')).toHaveLength(1);
    cache.dispose();
  });

  it('reads uncommitted diff line counts and current pull request metadata', async () => {
    const onChange = mock(() => {});
    const git = createFakeGit({
      script: {
        status: '## feature/footer...origin/feature/footer\n M src/app.ts\n',
        diff: '10\t3\tsrc/app.ts\n-\t-\timage.png\n0\t5\tdeleted.ts\n',
        gh: '{"number":12,"url":"https://github.com/acme/repo/pull/12"}\n',
      },
    });
    const cache = createGitStatusCache(REPO_DIR, { onChange, deps: git.deps });
    cache.getStatus();
    await drain();

    expect(cache.getStatus()).toEqual({
      branch: 'feature/footer',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 10,
      diffDeleted: 8,
      pullRequest: {
        number: 12,
        url: 'https://github.com/acme/repo/pull/12',
      },
    });
    expect(onChange).toHaveBeenCalled();
    cache.dispose();
  });

  it('keeps the last status when gh lookup throws synchronously', async () => {
    const onChange = mock(() => {});
    const git = createFakeGit({
      script: {
        status: '## main...origin/main\n M src/app.ts\n',
        diff: '2\t1\tsrc/app.ts\n',
        ghThrows: true,
      },
    });
    const cache = createGitStatusCache(REPO_DIR, { onChange, deps: git.deps });
    cache.getStatus();
    await drain();

    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 2,
      diffDeleted: 1,
      pullRequest: null,
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it('returns null without spawning when git cannot be resolved to a safe path', () => {
    const git = createFakeGit({ resolveCommand: () => undefined });
    const cache = createGitStatusCache(REPO_DIR, { deps: git.deps });
    expect(cache.getStatus()).toBeNull();
    expect(git.calls).toHaveLength(0);
    expect(git.watchers).toHaveLength(0);
    cache.dispose();
  });

  it('spawns git and gh through their resolved absolute paths and polls only HEAD', async () => {
    const resolveCalls: { command: string; cwd: string }[] = [];
    const git = createFakeGit({
      script: { gitDir: DEFAULT_GIT_DIR, status: '## main...origin/main\n' },
      resolveCommand: (command, cwd) => {
        resolveCalls.push({ command, cwd });
        return `/usr/bin/${command}`;
      },
    });
    const cache = createGitStatusCache(REPO_DIR, { deps: git.deps });
    expect(git.calls).toHaveLength(0);
    cache.getStatus();
    expect(git.calls).toHaveLength(0);
    await drain();

    expect(resolveCalls).toEqual([
      { command: 'git', cwd: REPO_DIR },
      { command: 'gh', cwd: REPO_DIR },
    ]);
    expect(git.calls[0]?.command).toBe(GIT);
    expect(git.calls[1]).toEqual({
      command: GIT,
      args: ['-C', REPO_DIR, 'status', '--porcelain', '-b'],
      options: expect.objectContaining({ timeout: 2_000 }),
    });
    expect(git.calls[2]?.command).toBe(GH);
    expect(git.calls[2]?.args).toEqual(['pr', 'view', '--json', 'number,url']);
    expect(git.watchers).toHaveLength(1);
    expect(git.watchCalls).toEqual([join(DEFAULT_GIT_DIR, 'HEAD')]);
    cache.dispose();
    expect(git.watchers[0]?.closed).toBe(true);
  });

  it('returns null when the working directory is not a git repo and does not probe again', async () => {
    const git = createFakeGit({ script: { gitDir: null } });
    const cache = createGitStatusCache('/tmp/not-a-repo', { deps: git.deps });
    expect(cache.getStatus()).toBeNull();
    await drain();

    expect(cache.getStatus()).toBeNull();
    expect(gitCalls(git.calls, 'rev-parse')).toHaveLength(1);
    expect(git.watchers).toHaveLength(0);
    cache.getStatus();
    cache.refresh();
    await drain();
    expect(gitCalls(git.calls, 'rev-parse')).toHaveLength(1);
    cache.dispose();
  });

  it('formats badges', () => {
    expect(
      formatGitBadge({
        branch: 'main',
        dirty: true,
        ahead: 2,
        behind: 1,
        diffAdded: 12,
        diffDeleted: 3,
        pullRequest: null,
      }),
    ).toBe('main [+12 -3 ↑2↓1]');
    expect(
      formatGitBadge({
        branch: 'main',
        dirty: true,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: null,
      }),
    ).toBe('main [±]');
  });

  it('parses an unborn branch and hides detached HEAD', async () => {
    const unbornGit = createFakeGit({ script: { status: '## No commits yet on main\n' } });
    const unborn = createGitStatusCache(REPO_DIR, { deps: unbornGit.deps });
    unborn.getStatus();
    await drain();
    expect(unborn.getStatus()?.branch).toBe('main');
    unborn.dispose();

    const detachedGit = createFakeGit({ script: { status: '## HEAD (no branch)\n' } });
    const detached = createGitStatusCache(REPO_DIR, { deps: detachedGit.deps });
    detached.getStatus();
    await drain();
    expect(detached.getStatus()).toBeNull();
    expect(gitCalls(detachedGit.calls, 'diff')).toHaveLength(0);
    detached.dispose();
  });

  it('refreshes when HEAD changes and when refresh() is called inside the TTL', async () => {
    const git = createFakeGit({ script: { status: '## main\n' } });
    const cache = createGitStatusCache(REPO_DIR, { deps: git.deps });
    cache.getStatus();
    await drain();
    expect(gitCalls(git.calls, 'status')).toHaveLength(1);

    git.watchers[0]?.emit();
    await drain();
    expect(gitCalls(git.calls, 'status')).toHaveLength(2);

    cache.refresh();
    await drain();
    expect(gitCalls(git.calls, 'status')).toHaveLength(3);
    expect(gitCalls(git.calls, 'rev-parse')).toHaveLength(1);
    cache.dispose();
  });

  it('keeps the last good status when a later status command fails', async () => {
    const git = createFakeGit({
      script: {
        status: '## main\n M src/app.ts\n',
        diff: '2\t1\tsrc/app.ts\n',
      },
    });
    const cache = createGitStatusCache(REPO_DIR, { deps: git.deps });
    cache.getStatus();
    await drain();

    git.setScript({ status: null });
    cache.refresh();
    await drain();

    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 2,
      diffDeleted: 1,
      pullRequest: null,
    });
    cache.dispose();
  });

  it('coalesces a forced refresh that arrives while one is in flight', async () => {
    const git = createFakeGit({ script: { holdStatus: true } });
    const cache = createGitStatusCache(REPO_DIR, { deps: git.deps });
    cache.getStatus();
    await drain();
    expect(gitCalls(git.calls, 'status')).toHaveLength(1);

    cache.refresh();
    cache.refresh();
    git.releaseStatus('## main\n');
    await drain();
    expect(gitCalls(git.calls, 'status')).toHaveLength(2);

    git.releaseStatus('## topic\n');
    await drain();
    expect(cache.getStatus()?.branch).toBe('topic');
    expect(gitCalls(git.calls, 'status')).toHaveLength(2);
    cache.dispose();
  });

  it('formats pull request badges as terminal hyperlinks when requested', () => {
    const linked = formatGitBadge(
      {
        branch: 'feature/footer',
        dirty: false,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: {
          number: 12,
          url: 'https://github.com/acme/repo/pull/12',
        },
      },
      { linkPullRequest: true },
    );

    expect(linked).toContain('[PR#12]');
    expect(linked).toContain('\u001B]8;;https://github.com/acme/repo/pull/12\u0007');
    expect(linked).toContain('\u001B]8;;\u0007');
  });
});
