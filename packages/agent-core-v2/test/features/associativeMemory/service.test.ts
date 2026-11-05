import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { AssociativeMemoryService } from '#/features/associativeMemory/service';
import { stubBootstrap } from '../../app/bootstrap/stubs';

interface Harness {
  readonly service: AssociativeMemoryService;
  readonly registered: readonly string[];
  readonly providers: ReadonlyMap<string, (context: { isNewTurn: boolean }) => unknown>;
  setNow(now: number): void;
}

describe('AssociativeMemoryService', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'associative-memory-service-'));
  });

  afterEach(async () => {
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function build(flagOn = true, messages: readonly unknown[] = []): Harness {
    const registered: string[] = [];
    const providers = new Map<string, (context: { isNewTurn: boolean }) => unknown>();
    let now = 1_000;
    const bootstrap = { ...stubBootstrap(homeDir), cwd: join(homeDir, 'project') };
    const service = new (class extends AssociativeMemoryService {
      constructor() {
        super(
          bootstrap as never,
          { enabled: () => flagOn } as never,
          { debug() {}, info() {}, warn() {}, error() {} } as never,
          {
            register: (variant: string, provider: (context: { isNewTurn: boolean }) => unknown) => {
              registered.push(variant);
              providers.set(variant, provider);
              return { dispose() {} };
            },
          } as never,
          { get: () => messages } as never,
        );
      }
      protected override now(): number {
        return now;
      }
    })();
    return {
      service,
      registered,
      providers,
      setNow(value: number) {
        now = value;
      },
    };
  }

  it('registers the per-turn reminder', () => {
    const h = build();
    expect(h.registered).toContain('associative_memory_signal');
  });

  it('injects a reminder block from the last user message and dedupes it', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'login retries' }], toolCalls: [] },
    ];
    const h = build(true, messages);
    await h.service.writeNote('the login module retries twice');
    const provider = h.providers.get('associative_memory_signal');
    expect(provider).toBeDefined();
    const first = await provider!({ isNewTurn: true });
    expect(typeof first === 'string' ? first : '').toContain('login module');
    const second = await provider!({ isNewTurn: true });
    expect(second).toBe('');
  });

  it('does not inject on a continuation turn', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'login retries' }], toolCalls: [] },
    ];
    const h = build(true, messages);
    await h.service.writeNote('the login module retries twice');
    const provider = h.providers.get('associative_memory_signal');
    expect(await provider!({ isNewTurn: false })).toBeUndefined();
  });

  it('writes a note into atoms', async () => {
    const h = build();
    const result = await h.service.writeNote('the login module retries twice');
    expect(result.blockedByCode).toBe(false);
    expect(result.atomIds.length).toBeGreaterThan(0);
    const stats = await h.service.stats();
    expect(stats.atoms).toBe(result.atomIds.length);
  });

  it('decays and prunes edges during maintenance', async () => {
    const h = build();
    await h.service.writeNote('alpha\n\nbeta');
    expect((await h.service.stats()).edges).toBeGreaterThan(0);
    h.setNow(1_000 + 400 * 24 * 60 * 60 * 1000);
    await h.service.writeNote('gamma');
    expect((await h.service.stats()).edges).toBe(0);
  });

  it('lists memories', async () => {
    const h = build();
    await h.service.writeNote('alpha');
    const list = await h.service.list({});
    expect(list.atoms.length).toBeGreaterThan(0);
    expect((await h.service.list({ kind: 'concept' })).atoms).toEqual([]);
  });

  it('separates project and global scopes', async () => {
    const h = build();
    await h.service.writeNote('project specific detail');
    await h.service.writeNote('global shared knowledge', 'global');
    const all = await h.service.recall({
      cue: 'global shared knowledge',
      limit: undefined,
      maxTokens: undefined,
      includeHistory: false,
    });
    expect(all.items.length).toBeGreaterThan(0);
    const projectOnly = await h.service.recall({
      cue: 'global shared knowledge',
      limit: undefined,
      maxTokens: undefined,
      includeHistory: false,
      scope: 'project',
    });
    expect(projectOnly.items).toEqual([]);
  });

  it('exports memories to a file', async () => {
    const h = build();
    await fsp.mkdir(join(homeDir, 'project'), { recursive: true });
    await h.service.writeNote('alpha');
    const result = await h.service.export('project');
    expect(result.path.length).toBeGreaterThan(0);
    expect(result.atoms).toBeGreaterThan(0);
  });

  it('blocks a note that violates the code', async () => {
    const h = build();
    const result = await h.service.writeNote('token sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(result.blockedByCode).toBe(true);
    expect(result.atomIds).toEqual([]);
    expect((await h.service.stats()).atoms).toBe(0);
  });

  it('recalls a written atom by cue', async () => {
    const h = build();
    await h.service.writeNote('the login module retries twice');
    const result = await h.service.recall({
      cue: 'login retries',
      limit: undefined,
      maxTokens: undefined,
      includeHistory: false,
    });
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('pins and forgets atoms', async () => {
    const h = build();
    const written = await h.service.writeNote('remember the release checklist');
    const id = written.atomIds[0]!;
    await h.service.pin(id);
    const pinned = await h.service.stats();
    expect(pinned.pinned).toBe(1);
    await h.service.forget(id);
    const after = await h.service.stats();
    expect(after.suppressed).toBe(1);
    const recalled = await h.service.recall({
      cue: 'release checklist',
      limit: undefined,
      maxTokens: undefined,
      includeHistory: false,
    });
    expect(recalled.items).toEqual([]);
  });

  it('renders a signal block', async () => {
    const h = build();
    await h.service.writeNote('the login module retries twice');
    const block = await h.service.signalBlock('login retries');
    expect(block).toContain('login module');
  });

  it('does nothing when the flag is off', async () => {
    const h = build(false);
    const result = await h.service.writeNote('hello');
    expect(result.atomIds).toEqual([]);
    expect((await h.service.stats()).atoms).toBe(0);
  });
});
