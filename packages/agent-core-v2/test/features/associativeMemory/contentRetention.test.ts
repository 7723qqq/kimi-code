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

async function withDir<T>(task: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await mkdtemp(join(os.tmpdir(), 'associative-retention-'));
  try {
    return await task(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

describe('associative memory content retention', () => {
  it('still finds an unused memory by its own words after five years', async () => {
    await withDir(async (homeDir) => {
      const clocked = build(homeDir);
      try {
        await clocked.service.writeNote('the cache layer sets a 30 second ttl on entries');
        clocked.advance(5 * 365 * DAY);
        await clocked.service.writeNote('an unrelated note about the office kitchen');

        const recalled = await clocked.service.recall({
          cue: 'cache ttl entries',
          limit: 5,
          maxTokens: undefined,
          includeHistory: false,
        });
        expect(recalled.items.some((item) => item.text.includes('30 second'))).toBe(true);
      } finally {
        clocked.service.dispose();
      }
    });
  });

  it('loses the association even though the content survives', async () => {
    await withDir(async (homeDir) => {
      const clocked = build(homeDir);
      try {
        await clocked.service.writeNote('the retention policy keeps logs for ninety days');
        await clocked.service.writeNote('the retention policy is audited quarterly by compliance');
        await clocked.service.writeNote('compliance asks for the audit trail export');

        const before = await clocked.service.recall({
          cue: 'ninety days',
          limit: 8,
          maxTokens: undefined,
          includeHistory: false,
        });
        expect(before.items.some((item) => item.text.includes('audit trail export'))).toBe(true);

        clocked.advance(3 * 365 * DAY);
        await clocked.service.writeNote('an unrelated note about the office printer');

        const after = await clocked.service.recall({
          cue: 'ninety days',
          limit: 8,
          maxTokens: undefined,
          includeHistory: false,
        });
        expect(after.items.some((item) => item.text.includes('keeps logs'))).toBe(true);
        expect(after.items.some((item) => item.text.includes('audit trail export'))).toBe(false);
      } finally {
        clocked.service.dispose();
      }
    });
  });
});
