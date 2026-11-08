import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { AssociativeMemoryService } from '#/features/associativeMemory/service';

import { stubBootstrap } from '../../app/bootstrap/stubs';

const DAY = 24 * 60 * 60 * 1000;

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
        { list: async () => [], get: async () => undefined, setReadOnly() {} } as never,
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

const CLUSTER = [
  'the cache layer keeps a warm copy of the response',
  'the cache layer evicts entries under memory pressure',
  'the cache layer resets the ttl on restart',
  'the cache layer warms on startup',
  'the cache layer logs the hit rate',
];

const RUNBOOK = (suffix: string): string =>
  [
    `alpha prepares the ${suffix} release`,
    'beta verifies the artifact',
    'gamma promotes the build',
  ].join('\n\n');

async function formStructure(service: AssociativeMemoryService): Promise<void> {
  for (const note of CLUSTER) await service.writeNote(note);
  await service.writeNote(RUNBOOK('first'));
  await service.writeNote(RUNBOOK('second'));
  const query = {
    cue: 'cache evict ttl startup hit',
    limit: 8,
    maxTokens: undefined,
    includeHistory: false,
    reinforce: true,
  };
  for (let round = 0; round < 4; round += 1) {
    await service.recall(query);
    await service.recall({
      cue: 'release artifact build',
      limit: 8,
      maxTokens: undefined,
      includeHistory: false,
      reinforce: true,
    });
  }
}

async function withDir<T>(task: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-durability-'));
  try {
    return await task(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

describe('associative memory durability', () => {
  it('forms a concept from writes alone after offline consolidation', async () => {
    await withDir(async (homeDir) => {
      const clocked = build(homeDir);
      try {
        for (const note of CLUSTER) await clocked.service.writeNote(note);
        expect((await clocked.service.stats('project')).concepts).toBe(0);

        for (let round = 1; round <= 2; round += 1) {
          clocked.advance(7 * 60 * 60 * 1000);
          await clocked.service.writeNote(`an unrelated office note number ${round}`);
        }

        expect((await clocked.service.stats('project')).concepts).toBeGreaterThan(0);
        const audit = await clocked.service.audit(20);
        expect(audit.some((entry) => entry.kind === 'consolidate')).toBe(true);
      } finally {
        clocked.service.dispose();
      }
    });
  });

  it('keeps the formed structure across a restart', async () => {
    await withDir(async (homeDir) => {
      const first = build(homeDir);
      await formStructure(first.service);
      const before = await first.service.stats('project');
      expect(before.concepts).toBeGreaterThan(0);
      expect(before.procedures).toBeGreaterThan(0);
      first.service.dispose();

      const second = build(homeDir);
      try {
        const after = await second.service.stats('project');
        expect(after.concepts).toBe(before.concepts);
        expect(after.procedures).toBe(before.procedures);
        const recalled = await second.service.recall({
          cue: 'release artifact build',
          limit: 8,
          maxTokens: undefined,
          includeHistory: false,
        });
        expect(recalled.items.map((item) => item.kind)).toContain('procedure');
      } finally {
        second.service.dispose();
      }
    });
  });

  it('keeps the formed structure after a year of decay', async () => {
    await withDir(async (homeDir) => {
      const clocked = build(homeDir);
      try {
        await formStructure(clocked.service);
        const before = await clocked.service.stats('project');
        clocked.advance(365 * DAY);
        await clocked.service.writeNote('an unrelated note about the office kitchen');
        const after = await clocked.service.stats('project');
        expect(after.concepts).toBeGreaterThan(0);
        expect(after.concepts).toBe(before.concepts);
        expect(after.edges).toBeLessThanOrEqual(before.edges);
      } finally {
        clocked.service.dispose();
      }
    });
  });
});
