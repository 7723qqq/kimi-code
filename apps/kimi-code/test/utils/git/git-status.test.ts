/* eslint-disable import/first -- jest.mock setup must run before the imports it stubs out. */
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest, vi } from 'bun:test';

const mocks = (() => ({
  exec: jest.fn(),
  resolveCommandPath: jest.fn(),
  watchers: [] as Array<{
    options: unknown;
    add: ReturnType<typeof jest.fn>;
    close: ReturnType<typeof jest.fn>;
    emit: (event: string) => void;
  }>,
}))();

jest.mock('#/utils/process/resolve-command', () => ({
  resolveCommandPath: mocks.resolveCommandPath,
}));

jest.mock('chokidar', () => {
  class FSWatcher {
    options: unknown;
    add = jest.fn();
    close = jest.fn(() => Promise.resolve());
    private listeners = new Map<string, Array<() => void>>();

    constructor(options: unknown) {
      this.options = options;
      mocks.watchers.push(this);
    }

    on(event: string, cb: () => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
      return this;
    }

    emit(event: string): void {
      for (const cb of this.listeners.get(event) ?? []) cb();
    }
  }

  return { FSWatcher };
});

import { createGitStatusCache, formatGitBadge } from '#/utils/git/git-status';

beforeEach(() => {
  mocks.resolveCommandPath.mockImplementation((command: string) => `/usr/bin/${command}`);
  mocks.watchers.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

async function drain(): Promise<void> {
  // The cache chain awaits a promise-returning `exec`, so it needs more than
  // microtask turns. `setImmediate` keeps working under `jest.useFakeTimers()`
  // (unlike a zero-delay `setTimeout`, which the fake clock swallows).
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function gitCalls(subcommand: string): unknown[][] {
  return mocks.exec.mock.calls.filter((call) => {
    const args = call[1] as string[];
    return call[0] === '/usr/bin/git' && args.includes(subcommand);
  });
}

function installGit(scripts: {
  gitDir?: string | null;
  status?: string | null;
  diff?: string | null;
  ghError?: Error | null;
  ghStdout?: string;
  holdStatus?: boolean;
}): { releaseStatus: (stdout: string | null) => void } {
  let releaseStatus: (stdout: string | null) => void = () => {};
  mocks.exec.mockImplementation(
    async (
      cmd: string,
      args: readonly string[],
    ): Promise<{ readonly code: number; readonly stdout: string } | null> => {
      if (cmd === '/usr/bin/gh') {
        if (scripts.ghError !== undefined && scripts.ghError !== null) {
          throw scripts.ghError;
        }
        return { code: 0, stdout: scripts.ghStdout ?? '' };
      }
      if (args.includes('rev-parse')) {
        if (scripts.gitDir === null) {
          throw Object.assign(new Error('not a repo'), { code: 128 });
        }
        return { code: 0, stdout: `${scripts.gitDir ?? 'C:/repo/.git'}\n` };
      }
      if (args.includes('status')) {
        if (scripts.holdStatus === true) {
          return new Promise((resolve, reject) => {
            releaseStatus = (stdout) => {
              if (stdout === null) {
                reject(Object.assign(new Error('status failed'), { code: 1 }));
                return;
              }
              resolve({ code: 0, stdout });
            };
          });
        }
        if (scripts.status === null) {
          throw Object.assign(new Error('status failed'), { code: 1 });
        }
        return { code: 0, stdout: scripts.status ?? '## main\n' };
      }
      if (args.includes('diff')) {
        return { code: 0, stdout: scripts.diff ?? '' };
      }
      throw new Error('unexpected git command');
    },
  );
  return { releaseStatus: (stdout) => releaseStatus(stdout) };
}

/** Build a cache whose process layer is the stubbed `exec` above. */
function cacheFor(workDir: string, options: Record<string, unknown> = {}) {
  return createGitStatusCache(workDir, {
    ...options,
    deps: {
      exec: mocks.exec,
      resolveCommand: mocks.resolveCommandPath,
      ...(options['deps'] as object | undefined),
    },
  } as never);
}

describe('git status cache', () => {
  it('reads the cache without blocking and refreshes status on a 30s TTL', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    installGit({
      status: '## main...origin/main [ahead 2, behind 1]\n M src/app.ts\n',
      diff: '4\t1\tsrc/app.ts\n',
      ghError: new Error('no pull request'),
    });

    const cache = cacheFor('/tmp/repo');
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(cache.getStatus()).toBeNull();
    expect(mocks.exec).not.toHaveBeenCalled();

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
    expect(gitCalls('rev-parse')).toHaveLength(1);
    expect(gitCalls('status')).toHaveLength(1);
    expect(gitCalls('diff')).toHaveLength(1);
    expect(gitCalls('branch')).toHaveLength(0);
    expect(mocks.exec).toHaveBeenCalledTimes(4);

    cache.getStatus();
    await drain();
    expect(gitCalls('status')).toHaveLength(1);

    jest.setSystemTime(new Date('2026-04-24T00:00:30Z'));
    cache.getStatus();
    await drain();
    expect(gitCalls('status')).toHaveLength(2);
    expect(gitCalls('rev-parse')).toHaveLength(1);
    cache.dispose();
  });

  it('reads uncommitted diff line counts and current pull request metadata', async () => {
    const onChange = jest.fn();
    installGit({
      status: '## feature/footer...origin/feature/footer\n M src/app.ts\n',
      diff: '10\t3\tsrc/app.ts\n-\t-\timage.png\n0\t5\tdeleted.ts\n',
      ghStdout: '{"number":12,"url":"https://github.com/acme/repo/pull/12"}\n',
    });

    const cache = cacheFor('/tmp/repo', { onChange });
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
    const onChange = jest.fn();
    mocks.exec.mockImplementation(async (cmd: string, args: readonly string[]) => {
      if (cmd === '/usr/bin/gh') {
        throw Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' });
      }
      if (args.includes('rev-parse')) {
        return { code: 0, stdout: 'C:/repo/.git\n' };
      }
      if (args.includes('status')) {
        return { code: 0, stdout: '## main...origin/main\n M src/app.ts\n' };
      }
      if (args.includes('diff')) {
        return { code: 0, stdout: '2\t1\tsrc/app.ts\n' };
      }
      return { code: 0, stdout: '' };
    });

    const cache = cacheFor('/tmp/repo', { onChange });
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
    mocks.resolveCommandPath.mockReturnValue(undefined);
    const cache = cacheFor('/tmp/repo');
    expect(cache.getStatus()).toBeNull();
    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.watchers).toHaveLength(0);
    cache.dispose();
  });

  it('spawns git and gh through their resolved absolute paths and polls only HEAD', async () => {
    installGit({
      gitDir: 'C:/repo/.git',
      status: '## main...origin/main\n',
      ghError: new Error('no pull request'),
    });

    const cache = cacheFor('/tmp/repo');
    expect(mocks.exec).not.toHaveBeenCalled();
    cache.getStatus();
    expect(mocks.exec).not.toHaveBeenCalled();
    await drain();

    expect(mocks.resolveCommandPath).toHaveBeenCalledWith('git', '/tmp/repo');
    expect(mocks.exec).toHaveBeenCalledWith(
      '/usr/bin/git',
      ['-C', '/tmp/repo', 'rev-parse', '--absolute-git-dir'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(mocks.exec).toHaveBeenCalledWith(
      '/usr/bin/gh',
      expect.any(Array),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(mocks.watchers).toHaveLength(1);
    expect(mocks.watchers[0]?.options).toEqual(
      expect.objectContaining({ usePolling: true, interval: 2_000, ignoreInitial: true }),
    );
    expect(mocks.watchers[0]?.add).toHaveBeenCalledWith(join('C:/repo/.git', 'HEAD'));
    cache.dispose();
    expect(mocks.watchers[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('returns null when the working directory is not a git repo and does not probe again', async () => {
    installGit({ gitDir: null });
    const cache = cacheFor('/tmp/not-a-repo');
    expect(cache.getStatus()).toBeNull();
    await drain();

    expect(cache.getStatus()).toBeNull();
    expect(gitCalls('rev-parse')).toHaveLength(1);
    expect(mocks.watchers).toHaveLength(0);
    cache.getStatus();
    cache.refresh();
    await drain();
    expect(gitCalls('rev-parse')).toHaveLength(1);
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
    installGit({ status: '## No commits yet on main\n' });
    const unborn = cacheFor('/tmp/repo');
    unborn.getStatus();
    await drain();
    expect(unborn.getStatus()?.branch).toBe('main');
    unborn.dispose();

    mocks.watchers.length = 0;
    installGit({ status: '## HEAD (no branch)\n' });
    const detached = cacheFor('/tmp/repo');
    detached.getStatus();
    await drain();
    expect(detached.getStatus()).toBeNull();
    expect(gitCalls('diff')).toHaveLength(0);
    detached.dispose();
  });

  it('refreshes when HEAD changes and when refresh() is called inside the TTL', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-24T00:00:00Z'));
    installGit({ status: '## main\n', ghError: new Error('no pull request') });
    const cache = cacheFor('/tmp/repo');
    cache.getStatus();
    await drain();
    expect(gitCalls('status')).toHaveLength(1);

    mocks.watchers[0]?.emit('change');
    await drain();
    expect(gitCalls('status')).toHaveLength(2);

    cache.refresh();
    await drain();
    expect(gitCalls('status')).toHaveLength(3);
    expect(gitCalls('rev-parse')).toHaveLength(1);
    cache.dispose();
  });

  it('keeps the last good status when a later status command fails', async () => {
    installGit({
      status: '## main\n M src/app.ts\n',
      diff: '2\t1\tsrc/app.ts\n',
      ghError: new Error('no pull request'),
    });
    const cache = cacheFor('/tmp/repo');
    cache.getStatus();
    await drain();

    installGit({ status: null, ghError: new Error('no pull request') });
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
    const held = installGit({ holdStatus: true, ghError: new Error('no pull request') });
    const cache = cacheFor('/tmp/repo');
    cache.getStatus();
    await drain();
    expect(gitCalls('status')).toHaveLength(1);

    cache.refresh();
    cache.refresh();
    held.releaseStatus('## main\n');
    await drain();
    expect(gitCalls('status')).toHaveLength(2);

    held.releaseStatus('## topic\n');
    await drain();
    expect(cache.getStatus()?.branch).toBe('topic');
    expect(gitCalls('status')).toHaveLength(2);
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
