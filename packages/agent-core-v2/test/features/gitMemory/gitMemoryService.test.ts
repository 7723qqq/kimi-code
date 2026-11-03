import { describe, expect, it } from 'bun:test';
import { Readable, Writable } from 'node:stream';

import { buildIndex } from '#/features/gitMemory/cache';
import { GitMemoryService } from '#/features/gitMemory/gitMemoryService';
import type { RepoHeadResult } from '#/features/gitMemory/gitReader';
import type { CommitRecord, GitMemoryIndex } from '#/features/gitMemory/types';

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
  readonly registered: string[];
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
    readonly tree?: readonly string[];
    readonly memoryStoreFails?: boolean;
  } = {},
): Harness {
  const state = { spawns: 0, registered: [] as string[] };
  const process = {
    _serviceBrand: undefined as undefined,
    spawn: async (_command: string, args?: readonly string[]) => {
      state.spawns += 1;
      if (options.tree === undefined) return Promise.reject(new Error('no git'));
      const list = args ?? [];
      const separator = list.indexOf('--');
      const pathspec = separator === -1 ? undefined : list[separator + 1];
      const entries =
        pathspec === undefined
          ? options.tree
          : options.tree.filter((entry) => entry === pathspec || entry.startsWith(`${pathspec}/`));
      return {
        _serviceBrand: undefined as undefined,
        pid: 1,
        exitCode: 0,
        stdin: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        stdout: Readable.from([entries.length > 0 ? `${entries.join('\n')}\n` : '']),
        stderr: Readable.from(['']),
        wait: async () => 0,
        kill: async () => {},
        dispose: () => {},
      };
    },
  };
  const service = new (class extends GitMemoryService {
    private readonly stub: GitMemoryIndex | undefined;

    constructor() {
      super(
        process as never,
        { cwd: '/repo' } as never,
        { debug() {}, warn() {}, error() {}, info() {} } as never,
        { enabled: () => options.flagOn === true } as never,
        {
          register: (variant: string) => {
            state.registered.push(variant);
            return { dispose() {} };
          },
        } as never,
        { get: () => options.messages ?? [] } as never,
        {
          list: async () => {
            if (options.memoryStoreFails === true) throw new Error('memory store is locked');
            return (options.memories ?? []).map((entry) => entry.path);
          },
          get: async (path: string) =>
            (options.memories ?? []).find((entry) => entry.path === path),
        } as never,
        {
          lastCommitSha: async (path: string) => `a${path.replace(/[^a-z]/gi, '').padEnd(39, '0')}`,
        } as never,
      );
      this.stub = options.stub;
    }

    protected override async loadIndex(): Promise<GitMemoryIndex | undefined> {
      if (this.stub !== undefined) return this.stub;
      return super.loadIndex();
    }

    protected override loadHead(): Promise<RepoHeadResult> {
      const head = options.head;
      if (head === undefined) {
        return Promise.resolve({ kind: 'unavailable', reason: 'spawn-failed', detail: 'no git' });
      }
      this.repoRoot = head.repoRoot;
      this.pathPrefix = head.prefix;
      return Promise.resolve({ kind: 'ok', head });
    }
  })();
  return {
    service,
    get spawns() {
      return state.spawns;
    },
    get registered() {
      return state.registered;
    },
  };
}

describe('git memory service', () => {
  it('does nothing and spawns nothing when the flag is off', async () => {
    const h = harness({ flagOn: false });
    expect(await h.service.repoBlock()).toBe('');
    expect(await h.service.signalBlock('fix a.ts')).toBe('');
    expect(await h.service.fileBlock('a.ts')).toBe('');
    expect(h.spawns).toBe(0);
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
