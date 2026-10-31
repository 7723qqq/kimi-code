import { describe, expect, it } from 'bun:test';

import { GitMemoryService } from '#/features/gitMemory/gitMemoryService';
import { buildIndex } from '#/features/gitMemory/cache';
import type { ChangeGroup, GitFacts, GitMemoryIndex } from '#/features/gitMemory/types';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const groupShared: ChangeGroup = {
  sha: SHA_A,
  subject: 'refactor(tui): move panel',
  date: '2026-10-30',
  files: ['a.ts', 'b.ts'],
  fileCount: 2,
  dirs: ['src/tui'],
  truncated: false,
};

const groupOwn: ChangeGroup = {
  sha: SHA_B,
  subject: 'fix(tui): align footer',
  date: '2026-10-29',
  files: ['a.ts'],
  fileCount: 1,
  dirs: ['src/tui'],
  truncated: false,
};

const facts: GitFacts = {
  conventions: [{ prefix: 'fix', count: 12 }],
  invariants: [{ a: 'x.ts', b: 'y.ts', count: 60 }],
  fileChanges: {
    'a.ts': [groupOwn, groupShared],
    'b.ts': [groupShared],
  },
  filePartners: {},
  strengths: { 'a.ts': 50 },
};

const index: GitMemoryIndex = buildIndex('/repo', SHA_A, 1500, facts, '2026-10-31T00:00:00.000Z');

interface Harness {
  readonly service: GitMemoryService;
  readonly spawns: number;
  readonly registered: string[];
}

function harness(options: {
  readonly flagOn?: boolean;
  readonly stub?: GitMemoryIndex | undefined;
  readonly messages?: unknown[];
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

  it('renders the repo block', async () => {
    const h = harness({ flagOn: true, stub: index });
    const block = await h.service.repoBlock();
    expect(block.startsWith('<repo-memory>')).toBe(true);
    expect(block).toContain('fix 12');
  });

  it('renders the change groups of a file', async () => {
    const h = harness({ flagOn: true, stub: index });
    const block = await h.service.fileBlock('a.ts');
    expect(block).toContain('<file-memory path="a.ts">');
    expect(block).toContain('fix(tui): align footer');
    expect(block).toContain('refactor(tui): move panel');
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

  it('points at an already rendered change group instead of repeating it', async () => {
    const h = harness({ flagOn: true, stub: index });
    await h.service.fileBlock('a.ts');
    const block = await h.service.fileBlock('b.ts');
    expect(block).toContain('see change');
    expect(block).not.toContain('refactor(tui): move panel');
  });

  it('extracts paths from a message and renders their history', async () => {
    const h = harness({ flagOn: true, stub: index });
    const block = await h.service.signalBlock('please look at src/tui/a.ts and b.ts');
    expect(block).toContain('a.ts');
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
