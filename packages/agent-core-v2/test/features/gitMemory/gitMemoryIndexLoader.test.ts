import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { buildIndex, cachePath, readIndex, writeIndex } from '#/features/gitMemory/cache';
import { GitMemoryIndexLoader } from '#/features/gitMemory/gitMemoryIndexLoader';
import type { GitUnavailableReason } from '#/features/gitMemory/gitReader';
import type { CommitRecord, GitMemoryIndex } from '#/features/gitMemory/types';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

type Spawn = { readonly stdout: string; readonly stderr: string; readonly code: number } | Error;

function commit(sha: string, files: string[], subject: string): CommitRecord {
  return { sha, date: '2026-10-30', author: 'luozihao', subject, body: '', files };
}

const commits: readonly CommitRecord[] = [
  commit(SHA, ['x.ts', 'shared.ts'], 'feat: newest'),
  commit(OTHER, ['x.ts'], 'fix: oldest'),
];

const tree = ['src', 'src/features'] as const;

function gitHandler(headSha: string): (args: readonly string[]) => Spawn {
  return (args) => {
    if (args.includes('rev-parse')) {
      return { stdout: `/repo\n\n${headSha}\n`, stderr: '', code: 0 };
    }
    if (args.includes('ls-tree')) {
      return { stdout: `${tree.join('\n')}\n`, stderr: '', code: 0 };
    }
    if (args.includes('--name-only')) {
      const lines: string[] = [];
      for (const entry of commits) {
        lines.push(entry.sha);
        lines.push(...entry.files);
      }
      return { stdout: `${lines.join('\n')}\n`, stderr: '', code: 0 };
    }
    const chunks: string[] = [];
    for (const entry of commits) {
      chunks.push(`${entry.sha}\t${entry.date}\t${entry.author}\t${entry.subject}`);
      chunks.push(entry.body);
    }
    return { stdout: `${chunks.join('\0')}\0`, stderr: '', code: 0 };
  };
}

function unavailableHandler(): Spawn {
  return {
    stdout: '',
    stderr: 'fatal: not a git repository (or any of the parent directories)',
    code: 1,
  };
}

interface Harness {
  readonly loader: GitMemoryIndexLoader;
  readonly counts: { readonly revParse: number; readonly log: number; readonly tree: number };
  readonly changed: number;
  readonly unavailable: readonly GitUnavailableReason[];
}

function harness(storeDir: string, handle: (args: readonly string[]) => Spawn): Harness {
  const counts = { revParse: 0, log: 0, tree: 0 };
  const state = { changed: 0, unavailable: [] as GitUnavailableReason[] };
  const process = {
    _serviceBrand: undefined as undefined,
    spawn: async (_command: string, args?: readonly string[]) => {
      const list = args ?? [];
      const outcome = handle(list);
      if (outcome instanceof Error) throw outcome;
      if (list.includes('rev-parse')) counts.revParse += 1;
      else if (list.includes('ls-tree')) counts.tree += 1;
      else counts.log += 1;
      return {
        _serviceBrand: undefined as undefined,
        pid: 1,
        exitCode: outcome.code,
        stdin: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        stdout: Readable.from([outcome.stdout]),
        stderr: Readable.from([outcome.stderr]),
        wait: async () => outcome.code,
        kill: async () => {},
        dispose: () => {},
      };
    },
  };
  const loader = new GitMemoryIndexLoader({
    process: process as never,
    storeDir,
    cwd: '/repo',
    log: { debug() {}, warn() {}, error() {}, info() {} } as never,
    now: () => 0,
    onIndexChanged: () => {
      state.changed += 1;
    },
    onHeadUnavailable: (reason) => {
      state.unavailable.push(reason);
    },
  });
  return {
    loader,
    counts,
    get changed() {
      return state.changed;
    },
    get unavailable() {
      return state.unavailable;
    },
  };
}

async function tempStore(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gitmem-loader-'));
}

describe('git memory index loader', () => {
  it('returns nothing and reports once when the repository is unavailable', async () => {
    const storeDir = await tempStore();
    const h = harness(storeDir, () => unavailableHandler());
    expect(await h.loader.ensureIndex()).toBeUndefined();
    expect(await h.loader.ensureHead()).toBeUndefined();
    expect(h.unavailable).toEqual(['not-a-repo']);
    expect(h.counts.log).toBe(0);
  });

  it('serves a cache hit without probing history or the tree', async () => {
    const storeDir = await tempStore();
    const cached = buildIndex('/repo', SHA, 1500, commits, '2026-10-30T00:00:00.000Z', [...tree]);
    expect(await writeIndex(cachePath(storeDir, '/repo'), cached)).toBe(true);
    const head = gitHandler(SHA);
    const h = harness(storeDir, (args) => {
      if (args.includes('rev-parse')) return head(args);
      throw new Error('git should not be probed beyond the head');
    });
    const index = await h.loader.ensureIndex();
    expect(index?.headSha).toBe(SHA);
    expect(index?.commits).toHaveLength(2);
    expect(h.counts.log).toBe(0);
    expect(h.counts.tree).toBe(0);
    expect(h.changed).toBe(1);
    expect(h.loader.repoRoot).toBe('/repo');
    expect(h.loader.pathPrefix).toBe('');
  });

  it('rebuilds and writes the cache on a miss', async () => {
    const storeDir = await tempStore();
    const h = harness(storeDir, gitHandler(SHA));
    const index = await h.loader.ensureIndex();
    expect(index?.commits.map((entry) => entry.subject)).toEqual(['feat: newest', 'fix: oldest']);
    expect(index?.dirs).toEqual([...tree]);
    expect(h.counts.log).toBe(2);
    expect(h.counts.tree).toBe(1);
    const written = await readIndex(cachePath(storeDir, '/repo'), SHA, 1500);
    expect(written.kind).toBe('hit');
  });

  it('rebuilds a corrupt cache instead of serving it', async () => {
    const storeDir = await tempStore();
    const path = cachePath(storeDir, '/repo');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ not json', 'utf8');
    const h = harness(storeDir, gitHandler(SHA));
    const index = await h.loader.ensureIndex();
    expect(index?.headSha).toBe(SHA);
    expect(index?.commits).toHaveLength(2);
    expect(h.counts.log).toBe(2);
  });

  it('serves a stale index and refreshes it in the background', async () => {
    const storeDir = await tempStore();
    const stale = buildIndex(
      '/repo',
      OTHER,
      1500,
      [commit(OTHER, ['old.ts'], 'chore: stale')],
      'x',
    );
    expect(await writeIndex(cachePath(storeDir, '/repo'), stale)).toBe(true);
    const h = harness(storeDir, gitHandler(SHA));
    const first = await h.loader.ensureIndex();
    expect(first?.headSha).toBe(OTHER);
    expect(h.changed).toBe(1);
    for (let attempt = 0; attempt < 100 && h.changed < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(h.changed).toBe(2);
    const refreshed = await h.loader.ensureIndex();
    expect(refreshed?.headSha).toBe(SHA);
    expect(h.counts.log).toBe(2);
  });
});
