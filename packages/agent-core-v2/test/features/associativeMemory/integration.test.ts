import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { AssociativeMemoryService } from '#/features/associativeMemory/service';
import type { RecallQuery } from '#/features/associativeMemory/types';

import { stubBootstrap } from '../../app/bootstrap/stubs';

interface Harness {
  readonly service: AssociativeMemoryService;
  setNow(now: number): void;
}

describe('associative memory integration', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'associative-memory-int-'));
  });

  afterEach(async () => {
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function build(cwd: string, flagOn = true): Harness {
    let now = 1_000;
    const bootstrap = { ...stubBootstrap(homeDir), cwd };
    const service = new (class extends AssociativeMemoryService {
      constructor() {
        super(
          bootstrap as never,
          { enabled: () => flagOn } as never,
          { debug() {}, info() {}, warn() {}, error() {} } as never,
          { register: () => ({ dispose() {} }) } as never,
          { get: () => [] } as never,
          { cwd } as never,
          );
      }
      protected override now(): number {
        return now;
      }
    })();
    return {
      service,
      setNow(value: number) {
        now = value;
      },
    };
  }

  function query(cue: string): RecallQuery {
    return { cue, limit: undefined, maxTokens: undefined, includeHistory: false };
  }

  it('recalls a written note in the same project', async () => {
    const h = build(join(homeDir, 'proj-a'));
    await h.service.writeNote('the login module retries twice');
    const result = await h.service.recall(query('login retries'));
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('does not leak memories across projects', async () => {
    const a = build(join(homeDir, 'proj-a'));
    await a.service.writeNote('the login module retries twice');
    const b = build(join(homeDir, 'proj-b'));
    const result = await b.service.recall(query('login retries'));
    expect(result.items).toEqual([]);
  });

  it('does not store a note blocked by the code', async () => {
    const h = build(join(homeDir, 'proj-a'));
    const result = await h.service.writeNote('key sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(result.blockedByCode).toBe(true);
    expect((await h.service.stats()).atoms).toBe(0);
  });

  it('rebuilds the graph from notes and still recalls', async () => {
    const h = build(join(homeDir, 'proj-a'));
    await h.service.writeNote('the login module retries twice');
    await h.service.rebuild();
    const result = await h.service.recall(query('login retries'));
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('serializes concurrent writes without duplicate atoms', async () => {
    const h = build(join(homeDir, 'proj-a'));
    const writes = await Promise.all([
      h.service.writeNote('alpha note'),
      h.service.writeNote('beta note'),
      h.service.writeNote('gamma note'),
    ]);
    const total = writes.reduce((sum, write) => sum + write.atomIds.length, 0);
    expect((await h.service.stats()).atoms).toBe(total);
  });

  it('keeps a re-written note as one note instead of superseding it', async () => {
    const h = build(join(homeDir, 'proj-a'));
    const first = await h.service.writeNote('the cache ttl is 30 seconds');
    const second = await h.service.writeNote('the cache ttl is 30 seconds');
    expect(second.decision).toBe('noop');
    expect(second.noteId).toBe(first.noteId);
    expect((await h.service.stats()).notes).toBe(1);
    expect((await h.service.stats()).suppressed).toBe(0);
  });
});
