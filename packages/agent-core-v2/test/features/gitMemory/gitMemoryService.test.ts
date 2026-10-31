import { describe, expect, it } from 'bun:test';

import { buildIndex } from '#/features/gitMemory/cache';
import { GitMemoryService } from '#/features/gitMemory/gitMemoryService';
import type { CommitRecord, GitMemoryIndex } from '#/features/gitMemory/types';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function commit(sha: string, files: string[], subject: string): CommitRecord {
  return {
    sha,
    date: '2026-10-30',
    author: 'luozihao',
    subject,
    files,
  };
}

const commits: CommitRecord[] = [
  commit(SHA_C, ['shared.ts', 'c.ts'], 'feat: newest'),
  commit(SHA_B, ['a.ts', 'shared.ts'], 'fix: middle'),
  commit(SHA_A, ['a.ts'], 'refactor: oldest'),
];

const index: GitMemoryIndex = buildIndex('/repo', SHA_C, 1500, commits, '2026-10-31T00:00:00.000Z');

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

function harness(options: {
  readonly flagOn?: boolean;
  readonly stub?: GitMemoryIndex | undefined;
  readonly messages?: unknown[];
  readonly memories?: readonly MemoryFixture[];
} = {}): Harness {
  const state = { spawns: 0, registered: [] as string[] };
  const process = {
    _serviceBrand: undefined as undefined,
    spawn: () => {
      state.spawns += 1;
      return Promise.reject(new Error('no git'));
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
          list: async () => (options.memories ?? []).map((entry) => entry.path),
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
