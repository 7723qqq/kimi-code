import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { resetRendered } from '#/agent/injection/renderedLines';
import { AssociativeMemoryService } from '#/features/associativeMemory/service';
import type { AssociativeMemoryStore } from '#/features/associativeMemory/store';

import { stubBootstrap } from '../../app/bootstrap/stubs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Clocked {
  readonly service: AssociativeMemoryService;
  advance(ms: number): void;
}

function build(homeDir: string): Clocked {
  let now = 1_000;
  const bootstrap = { ...stubBootstrap(homeDir), cwd: join(homeDir, 'project') };
  const service = new (class extends AssociativeMemoryService {
    constructor() {
      super(
        bootstrap as never,
        { enabled: () => true } as never,
        { debug() {}, info() {}, warn() {}, error() {} } as never,
        { register: () => ({ dispose() {} }) } as never,
        { get: () => [] } as never,
        { cwd: join(homeDir, 'project'), sessionId: homeDir } as never,
      );
    }
    protected override now(): number {
      return now;
    }
    advance(ms: number): void {
      now += ms;
    }
  })();
  return {
    service,
    advance: (ms: number) => (service as never as { advance: (value: number) => void }).advance(ms),
  };
}

function buildBudgeted(homeDir: string, atomBudget: number): Clocked {
  let now = 1_000;
  const bootstrap = { ...stubBootstrap(homeDir), cwd: join(homeDir, 'project') };
  const service = new (class extends AssociativeMemoryService {
    constructor() {
      super(
        bootstrap as never,
        { enabled: () => true } as never,
        { debug() {}, info() {}, warn() {}, error() {} } as never,
        { register: () => ({ dispose() {} }) } as never,
        { get: () => [] } as never,
        { cwd: join(homeDir, 'project'), sessionId: homeDir } as never,
      );
    }
    protected override atomBudget(): number {
      return atomBudget;
    }
    protected override now(): number {
      return now;
    }
    advance(ms: number): void {
      now += ms;
    }
  })();
  return {
    service,
    advance: (ms: number) => (service as never as { advance: (value: number) => void }).advance(ms),
  };
}

async function storeOf(service: AssociativeMemoryService): Promise<AssociativeMemoryStore> {
  const scopeKey = await (
    service as unknown as { projectScopeKey(): Promise<string> }
  ).projectScopeKey();
  return (
    service as unknown as { ensureStore(key: string): Promise<AssociativeMemoryStore> }
  ).ensureStore(scopeKey);
}

async function withDir<T>(task: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-maintenance-'));
  try {
    return await task(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

const CLUSTER = [
  'the cache layer keeps a warm copy of the response',
  'the cache layer evicts entries under memory pressure',
  'the cache layer resets the ttl on restart',
  'the cache layer warms on startup',
  'the cache layer logs the hit rate',
];

describe('associative memory maintenance', () => {
  it('does not duplicate concepts when consolidation runs repeatedly', async () => {
    await withDir(async (homeDir) => {
      const clocked = build(homeDir);
      try {
        for (const note of CLUSTER) await clocked.service.writeNote(note);
        const counts: number[] = [];
        for (let round = 0; round < 6; round += 1) {
          clocked.advance(7 * HOUR);
          await clocked.service.writeNote(`the office note ${round} is unrelated`);
          counts.push((await clocked.service.stats('project')).concepts);
        }
        expect(counts[counts.length - 1]).toBeGreaterThan(0);
        expect(counts[counts.length - 1]).toBeLessThanOrEqual(CLUSTER.length);
        expect(counts[counts.length - 1]).toBe(counts[counts.length - 2]);
      } finally {
        clocked.service.dispose();
      }
    });
  });

  it('keeps the store bounded across six consolidation passes', async () => {
    await withDir(async (homeDir) => {
      const clocked = build(homeDir);
      try {
        for (const note of CLUSTER) await clocked.service.writeNote(note);
        for (let round = 0; round < 6; round += 1) {
          clocked.advance(7 * HOUR);
          await clocked.service.writeNote(`the office note ${round} is unrelated`);
        }
        const stats = await clocked.service.stats('project');
        expect(stats.atoms).toBeLessThanOrEqual(11);
        expect(stats.edges).toBeLessThanOrEqual(60);
      } finally {
        clocked.service.dispose();
      }
    });
  });

  it('drops stale single-observation co-occurrences on maintenance', async () => {
    await withDir(async (homeDir) => {
      const clocked = build(homeDir);
      try {
        for (let index = 0; index < 30; index += 1) {
          await clocked.service.writeNote(`note${String(index)} alpha${String(index)} bravo${String(index)}`);
        }
        const store = await storeOf(clocked.service);
        const before = store.listCooccurrences();
        expect(before.length).toBeGreaterThan(300);
        expect(before.every((cooc) => cooc.count < 3)).toBe(true);

        clocked.advance(31 * DAY);
        await clocked.service.writeNote('an unrelated note about the office kitchen');

        const after = store.listCooccurrences();
        expect(after.length).toBeLessThan(before.length / 2);
        for (const cooc of after) {
          if (cooc.count >= 3) continue;
          expect(cooc.lastAt).toBeGreaterThan(1_000);
        }
      } finally {
        clocked.service.dispose();
      }
    });
  });

  it('keeps a co-occurrence pair that reached the cluster threshold', async () => {
    await withDir(async (homeDir) => {
      const clocked = build(homeDir);
      try {
        for (const note of CLUSTER) await clocked.service.writeNote(note);
        const cue = {
          cue: 'the cache layer memory pressure',
          limit: 8,
          maxTokens: undefined,
          includeHistory: false,
          reinforce: true,
        };
        for (let round = 0; round < 4; round += 1) await clocked.service.recall(cue);
        const store = await storeOf(clocked.service);
        const repeated = store
          .listCooccurrences()
          .filter((cooc) => cooc.count >= 3)
          .map((cooc) => cooc.key);
        expect(repeated.length).toBeGreaterThan(0);

        clocked.advance(31 * DAY);
        await clocked.service.writeNote('an unrelated note about the office kitchen');

        const keys = new Set(store.listCooccurrences().map((cooc) => cooc.key));
        for (const key of repeated) expect(keys.has(key)).toBe(true);
      } finally {
        clocked.service.dispose();
      }
    });
  });

  it('keeps a memory that keeps getting injected under budget pressure', async () => {
    await withDir(async (homeDir) => {
      const clocked = buildBudgeted(homeDir, 2);
      try {
        await clocked.service.writeNote(
          'the deploy pipeline requires a signed artifact before promotion',
        );
        for (let round = 0; round < 12; round += 1) {
          clocked.advance(2 * DAY);
          resetRendered();
          await clocked.service.signalBlock('deploy pipeline signed artifact promotion');
          await clocked.service.writeNote(
            `filler note ${String(round)} about the kitchen schedule and office plants`,
          );
        }

        const recalled = await clocked.service.recall({
          cue: 'deploy pipeline signed artifact promotion',
          limit: 8,
          maxTokens: undefined,
          includeHistory: false,
        });
        expect(recalled.items.some((item) => item.text.includes('signed artifact'))).toBe(true);
      } finally {
        clocked.service.dispose();
      }
    });
  });

  it('retires a hub once its associations have all decayed away', async () => {
    await withDir(async (homeDir) => {
      const clocked = build(homeDir);
      try {
        for (const note of CLUSTER) await clocked.service.writeNote(note);
        const before = await clocked.service.stats('project');
        expect(before.edges).toBeGreaterThan(0);

        clocked.advance(3 * 365 * DAY);
        await clocked.service.writeNote('an unrelated note about the office kitchen');

        const after = await clocked.service.stats('project');
        expect(after.edges).toBeLessThan(before.edges);
        expect(after.atoms).toBeGreaterThanOrEqual(CLUSTER.length);
      } finally {
        clocked.service.dispose();
      }
    });
  });
});
