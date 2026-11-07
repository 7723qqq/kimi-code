import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { ASSOCIATIVE_MEMORY_PARAMS } from '#/features/associativeMemory/params';
import { collectSchemaLinks } from '#/features/associativeMemory/schema';
import { AssociativeMemoryService } from '#/features/associativeMemory/service';
import type { AssociativeMemoryStore } from '#/features/associativeMemory/store';
import { resetRendered } from '#/agent/injection/renderedLines';

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
    resetRendered();
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
          { cwd: join(homeDir, 'project') } as never,
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
    await h.service.writeNote('alpha cache\n\nbeta cache');
    expect((await h.service.stats()).edges).toBeGreaterThan(0);
    h.setNow(1_000 + 400 * 24 * 60 * 60 * 1000);
    await h.service.writeNote('gamma');
    expect((await h.service.stats()).edges).toBe(0);
  });

  it('runs the full loop: write, inject, recall, reconsolidate, audit, export', async () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'cache ttl' }], toolCalls: [] },
    ];
    const h = build(true, messages);
    await h.service.writeNote('the cache ttl is 30 seconds');
    const provider = h.providers.get('associative_memory_signal');
    expect(provider).toBeDefined();
    const block = await provider!({ isNewTurn: true });
    expect(typeof block === 'string' ? block : '').toContain('cache ttl');

    const recalled = await h.service.recall({
      cue: 'cache ttl',
      limit: undefined,
      maxTokens: undefined,
      includeHistory: false,
    });
    expect(recalled.items.length).toBeGreaterThan(0);
    await h.service.reconsolidate(recalled.items[0]!.id, 'the cache ttl is 60 seconds');

    const entries = await h.service.audit(20);
    expect(entries.some((entry) => entry.kind === 'reconsolidate')).toBe(true);

    await fsp.mkdir(join(homeDir, 'project'), { recursive: true });
    const exported = await h.service.export('project');
    const payload = JSON.parse(await fsp.readFile(exported.path, 'utf8')) as {
      audit?: { kind: string }[];
    };
    expect(payload.audit?.some((entry) => entry.kind === 'reconsolidate')).toBe(true);
  });

  it('reconsolidates a recalled memory and supersedes the old atom', async () => {
    const h = build();
    const written = await h.service.writeNote('the cache ttl is 30 seconds');
    await h.service.recall({
      cue: 'cache ttl',
      limit: undefined,
      maxTokens: undefined,
      includeHistory: false,
    });
    const result = await h.service.reconsolidate(written.atomIds[0], 'the cache ttl is 60 seconds');
    expect(result.atomIds.length).toBeGreaterThan(0);
    expect((await h.service.stats()).suppressed).toBeGreaterThan(0);
  });

  it('reconsolidates the most recent recall when no id is given', async () => {
    const h = build();
    await h.service.writeNote('the cache ttl is 30 seconds');
    await h.service.recall({
      cue: 'cache ttl',
      limit: undefined,
      maxTokens: undefined,
      includeHistory: false,
    });
    const result = await h.service.reconsolidate(undefined, 'the cache ttl is 60 seconds');
    expect(result.atomIds.length).toBeGreaterThan(0);
  });

  it('records audit entries for blocked writes and pins, newest first', async () => {
    const h = build();
    await h.service.writeNote('token sk-abcdefghijklmnopqrstuvwxyz123456');
    const written = await h.service.writeNote('ordinary note');
    await h.service.pin(written.atomIds[0]!);
    const entries = await h.service.audit(20);
    const kinds = entries.map((entry) => entry.kind);
    expect(kinds).toContain('write_blocked');
    expect(kinds).toContain('pin');
    expect(kinds.indexOf('pin')).toBeLessThan(kinds.indexOf('write_blocked'));
  });

  it('exports the audit log alongside the memories', async () => {
    const h = build();
    await fsp.mkdir(join(homeDir, 'project'), { recursive: true });
    await h.service.writeNote('ordinary note');
    await h.service.pin((await h.service.list({})).atoms[0]!.id);
    const exported = await h.service.export('project');
    const payload = JSON.parse(await fsp.readFile(exported.path, 'utf8')) as {
      audit?: { kind: string }[];
    };
    expect(payload.audit?.some((entry) => entry.kind === 'pin')).toBe(true);
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
    expect(after.atoms).toBe(0);
    expect(after.pinned).toBe(0);
    const listed = await h.service.list({ kind: 'atom', limit: 10, scope: 'all' });
    expect(listed.atoms).toEqual([]);
    const recalled = await h.service.recall({
      cue: 'release checklist',
      limit: undefined,
      maxTokens: undefined,
      includeHistory: false,
    });
    expect(recalled.items).toEqual([]);
  });

  it('detaches the associations of a forgotten atom', async () => {
    const h = build();
    const first = await h.service.writeNote('the deploy pipeline signs the artifact');
    await h.service.writeNote('deployment signing happens before promotion');
    const id = first.atomIds[0]!;
    const before = await h.service.stats();
    expect(before.edges).toBeGreaterThan(0);

    await h.service.forget(id);

    const after = await h.service.stats();
    const touched = (
      await h.service.list({ kind: 'atom', limit: 20, scope: 'all' })
    ).atoms.filter((atom) => atom.id === id);
    expect(touched).toEqual([]);
    expect(after.atoms).toBe(before.atoms - 1);
    expect(after.edges).toBe(0);
  });

  it('removes a forgotten concept from every read path', async () => {
    const h = build();
    for (const note of [
      'the cache layer keeps a warm copy of the response',
      'the cache layer evicts entries under memory pressure',
      'the cache layer resets the ttl on restart',
    ]) {
      await h.service.writeNote(note);
    }
    const cue = {
      cue: 'the cache layer memory pressure',
      limit: 8,
      maxTokens: undefined,
      includeHistory: false,
      reinforce: true,
    };
    for (let round = 0; round < 4; round += 1) await h.service.recall(cue);
    const concepts = (await h.service.list({ kind: 'concept', limit: 5, scope: 'all' })).concepts;
    expect(concepts.length).toBeGreaterThan(0);

    await h.service.forget(concepts[0]!.id);

    const remaining = (await h.service.list({ kind: 'concept', limit: 5, scope: 'all' })).concepts;
    expect(remaining.some((concept) => concept.id === concepts[0]!.id)).toBe(false);
    expect((await h.service.stats('all')).concepts).toBeLessThan(concepts.length);
  });

  it('does not recall everything for a cue made of stop words', async () => {
    const h = build();
    await h.service.writeNote('the billing invoice proration rounds down');
    await h.service.writeNote('the cache layer sets a thirty second ttl on entries');

    const stopOnly = await h.service.recall({
      cue: 'the of and',
      limit: 5,
      maxTokens: undefined,
      includeHistory: false,
    });
    expect(stopOnly.items).toEqual([]);

    const contentful = await h.service.recall({
      cue: 'invoice proration',
      limit: 5,
      maxTokens: undefined,
      includeHistory: false,
    });
    expect(contentful.items.length).toBeGreaterThan(0);
  });

  it('reports zero when no memory was flagged as contradicted', async () => {
    const h = build();
    await h.service.writeNote('the cache layer sets a thirty second ttl on entries');
    await h.service.writeNote('the deploy rollout pauses on error rates');
    expect(await h.service.replay(5)).toEqual({ replayed: 0 });
  });

  it('refreshes a flagged memory without un-suppressing it', async () => {
    const h = build();
    const written = await h.service.writeNote('the cache layer sets a thirty second ttl on entries');
    const id = written.atomIds[0]!;
    const scopeKey = await (
      h.service as unknown as { projectScopeKey(): Promise<string> }
    ).projectScopeKey();
    const store = await (
      h.service as unknown as { ensureStore(key: string): Promise<AssociativeMemoryStore> }
    ).ensureStore(scopeKey);
    const atom = store.getAtom(id)!;
    await store.putAtom({ ...atom, suppressed: true, replayPriority: 2 });

    expect(await h.service.replay(5)).toEqual({ replayed: 1 });

    const after = store.getAtom(id)!;
    expect(after.suppressed).toBe(true);
    expect(after.replayPriority).toBe(1);
    const audit = await h.service.audit(3);
    expect(audit.some((entry) => entry.kind === 'replay')).toBe(true);
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

  it('keeps earlier replay training instead of overwriting it with a stale snapshot', async () => {
    const h = build();
    const first = await h.service.writeNote('the cache layer sets a thirty second ttl on entries');
    const second = await h.service.writeNote('cache zebra quilt marble');
    const a = first.atomIds[0]!;
    const b = second.atomIds[0]!;
    const scopeKey = await (
      h.service as unknown as { projectScopeKey(): Promise<string> }
    ).projectScopeKey();
    const store = await (
      h.service as unknown as { ensureStore(key: string): Promise<AssociativeMemoryStore> }
    ).ensureStore(scopeKey);
    for (const existing of store.listEdges()) await store.deleteEdge(existing.id);
    for (const id of [a, b]) {
      await store.putAtom({ ...store.getAtom(id)!, replayPriority: 1 });
    }
    const link = (from: string, to: string) => ({
      id: `${from}>${to}`,
      from,
      to,
      kind: 'hebbian' as const,
      weight: 1,
      strengthenCount: 1,
      validFrom: 0,
      validUntil: undefined,
      createdAt: 0,
      lastUsedAt: 0,
    });
    await store.putEdge(link(a, b));
    await store.putEdge(link(b, a));

    expect(await h.service.replay(5)).toEqual({ replayed: 2 });
    expect(store.listEdges().find((e) => e.id === `${a}>${b}`)?.weight).toBeCloseTo(1.2375, 5);
  });

  it('calibrates confidence from explicit pin and forget feedback', async () => {
    const h = build();
    const first = await h.service.writeNote('the cache layer sets a thirty second ttl on entries');
    const second = await h.service.writeNote('the deploy rollout pauses on error rates');
    const scopeKey = await (
      h.service as unknown as { projectScopeKey(): Promise<string> }
    ).projectScopeKey();
    const store = await (
      h.service as unknown as { ensureStore(key: string): Promise<AssociativeMemoryStore> }
    ).ensureStore(scopeKey);
    const pinned = first.atomIds[0]!;
    const forgotten = second.atomIds[0]!;
    expect(store.getAtom(pinned)!.confidence).toBeCloseTo(0.5, 5);

    await h.service.pin(pinned);
    await h.service.forget(forgotten);

    expect(store.getAtom(pinned)!.confidence).toBeCloseTo(0.6, 5);
    expect(store.getAtom(forgotten)!.confidence).toBeCloseTo(0.4, 5);
    const stats = await h.service.stats();
    expect(stats.meanConfidence).toBeGreaterThan(0);
    expect(stats.workingItems).toBe(0);
  });

  it('keeps external-source notes out of automatic injection', async () => {
    const h = build();
    await h.service.writeNote(
      'the cache layer sets a thirty second ttl on entries',
      'project',
      'external',
    );
    const block = await h.service.signalBlock('cache ttl');
    expect(block).not.toContain('cache layer');
    const audit = await h.service.audit(5);
    expect(audit.some((entry) => entry.kind === 'injection_filtered')).toBe(true);
  });

  it('reactivates short-term context when no long-term memory matches', async () => {
    const h = build();
    await h.service.signalBlock('the cache ttl is sixty seconds');
    h.setNow(4 * 60 * 60 * 1000);
    const block = await h.service.signalBlock('cache ttl');
    expect(block).toContain('short-term context');
    expect(block).toContain('the cache ttl is sixty seconds');
    expect((await h.service.stats()).workingItems).toBeGreaterThan(0);
  });

  it('does not supersede on identical or unrelated reconsolidation', async () => {
    const h = build();
    const written = await h.service.writeNote('the cache layer sets a thirty second ttl on entries');
    const id = written.atomIds[0]!;
    const identical = await h.service.reconsolidate(
      id,
      'the cache layer sets a thirty second ttl on entries',
    );
    expect(identical.superseded).toBe(false);
    const unrelated = await h.service.reconsolidate(id, 'zebra quilt marble');
    expect(unrelated.superseded).toBe(false);
  });

  it('weakens competing old edges when a related memory is written', async () => {
    const h = build();
    await h.service.writeNote('the cache layer sets a thirty second ttl on entries');
    await h.service.writeNote('the cache layer pauses on error rates');
    const scopeKey = await (
      h.service as unknown as { projectScopeKey(): Promise<string> }
    ).projectScopeKey();
    const store = await (
      h.service as unknown as { ensureStore(key: string): Promise<AssociativeMemoryStore> }
    ).ensureStore(scopeKey);
    const before = new Map(
      store.listEdges().filter((e) => e.kind === 'hebbian').map((e) => [e.id, e.weight]),
    );
    expect(before.size).toBeGreaterThan(0);

    await h.service.writeNote('the cache layer uses a sixty second ttl');

    const weakened = store
      .listEdges()
      .filter((e) => before.has(e.id))
      .filter((e) => e.weight < (before.get(e.id) ?? 0) - 1e-9);
    expect(weakened.length).toBeGreaterThan(0);
  });

  it('reports note counts by write source', async () => {
    const h = build();
    await h.service.writeNote('the cache layer sets a thirty second ttl on entries');
    await h.service.writeNote('the deploy rollout pauses on error rates', 'project', 'external');
    const counts = (await h.service.stats()).sourceCounts;
    expect(counts.user).toBe(1);
    expect(counts.external).toBe(1);
    expect(counts.tool).toBe(0);
  });

  it('weakens neglected atoms more than recently retrieved ones during maintenance', async () => {
    const h = build();
    const written = await h.service.writeNote('the cache layer sets a thirty second ttl on entries');
    const id = written.atomIds[0]!;
    const scopeKey = await (
      h.service as unknown as { projectScopeKey(): Promise<string> }
    ).projectScopeKey();
    const store = await (
      h.service as unknown as { ensureStore(key: string): Promise<AssociativeMemoryStore> }
    ).ensureStore(scopeKey);
    const now = 1_000;
    const base = store.getAtom(id)!;
    await store.putAtom({ ...base, lastActivatedAt: now - 8 * 24 * 60 * 60 * 1000 });
    await store.putAtom({ ...base, id: 'fresh', lastActivatedAt: now });
    const link = async (from: string): Promise<void> => {
      await store.putEdge({
        id: `${from}>other`,
        from,
        to: 'other',
        kind: 'hebbian',
        weight: 1,
        strengthenCount: 1,
        validFrom: 0,
        validUntil: undefined,
        createdAt: 0,
        lastUsedAt: 0,
      });
    };
    await link(id);
    await link('fresh');
    await (
      h.service as unknown as {
        maintain(store: AssociativeMemoryStore, now: number): Promise<void>;
      }
    ).maintain(store, now);
    const neglected = store.listEdges().find((e) => e.id === `${id}>other`)?.weight ?? 0;
    const fresh = store.listEdges().find((e) => e.id === 'fresh>other')?.weight ?? 0;
    expect(neglected).toBeGreaterThan(0);
    expect(neglected / fresh).toBeLessThan(1);
  });

  it('persists multi-hop structure links produced by recall traces', async () => {
    const h = build();
    await h.service.writeNote('the cache layer sets a thirty second ttl on entries');
    await h.service.writeNote('the ttl expiry worker refreshes entries');
    await h.service.writeNote('the expiry worker triggers a background sweep');
    const scopeKey = await (
      h.service as unknown as { projectScopeKey(): Promise<string> }
    ).projectScopeKey();
    const store = await (
      h.service as unknown as { ensureStore(key: string): Promise<AssociativeMemoryStore> }
    ).ensureStore(scopeKey);
    const result = await h.service.recall({
      cue: 'cache',
      limit: 8,
      maxTokens: undefined,
      includeHistory: false,
      scope: 'all',
    });
    const links = collectSchemaLinks(result.trace, ASSOCIATIVE_MEMORY_PARAMS);
    const schemaIds = new Set(
      store.listEdges().filter((edge) => edge.kind === 'schema').map((edge) => edge.id),
    );
    expect(result.trace.length).toBeGreaterThan(0);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(schemaIds.has(`${link.from}?${link.to}`)).toBe(true);
  });

  it('rebuilds the graph without changing sources or confidence', async () => {
    const h = build();
    await h.service.writeNote(
      'the cache layer sets a thirty second ttl on entries',
      'project',
      'external',
    );
    const before = await h.service.stats();
    await h.service.rebuild();
    const after = await h.service.stats();
    expect(after.notes).toBe(before.notes);
    expect(after.sourceCounts).toEqual(before.sourceCounts);
    expect(after.meanConfidence).toBeCloseTo(before.meanConfidence, 5);
  });

  it('does not auto-inject tool-authored notes', async () => {
    const h = build();
    await h.service.writeNote(
      'the cache layer sets a thirty second ttl on entries',
      'project',
      'tool',
    );
    const block = await h.service.signalBlock('cache ttl');
    expect(block).not.toContain('cache layer');
    const audit = await h.service.audit(5);
    expect(audit.some((entry) => entry.kind === 'injection_filtered')).toBe(true);
  });

  it('bounds how many competing edges one write can weaken', async () => {
    const h = build();
    const first = await h.service.writeNote('the cache layer sets a thirty second ttl on entries');
    const sourceId = first.atomIds[0]!;
    const scopeKey = await (
      h.service as unknown as { projectScopeKey(): Promise<string> }
    ).projectScopeKey();
    const store = await (
      h.service as unknown as { ensureStore(key: string): Promise<AssociativeMemoryStore> }
    ).ensureStore(scopeKey);
    for (let index = 0; index < 30; index += 1) {
      await store.putEdge({
        id: `competitor${String(index)}`,
        from: sourceId,
        to: `target${String(index)}`,
        kind: 'hebbian',
        weight: 1,
        strengthenCount: 1,
        validFrom: 0,
        validUntil: undefined,
        createdAt: 0,
        lastUsedAt: 0,
      });
    }
    const before = new Map(
      store.listEdges().filter((edge) => edge.id.startsWith('competitor')).map((edge) => [edge.id, edge.weight]),
    );
    expect(before.size).toBe(30);

    await h.service.writeNote('the cache layer uses a sixty second ttl');

    const weakened = store
      .listEdges()
      .filter((edge) => before.has(edge.id) && edge.weight < (before.get(edge.id) ?? 0) - 1e-9);
    expect(weakened.length).toBeGreaterThan(0);
    expect(weakened.length).toBeLessThanOrEqual(ASSOCIATIVE_MEMORY_PARAMS.interferenceMaxEdges);
  });
});
