import { describe, expect, it, mock } from 'bun:test';

import { createGitStatusCache, formatGitBadge, type GitStatusDeps } from '#/utils/git/git-status';

const START_MS = Date.parse('2026-04-24T00:00:00Z');
const REPO_DIR = '/tmp/repo';

interface CommandCall {
  readonly command: string;
  readonly args: readonly string[];
}

interface SpawnResponse {
  readonly status: number;
  readonly stdout: string;
}

type SpawnResponder = (args: readonly string[]) => SpawnResponse;
type ExecResponder = (callback: (error: Error | null, stdout: string) => void) => void;

interface FakeGit {
  readonly deps: Partial<GitStatusDeps>;
  readonly spawnCalls: CommandCall[];
  readonly execCalls: CommandCall[];
  setNow(nowMs: number): void;
}

interface FakeGitOptions {
  readonly spawn: SpawnResponder;
  readonly execFile?: ExecResponder;
  readonly resolveCommand?: (command: string, cwd: string) => string | undefined;
}

function createFakeGit(options: FakeGitOptions): FakeGit {
  let nowMs = START_MS;
  const spawnCalls: CommandCall[] = [];
  const execCalls: CommandCall[] = [];
  const { execFile } = options;
  const deps: Partial<GitStatusDeps> = {
    now: () => nowMs,
    resolveCommand: options.resolveCommand ?? ((command) => `/usr/bin/${command}`),
    spawnSync: (command, args) => {
      spawnCalls.push({ command, args });
      return options.spawn(args);
    },
    execFile: (command, args, _options, callback) => {
      execCalls.push({ command, args });
      if (execFile === undefined) {
        callback(new Error('no pull request'), '');
        return;
      }
      execFile(callback);
    },
  };
  return {
    deps,
    spawnCalls,
    execCalls,
    setNow: (value) => {
      nowMs = value;
    },
  };
}

function respondGit(responses: {
  readonly branch: string;
  readonly status: string;
  readonly diff: string;
}): SpawnResponder {
  return (args) => {
    if (args.includes('rev-parse')) return { status: 0, stdout: 'true\n' };
    if (args.includes('branch')) return { status: 0, stdout: responses.branch };
    if (args.includes('status')) return { status: 0, stdout: responses.status };
    if (args.includes('diff')) return { status: 0, stdout: responses.diff };
    return { status: 1, stdout: '' };
  };
}

describe('git status cache', () => {
  it('caches branch and status reads until their TTL expires', async () => {
    const git = createFakeGit({
      spawn: respondGit({
        branch: 'main\n',
        status: '## main...origin/main [ahead 2, behind 1]\n M src/app.ts\n',
        diff: '4\t1\tsrc/app.ts\n',
      }),
    });
    const expected = {
      branch: 'main',
      dirty: true,
      ahead: 2,
      behind: 1,
      diffAdded: 4,
      diffDeleted: 1,
      pullRequest: null,
    };

    const cache = createGitStatusCache(REPO_DIR, { deps: git.deps });

    expect(cache.getStatus()).toEqual(expected);
    expect(cache.getStatus()).toEqual(expected);
    expect(git.spawnCalls).toHaveLength(4);
    expect(git.execCalls).toHaveLength(1);

    await Promise.resolve();

    git.setNow(START_MS + 6_000);
    cache.getStatus();
    expect(git.spawnCalls).toHaveLength(5);
    expect(git.execCalls).toHaveLength(1);

    git.setNow(START_MS + 16_000);
    cache.getStatus();
    expect(git.spawnCalls).toHaveLength(8);
    expect(git.execCalls).toHaveLength(1);
  });

  it('reads uncommitted diff line counts and current pull request metadata', async () => {
    const onChange = mock();
    const git = createFakeGit({
      spawn: respondGit({
        branch: 'feature/footer\n',
        status: '## feature/footer...origin/feature/footer\n M src/app.ts\n',
        diff: '10\t3\tsrc/app.ts\n-\t-\timage.png\n0\t5\tdeleted.ts\n',
      }),
      execFile: (callback) => {
        callback(null, '{"number":12,"url":"https://github.com/acme/repo/pull/12"}\n');
      },
    });

    const cache = createGitStatusCache(REPO_DIR, { onChange, deps: git.deps });
    expect(cache.getStatus()).toEqual({
      branch: 'feature/footer',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 10,
      diffDeleted: 8,
      pullRequest: null,
    });

    await Promise.resolve();

    expect(onChange).toHaveBeenCalledTimes(1);
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
  });

  it('keeps footer git status working when gh pull-request lookup throws synchronously', async () => {
    const onChange = mock();
    const git = createFakeGit({
      spawn: respondGit({
        branch: 'main\n',
        status: '## main...origin/main\n M src/app.ts\n',
        diff: '2\t1\tsrc/app.ts\n',
      }),
      execFile: () => {
        throw Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' });
      },
    });
    const expected = {
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 2,
      diffDeleted: 1,
      pullRequest: null,
    };

    const cache = createGitStatusCache(REPO_DIR, { onChange, deps: git.deps });

    expect(cache.getStatus()).toEqual(expected);

    await Promise.resolve();

    expect(onChange).not.toHaveBeenCalled();
    expect(cache.getStatus()).toEqual(expected);
  });

  it('returns null without spawning when git cannot be resolved to a safe path', () => {
    const git = createFakeGit({
      spawn: () => ({ status: 1, stdout: '' }),
      resolveCommand: () => undefined,
    });

    expect(createGitStatusCache(REPO_DIR, { deps: git.deps }).getStatus()).toBeNull();
    expect(git.spawnCalls).toHaveLength(0);
    expect(git.execCalls).toHaveLength(0);
  });

  it('spawns git and gh through their resolved absolute paths', async () => {
    const resolveCalls: { command: string; cwd: string }[] = [];
    const git = createFakeGit({
      spawn: respondGit({ branch: 'main\n', status: '## main...origin/main\n', diff: '' }),
      resolveCommand: (command, cwd) => {
        resolveCalls.push({ command, cwd });
        return `/usr/bin/${command}`;
      },
    });

    const cache = createGitStatusCache(REPO_DIR, { deps: git.deps });
    expect(cache.getStatus()).not.toBeNull();
    await Promise.resolve();

    expect(resolveCalls).toEqual([
      { command: 'git', cwd: REPO_DIR },
      { command: 'gh', cwd: REPO_DIR },
    ]);
    expect(git.spawnCalls.map((call) => call.command)).toEqual([
      '/usr/bin/git',
      '/usr/bin/git',
      '/usr/bin/git',
    ]);
    expect(git.execCalls).toEqual([
      { command: '/usr/bin/gh', args: ['pr', 'view', '--json', 'number,url'] },
    ]);
  });

  it('returns null when the working directory is not a git repo and formats badges', () => {
    const git = createFakeGit({ spawn: () => ({ status: 1, stdout: '' }) });

    expect(createGitStatusCache('/tmp/not-a-repo', { deps: git.deps }).getStatus()).toBeNull();
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

  it('skips git on later renders once the directory is known to be a non-repo', () => {
    const git = createFakeGit({ spawn: () => ({ status: 1, stdout: '' }) });
    const cache = createGitStatusCache('/tmp/not-a-repo', { deps: git.deps });

    expect(cache.getStatus()).toBeNull();
    expect(git.spawnCalls).toHaveLength(1);

    expect(cache.getStatus()).toBeNull();
    expect(git.spawnCalls).toHaveLength(1);
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
