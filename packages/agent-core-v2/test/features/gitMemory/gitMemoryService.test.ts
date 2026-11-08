import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Readable, Writable } from 'node:stream';

import { getLocale, setLocale } from '@moonshot-ai/kimi-i18n';

import { WarningIssued } from '#/agent/profile/profileOps';
import { buildIndex } from '#/features/gitMemory/cache';
import { GitMemoryIndexLoader } from '#/features/gitMemory/gitMemoryIndexLoader';
import { GitMemoryService } from '#/features/gitMemory/gitMemoryService';
import type { RepoHeadResult } from '#/features/gitMemory/gitReader';
import type { CommitRecord, GitMemoryIndex } from '#/features/gitMemory/types';

const previousLocale = getLocale();
beforeAll(() => setLocale('en'));
afterAll(() => setLocale(previousLocale));

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const SHA_D = 'd'.repeat(40);

function commit(sha: string, files: string[], subject: string): CommitRecord {
  return {
    sha,
    date: '2026-10-30',
    author: 'luozihao',
    subject,
    body: '',
    files,
  };
}

const commits: CommitRecord[] = [
  commit(SHA_C, ['shared.ts', 'c.ts'], 'feat: newest'),
  commit(SHA_B, ['a.ts', 'shared.ts'], 'fix: middle'),
  commit(SHA_A, ['a.ts'], 'refactor: oldest'),
  commit(SHA_D, ['src/a.ts'], 'feat: inside a directory'),
];

const dirs = ['src', 'src/features'];

const index: GitMemoryIndex = buildIndex(
  '/repo',
  SHA_C,
  1500,
  commits,
  '2026-10-31T00:00:00.000Z',
  dirs,
);

interface Harness {
  readonly service: GitMemoryService;
  readonly spawns: number;
  readonly headSpawns: number;
  readonly listCalls: number;
  revision: number;
  readonly indexAttempts: number;
  readonly registered: string[];
  readonly warnings: readonly { message: string; payload: unknown }[];
  readonly events: readonly WarningIssued[];
  advance(ms: number): void;
  probeHead(): Promise<unknown>;
}

interface MemoryFixture {
  readonly path: string;
  readonly title: string;
  readonly body: string;
  readonly updatedAt: number;
}

const TREE = [
  'packages',
  'packages/agent-core-v2',
  'packages/agent-core-v2/src',
  'packages/agent-core-v2/src/types.ts',
  'apps/kimi-code',
  'apps/kimi-code/src',
  'apps/kimi-code/src/types.ts',
] as const;

const HEAD_FAILURES = [
  {
    reason: 'not-a-repo',
    detail: 'fatal: not a git repository (or any of the parent directories): .git',
    guidance: 'not inside a git repository',
  },
  {
    reason: 'spawn-failed',
    detail: 'git executable missing',
    guidance: 'Git executable is unavailable',
  },
  {
    reason: 'permission',
    detail: 'fatal: Permission denied',
    guidance: 'git config --global --add safe.directory',
  },
  {
    reason: 'timeout',
    detail: 'fatal: temporary failure',
    guidance: 'will retry automatically',
  },
] as const;

function harness(
  options: {
    readonly flagOn?: boolean;
    readonly stub?: GitMemoryIndex | undefined;
    readonly messages?: unknown[];
    readonly memories?: readonly MemoryFixture[];
    readonly head?: {
      readonly repoRoot: string;
      readonly prefix: string;
      readonly headSha: string;
    };
    readonly headResults?: readonly RepoHeadResult[];
    readonly tree?: readonly string[];
    readonly memoryStoreFails?: boolean;
  } = {},
): Harness {
  const state = {
    spawns: 0,
    headSpawns: 0,
    indexAttempts: 0,
    now: 0,
    listCalls: 0,
    revision: 0,
    registered: [] as string[],
    warnings: [] as { message: string; payload: unknown }[],
    events: [] as WarningIssued[],
  };
  const defaultHead: RepoHeadResult =
    options.head !== undefined || options.stub !== undefined
      ? {
          kind: 'ok',
          head: options.head ?? { repoRoot: '/repo', prefix: '', headSha: SHA_C },
        }
      : { kind: 'unavailable', reason: 'spawn-failed', detail: 'no git' };
  const process = {
    _serviceBrand: undefined as undefined,
    spawn: async (_command: string, args?: readonly string[]) => {
      state.spawns += 1;
      const list = args ?? [];
      let out = '';
      let err = '';
      let code = 0;
      if (list.includes('rev-parse')) {
        const position = state.headSpawns;
        state.headSpawns += 1;
        const result =
          options.headResults?.[Math.min(position, options.headResults.length - 1)] ?? defaultHead;
        if (result.kind === 'ok') {
          out = `${result.head.repoRoot}\n${result.head.prefix}\n${result.head.headSha}\n`;
        } else if (result.reason === 'spawn-failed') {
          return Promise.reject(new Error(result.detail));
        } else {
          err = result.detail;
          code = 1;
        }
      } else {
        if (options.tree === undefined) return Promise.reject(new Error('no git'));
        const separator = list.indexOf('--');
        const pathspec = separator === -1 ? undefined : list[separator + 1];
        const entries =
          pathspec === undefined
            ? options.tree
            : options.tree.filter(
                (entry) => entry === pathspec || entry.startsWith(`${pathspec}/`),
              );
        out = entries.length > 0 ? `${entries.join('\n')}\n` : '';
      }
      return {
        _serviceBrand: undefined as undefined,
        pid: 1,
        exitCode: code,
        stdin: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        stdout: Readable.from([out]),
        stderr: Readable.from([err]),
        wait: async () => code,
        kill: async () => {},
        dispose: () => {},
      };
    },
  };
  const stubValue: { index: GitMemoryIndex | undefined } = { index: undefined };
  const service = new (class extends GitMemoryService {
    constructor() {
      super(
        process as never,
        { cwd: '/repo' } as never,
        {
          debug() {},
          warn(message: string, payload?: unknown) {
            state.warnings.push({ message, payload });
          },
          error() {},
          info() {},
        } as never,
        { enabled: () => options.flagOn === true } as never,
        {
          register: (variant: string) => {
            state.registered.push(variant);
            return { dispose() {} };
          },
        } as never,
        { get: () => options.messages ?? [] } as never,
        {
          get revision() {
            return state.revision;
          },
          list: async () => {
            state.listCalls += 1;
            if (options.memoryStoreFails === true) throw new Error('memory store is locked');
            return (options.memories ?? []).map((entry) => entry.path);
          },
          get: async (path: string) =>
            (options.memories ?? []).find((entry) => entry.path === path),
        } as never,
        {
          recentCommitShas: async () =>
            new Map(
              (options.memories ?? []).map((entry) => [
                entry.path,
                `a${entry.path.replace(/[^a-z]/gi, '').padEnd(39, '0')}`,
              ]),
            ),
        } as never,
        {
          dispatch: (event: WarningIssued) => {
            state.events.push(event);
            return Promise.resolve();
          },
        } as never,
        { agentId: 'main' } as never,
        { sessionId: 'session-test' } as never,
      );
      stubValue.index = options.stub;
    }

    protected override createIndexLoader(): GitMemoryIndexLoader {
      return new (class extends GitMemoryIndexLoader {
        protected override async loadIndex(): Promise<GitMemoryIndex | undefined> {
          const head = await this.ensureHead();
          if (head === undefined) return undefined;
          state.indexAttempts += 1;
          return stubValue.index;
        }
      })(this.indexLoaderDeps());
    }

    protected override now(): number {
      return state.now;
    }

    probeHead(): Promise<unknown> {
      return this.indexLoader.ensureHead();
    }
  })();
  return {
    service,
    get spawns() {
      return state.spawns;
    },
    get headSpawns() {
      return state.headSpawns;
    },
    get listCalls() {
      return state.listCalls;
    },
    get revision() {
      return state.revision;
    },
    set revision(value: number) {
      state.revision = value;
    },
    get indexAttempts() {
      return state.indexAttempts;
    },
    get registered() {
      return state.registered;
    },
    get warnings() {
      return state.warnings;
    },
    get events() {
      return state.events;
    },
    advance(ms: number) {
      state.now += ms;
    },
    probeHead: () => service.probeHead(),
  };
}

describe('git memory service', () => {
  it('does nothing and spawns nothing when the flag is off', async () => {
    const h = harness({ flagOn: false });
    expect(await h.service.repoBlock()).toBe('');
    expect(await h.service.signalBlock('fix a.ts')).toBe('');
    expect(await h.service.fileBlock('a.ts')).toBe('');
    expect(h.spawns).toBe(0);
    expect(h.events).toHaveLength(0);
  });

  it('never throws when git fails', async () => {
    const h = harness({ flagOn: true });
    expect(await h.service.repoBlock()).toBe('');
    expect(await h.service.fileBlock('a.ts')).toBe('');
    expect(await h.service.signalBlock('fix a.ts')).toBe('');
  });

  it('renders the most recent commits in the repo block', async () => {
    const h = harness({ flagOn: true, stub: index });
    const block = await h.service.repoBlock();
    expect(block.startsWith('<repo-memory>')).toBe(true);
    expect(block).toContain('feat: newest');
    expect(block).toContain('refactor: oldest');
  });

  it('renders the directory tree in the repo block', async () => {
    const h = harness({ flagOn: true, stub: index });
    const block = await h.service.repoBlock();
    expect(block).toContain('<repo-tree depth="3">');
    expect(block).toContain('src/features');
  });

  it('renders the directory history beside the file history', async () => {
    const h = harness({ flagOn: true, stub: index });
    const block = await h.service.fileBlock('src/a.ts');
    expect(block).toContain('<file-memory path="src/a.ts">');
    expect(block).toContain('<dir-memory path="src">');
    expect(block).toContain('feat: inside a directory');
  });

  it('omits the directory history for a file at the repository root', async () => {
    const h = harness({ flagOn: true, stub: index });
    const block = await h.service.fileBlock('a.ts');
    expect(block).not.toContain('<dir-memory');
  });

  it('renders the commits that touched a file', async () => {
    const h = harness({ flagOn: true, stub: index });
    const block = await h.service.fileBlock('a.ts');
    expect(block).toContain('<file-memory path="a.ts">');
    expect(block).toContain('fix: middle');
    expect(block).toContain('refactor: oldest');
    expect(block).not.toContain('feat: newest');
  });

  it('abstains for a file with no history', async () => {
    const h = harness({ flagOn: true, stub: index });
    expect(await h.service.fileBlock('unknown.ts')).toBe('');
  });

  it('does not render the same file twice', async () => {
    const h = harness({ flagOn: true, stub: index });
    expect(await h.service.fileBlock('a.ts')).not.toBe('');
    expect(await h.service.fileBlock('a.ts')).toBe('');
  });

  it('points at an already rendered commit instead of repeating it', async () => {
    const h = harness({ flagOn: true, stub: index });
    await h.service.fileBlock('a.ts');
    const block = await h.service.fileBlock('shared.ts');
    expect(block).toContain('see commit');
    expect(block).not.toContain('fix: middle');
  });

  it('extracts paths from a message and renders their history', async () => {
    const h = harness({ flagOn: true, stub: index });
    const block = await h.service.signalBlock('please look at a.ts and shared.ts');
    expect(block).toContain('<repo-memory signal="a.ts">');
  });

  it('abstains when the message names no path', async () => {
    const h = harness({ flagOn: true, stub: index });
    expect(await h.service.signalBlock('please fix the failing test')).toBe('');
  });

  it('registers the turn signal variant', () => {
    const h = harness({ flagOn: true, stub: index });
    expect(h.registered).toContain('git_memory_signal');
  });
});

describe('git memory availability cache', () => {
  const head = { repoRoot: '/repo', prefix: '', headSha: SHA_C };

  it('caches a successful head and index permanently', async () => {
    const h = harness({ flagOn: true, head, stub: index });
    await h.service.repoBlock();
    await h.service.repoBlock();
    expect(h.headSpawns).toBe(1);
    expect(h.indexAttempts).toBe(1);
    expect(h.spawns).toBe(1);
  });

  it('does not probe again during a transient cooldown and retries after 10 seconds', async () => {
    const h = harness({
      flagOn: true,
      headResults: [
        { kind: 'unavailable', reason: 'timeout', detail: 'fatal: temporary failure' },
        { kind: 'ok', head },
      ],
    });
    await h.probeHead();
    h.advance(9_999);
    await h.probeHead();
    expect(h.headSpawns).toBe(1);
    h.advance(1);
    await h.probeHead();
    expect(h.headSpawns).toBe(2);
  });

  for (const failure of HEAD_FAILURES.filter((entry) => entry.reason !== 'timeout')) {
    it(`retries ${failure.reason} after 60 seconds without probing inside its TTL`, async () => {
      const h = harness({
        flagOn: true,
        headResults: [
          { kind: 'unavailable', reason: failure.reason, detail: failure.detail },
          { kind: 'ok', head },
        ],
      });
      await h.probeHead();
      h.advance(59_999);
      await h.probeHead();
      expect(h.headSpawns).toBe(1);
      h.advance(1);
      await h.probeHead();
      expect(h.headSpawns).toBe(2);
    });
  }

  it('cools down an index failure for 10 seconds without reloading a cached head', async () => {
    const h = harness({ flagOn: true, head });
    await h.service.repoBlock();
    h.advance(9_999);
    await h.service.repoBlock();
    expect(h.indexAttempts).toBe(1);
    expect(h.headSpawns).toBe(1);
    h.advance(1);
    await h.service.repoBlock();
    expect(h.indexAttempts).toBe(2);
    expect(h.headSpawns).toBe(1);
  });

  for (const failure of HEAD_FAILURES) {
    it(`logs ${failure.reason} with the working directory and detail`, async () => {
      const h = harness({
        flagOn: true,
        headResults: [{ kind: 'unavailable', reason: failure.reason, detail: failure.detail }],
      });
      await h.probeHead();
      expect(h.warnings).toHaveLength(1);
      expect(h.warnings[0]?.message).toBe('git memory head lookup failed');
      expect(h.warnings[0]?.payload).toMatchObject({
        cwd: '/repo',
        reason: failure.reason,
        detail: failure.detail,
      });
    });
  }
});

describe('git memory unavailable warning', () => {
  for (const failure of HEAD_FAILURES) {
    it(`dispatches one actionable warning for ${failure.reason}`, async () => {
      const h = harness({
        flagOn: true,
        headResults: [{ kind: 'unavailable', reason: failure.reason, detail: failure.detail }],
      });
      await h.probeHead();
      expect(h.events).toHaveLength(1);
      expect(h.events[0]).toMatchObject({
        type: 'warning',
        agentId: 'main',
        code: 'git-memory-unavailable',
      });
      expect(h.events[0]?.message).toContain('/repo');
      expect(h.events[0]?.message).toContain(failure.guidance);
    });
  }

  it('dispatches only once across the repo, file and signal channels', async () => {
    const failure = {
      kind: 'unavailable',
      reason: 'not-a-repo',
      detail: 'fatal: not a git repository',
    } as const;
    const h = harness({ flagOn: true, headResults: [failure] });
    await h.service.repoBlock();
    await h.service.fileBlock('a.ts');
    await h.service.signalBlock('fix a.ts');
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ code: 'git-memory-unavailable', agentId: 'main' });
  });
});

describe('git memory written entries', () => {
  const scoped = {
    path: 'global/tui.md',
    title: 'TUI panel heights',
    body: '---\napplies_to: ["apps/tui/**"]\n---\n# TUI panel heights\nkeep the dock budget in sync',
    updatedAt: Date.parse('2026-10-20T00:00:00.000Z'),
  };

  it('injects a scoped memory into the matching file block', async () => {
    const h = harness({ flagOn: true, stub: index, memories: [scoped] });
    const block = await h.service.fileBlock('apps/tui/panel.ts');
    expect(block).toContain('<memory sha="');
    expect(block).toContain('TUI panel heights');
  });

  it('does not inject a scoped memory into an unrelated file', async () => {
    const h = harness({ flagOn: true, stub: index, memories: [scoped] });
    const block = await h.service.fileBlock('apps/other/panel.ts');
    expect(block).not.toContain('TUI panel heights');
  });

  it('injects an unscoped memory into the repo block', async () => {
    const h = harness({
      flagOn: true,
      stub: index,
      memories: [
        {
          path: 'global/general.md',
          title: 'General note',
          body: '# General note\nalways run the type check',
          updatedAt: Date.parse('2026-10-21T00:00:00.000Z'),
        },
      ],
    });
    const block = await h.service.repoBlock();
    expect(block).toContain('General note');
  });

  it('reads the memory store once per content revision', async () => {
    const h = harness({
      flagOn: true,
      stub: index,
      memories: [
        {
          path: 'global/general.md',
          title: 'General note',
          body: '# General note\nalways run the type check',
          updatedAt: Date.parse('2026-10-21T00:00:00.000Z'),
        },
      ],
    });
    await h.service.repoBlock();
    const afterFirst = h.listCalls;
    expect(afterFirst).toBe(1);
    await h.service.repoBlock();
    expect(h.listCalls).toBe(afterFirst);
    h.revision = 1;
    await h.service.repoBlock();
    expect(h.listCalls).toBe(afterFirst + 1);
  });
});

describe('git memory repo map', () => {
  const head = { repoRoot: '/repo', prefix: 'apps/kimi-code/', headSha: SHA_C };

  it('lists the tracked paths of the whole repository', async () => {
    const h = harness({ flagOn: true, head, tree: TREE });
    const output = await h.service.repoMap(undefined, 3);
    expect(output).toContain('packages/agent-core-v2/src');
    expect(output).toContain('apps/kimi-code/src');
    expect(output).not.toContain('packages/agent-core-v2/src/types.ts');
  });

  it('resolves a repository-relative path from a subdirectory working directory', async () => {
    const h = harness({ flagOn: true, head, tree: TREE });
    const output = await h.service.repoMap('packages/agent-core-v2', 3);
    expect(output).toContain('packages/agent-core-v2/src/types.ts');
    expect(output).not.toContain('apps/kimi-code');
  });

  it('falls back to the working directory prefix when the root path does not match', async () => {
    const h = harness({ flagOn: true, head, tree: TREE });
    const output = await h.service.repoMap('src', 3);
    expect(output).toContain('apps/kimi-code/src/types.ts');
  });

  it('keeps only the paths within the depth below the prefix', async () => {
    const h = harness({ flagOn: true, head, tree: TREE });
    const output = await h.service.repoMap('packages/agent-core-v2', 1);
    expect(output).toContain('packages/agent-core-v2/src');
    expect(output).not.toContain('packages/agent-core-v2/src/types.ts');
  });

  it('returns nothing when the flag is off', async () => {
    const h = harness({ flagOn: false, head, tree: TREE });
    expect(await h.service.repoMap('packages', 3)).toBe('');
    expect(h.spawns).toBe(0);
    expect(h.events).toHaveLength(0);
  });
});

describe('git memory with a broken memory store', () => {
  it('still injects the repo history', async () => {
    const h = harness({ flagOn: true, stub: index, memoryStoreFails: true });
    const block = await h.service.repoBlock();
    expect(block).toContain('<repo-memory>');
    expect(block).toContain('feat: newest');
    expect(block).toContain('<repo-tree depth="3">');
  });

  it('still injects the file history', async () => {
    const h = harness({ flagOn: true, stub: index, memoryStoreFails: true });
    const block = await h.service.fileBlock('a.ts');
    expect(block).toContain('<file-memory path="a.ts">');
    expect(block).toContain('fix: middle');
  });
});
