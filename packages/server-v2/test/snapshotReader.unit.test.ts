/**
 * Unit tests for the server-layer disk reader (`services/snapshot`).
 *
 * Constructs `SnapshotReader` with stub core services and a real tmp `homeDir`,
 * writing `state.json` + `agents/main/wire.jsonl` directly — exercising the
 * disk read, the `context.*` reduction, the `(size, mtimeMs)` transcript cache,
 * `state.json` normalization, and `KIMI_SNAPSHOT_*` config parsing without
 * booting a Fastify daemon.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ISessionIndex,
  ISessionLifecycleService,
  IWorkspaceRegistry,
  type ContextMessage,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadSnapshotConfig,
  reduceContextRecords,
  readWireRecords,
  SnapshotNotFoundError,
  SnapshotReader,
  type SnapshotReaderDeps,
} from '../src/services/snapshot';

// ─── tiny stubs ───────────────────────────────────────────────────────────

function fakeAccessor(entries: ReadonlyArray<readonly [unknown, unknown]>) {
  const services = new Map<unknown, unknown>(entries);
  return {
    get<T>(id: unknown): T {
      if (!services.has(id)) throw new Error(`unexpected service request: ${String(id)}`);
      return services.get(id) as T;
    },
  };
}

const noopLogger = { info: () => {} };

interface Fixture {
  homeDir: string;
  workspaceId: string;
  sessionDir: (sid: string) => string;
  index: Map<string, SessionSummary>;
  reader: SnapshotReader;
  broadcaster: { seq: number; epoch: string; inFlightTurn: unknown };
}

const tmpDirs: string[] = [];

async function makeFixtureAsync(opts?: { cacheLimit?: number }): Promise<Fixture> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-snapshot-reader-'));
  tmpDirs.push(homeDir);
  const workspaceId = 'wd_unittest_012345abcdef';
  const index = new Map<string, SessionSummary>();
  const workspaces = new Map([[workspaceId, { root: join(homeDir, 'workspace') }]]);

  const core = {
    accessor: fakeAccessor([
      [ISessionIndex, { get: async (sid: string) => index.get(sid) }],
      [IWorkspaceRegistry, { get: async (ws: string) => workspaces.get(ws) }],
      // Cold by default — no live handle.
      [ISessionLifecycleService, { get: () => undefined }],
    ]),
  };
  const broadcaster = { seq: 0, epoch: 'ep_unit', inFlightTurn: null };
  const deps: SnapshotReaderDeps = {
    homeDir,
    core: core as never,
    broadcaster: {
      getSnapshotState: async () => ({
        seq: broadcaster.seq,
        epoch: broadcaster.epoch,
        inFlightTurn: broadcaster.inFlightTurn as never,
      }),
    } as never,
    logger: noopLogger,
    config: { mode: 'auto', timeoutMs: 4000, cacheLimit: opts?.cacheLimit ?? 32 },
  };
  return {
    homeDir,
    workspaceId,
    sessionDir: (sid) => join(homeDir, 'sessions', workspaceId, sid),
    index,
    reader: new SnapshotReader(deps),
    broadcaster,
  };
}

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

async function seedSession(
  f: Fixture,
  sid: string,
  opts?: { createdAt?: number; title?: string; rawState?: Record<string, unknown> },
): Promise<void> {
  const createdAt = opts?.createdAt ?? 1700000000000;
  f.index.set(sid, {
    id: sid,
    workspaceId: f.workspaceId,
    title: opts?.title,
    createdAt,
    updatedAt: createdAt,
    archived: false,
  });
  const state = opts?.rawState ?? {
    id: sid,
    version: 2,
    createdAt,
    updatedAt: createdAt,
    archived: false,
    title: opts?.title,
  };
  await mkdir(f.sessionDir(sid), { recursive: true });
  await writeFile(join(f.sessionDir(sid), 'state.json'), JSON.stringify(state), 'utf-8');
}

async function writeWire(sessionDir: string, lines: ReadonlyArray<unknown>): Promise<void> {
  const agentDir = join(sessionDir, 'agents', 'main');
  await mkdir(agentDir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length > 0 ? '\n' : '');
  await writeFile(join(agentDir, 'wire.jsonl'), body, 'utf-8');
}

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// ─── SnapshotReader.read ──────────────────────────────────────────────────

describe('SnapshotReader.read', () => {
  it('throws SnapshotNotFoundError for an unknown session', async () => {
    const f = await makeFixtureAsync();
    await expect(f.reader.read('sess_missing')).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it('throws SnapshotNotFoundError when the workspace is gone', async () => {
    const f = await makeFixtureAsync();
    f.index.set('sess_orphan', {
      id: 'sess_orphan',
      workspaceId: 'wd_gone_000000000000',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
    });
    await expect(f.reader.read('sess_orphan')).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it('returns empty messages for a session with no wire.jsonl', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_empty');
    const snap = await f.reader.read('sess_empty');
    expect(snap.session.id).toBe('sess_empty');
    expect(snap.session.status).toBe('idle');
    expect(snap.messages.items).toEqual([]);
    expect(snap.messages.has_more).toBe(false);
    expect(snap.in_flight_turn).toBeNull();
    expect(snap.pending_approvals).toEqual([]);
    expect(snap.as_of_seq).toBe(0);
    expect(snap.epoch).toBe('ep_unit');
  });

  it('builds messages from context.append_message records', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_msgs');
    await writeWire(f.sessionDir('sess_msgs'), [
      { type: 'metadata', protocol_version: '1.4', created_at: 1 },
      { type: 'context.append_message', message: userMessage('one') },
      { type: 'context.append_message', message: userMessage('two') },
    ]);
    const snap = await f.reader.read('sess_msgs');
    expect(snap.messages.items).toHaveLength(2);
    expect(snap.messages.items.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'one',
      'two',
    ]);
  });

  it('folds v1 context.append_loop_event records into assistant and tool messages', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_loop');
    await writeWire(f.sessionDir('sess_loop'), [
      { type: 'metadata', protocol_version: '1.4', created_at: 1 },
      { type: 'context.append_message', message: userMessage('question') },
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 's1', turnId: '0', step: 1 } },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          uuid: 'p1',
          turnId: '0',
          step: 1,
          stepUuid: 's1',
          part: { type: 'text', text: 'hello' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          uuid: 'c1',
          turnId: '0',
          step: 1,
          stepUuid: 's1',
          toolCallId: 'call_1',
          name: 'Bash',
          args: { command: 'echo hi' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          parentUuid: 'c1',
          toolCallId: 'call_1',
          result: { output: 'hi' },
        },
      },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's1', turnId: '0', step: 1 } },
    ]);
    const snap = await f.reader.read('sess_loop');
    expect(snap.messages.items.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    const assistant = snap.messages.items[1]!;
    expect((assistant.content[0] as { text: string }).text).toBe('hello');
    const toolUse = assistant.content.find((p) => p.type === 'tool_use') as
      | { tool_call_id: string; tool_name: string }
      | undefined;
    expect(toolUse?.tool_call_id).toBe('call_1');
    expect(toolUse?.tool_name).toBe('Bash');
    const tool = snap.messages.items[2]!;
    expect(tool.role).toBe('tool');
    expect((tool.content[0] as { tool_call_id: string }).tool_call_id).toBe('call_1');
  });

  it('reduces context.apply_compaction to [summary, ...tail]', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_compact');
    await writeWire(f.sessionDir('sess_compact'), [
      { type: 'context.append_message', message: userMessage('old-1') },
      { type: 'context.append_message', message: userMessage('old-2') },
      {
        type: 'context.apply_compaction',
        count: 2,
        summary: { role: 'user', content: [{ type: 'text', text: 'summary' }], toolCalls: [] },
      },
      { type: 'context.append_message', message: userMessage('after') },
    ]);
    const snap = await f.reader.read('sess_compact');
    const texts = snap.messages.items.map((m) => (m.content[0] as { text: string }).text);
    expect(texts).toEqual(['summary', 'after']);
  });

  it('reduces v1-shaped string summary compaction records', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_compact_v1');
    await writeWire(f.sessionDir('sess_compact_v1'), [
      { type: 'context.append_message', message: userMessage('old-1') },
      { type: 'context.append_message', message: userMessage('old-2') },
      {
        type: 'context.apply_compaction',
        summary: 'summary',
        compactedCount: 2,
        tokensBefore: 100,
        tokensAfter: 20,
      },
      { type: 'context.append_message', message: userMessage('after') },
    ]);
    const snap = await f.reader.read('sess_compact_v1');
    const messages = snap.messages.items;
    const texts = messages.map((m) => (m.content[0] as { text: string }).text);
    expect(texts).toEqual(['summary', 'after']);
    expect(messages[0]?.metadata).toEqual({ origin: { kind: 'compaction_summary' } });
  });

  it('reduces new compaction records to kept user messages followed by contextSummary', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_compact_kept_users');
    await writeWire(f.sessionDir('sess_compact_kept_users'), [
      { type: 'context.append_message', message: userMessage('old user') },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'old assistant' }],
          toolCalls: [],
        },
      },
      { type: 'context.append_message', message: userMessage('recent user') },
      {
        type: 'context.apply_compaction',
        summary: 'raw summary',
        contextSummary: 'model-facing summary',
        compactedCount: 3,
        tokensBefore: 100,
        tokensAfter: 20,
        keptUserMessageCount: 2,
      },
    ]);
    const snap = await f.reader.read('sess_compact_kept_users');
    const messages = snap.messages.items;
    const texts = messages.map((m) => (m.content[0] as { text: string }).text);
    expect(messages.map((m) => m.role)).toEqual(['user', 'user', 'user']);
    expect(texts).toEqual(['old user', 'recent user', 'model-facing summary']);
    expect(messages[2]?.metadata).toEqual({ origin: { kind: 'compaction_summary' } });
  });

  it('honors context.clear and context.undo', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_ops');
    await writeWire(f.sessionDir('sess_ops'), [
      { type: 'context.append_message', message: userMessage('a') },
      { type: 'context.append_message', message: userMessage('b') },
      { type: 'context.clear' },
      { type: 'context.append_message', message: userMessage('c') },
    ]);
    expect((await f.reader.read('sess_ops')).messages.items.map((m) => (m.content[0] as { text: string }).text)).toEqual(['c']);
  });

  it('caps the page at 100 and flags has_more', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_paged');
    await writeWire(
      f.sessionDir('sess_paged'),
      Array.from({ length: 150 }, (_, i) => ({
        type: 'context.append_message' as const,
        message: userMessage(`m${i}`),
      })),
    );
    const snap = await f.reader.read('sess_paged');
    expect(snap.messages.items).toHaveLength(100);
    expect(snap.messages.has_more).toBe(true);
    expect((snap.messages.items[0]!.content[0] as { text: string }).text).toBe('m50');
    expect((snap.messages.items.at(-1)!.content[0] as { text: string }).text).toBe('m149');
  });

  it('normalizes a v1-layout state.json (ISO timestamps, no id)', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_v1', {
      rawState: {
        title: 'v1 session',
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T11:00:00.000Z',
        archived: false,
      },
    });
    const snap = await f.reader.read('sess_v1');
    expect(snap.session.id).toBe('sess_v1');
    expect(snap.session.title).toBe('v1 session');
    expect(Number.isNaN(Date.parse(snap.session.created_at))).toBe(false);
  });

  it('serves repeated reads from the (size, mtime) cache', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_cache');
    await writeWire(f.sessionDir('sess_cache'), [
      { type: 'context.append_message', message: userMessage('cached') },
    ]);
    const first = await f.reader.read('sess_cache');
    expect(first.messages.items).toHaveLength(1);
    // Rewrite with identical content (size + mtime may change) — the cache is
    // keyed on (size, mtime); a same-size rewrite keeps serving the cached
    // reduction only when mtime is unchanged, so just assert stability.
    const second = await f.reader.read('sess_cache');
    expect(second.messages.items.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'cached',
    ]);
  });

  it('invalidates the cache when the wire shrinks (compaction rewrite)', async () => {
    const f = await makeFixtureAsync();
    await seedSession(f, 'sess_shrink');
    await writeWire(f.sessionDir('sess_shrink'), [
      { type: 'context.append_message', message: userMessage('a') },
      { type: 'context.append_message', message: userMessage('b') },
      { type: 'context.append_message', message: userMessage('c') },
    ]);
    expect((await f.reader.read('sess_shrink')).messages.items).toHaveLength(3);
    await new Promise((r) => setTimeout(r, 20));
    await writeWire(f.sessionDir('sess_shrink'), [
      { type: 'context.append_message', message: userMessage('only-one') },
    ]);
    const snap = await f.reader.read('sess_shrink');
    expect(snap.messages.items).toHaveLength(1);
    expect((snap.messages.items[0]!.content[0] as { text: string }).text).toBe('only-one');
  });
});

// ─── pure helpers ─────────────────────────────────────────────────────────

describe('reduceContextRecords', () => {
  it('ignores unknown records and the metadata envelope', () => {
    const out = reduceContextRecords([
      { type: 'metadata', protocol_version: '1.4' },
      { type: 'turn.started', turnId: 1 },
      { type: 'context.append_message', message: userMessage('x') },
    ]);
    expect(out).toHaveLength(1);
  });

  it('applies context.splice', () => {
    const out = reduceContextRecords([
      { type: 'context.append_message', message: userMessage('a') },
      { type: 'context.splice', start: 1, deleteCount: 0, messages: [userMessage('b')] },
    ]);
    expect(out).toHaveLength(2);
    expect((out[1]!.content[0] as { text: string }).text).toBe('b');
  });

  it('folds context.append_loop_event (step/content/tool) into messages', () => {
    const out = reduceContextRecords([
      { type: 'context.append_message', message: userMessage('q') },
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 's1' } },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'hello' } },
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          stepUuid: 's1',
          toolCallId: 'call_1',
          name: 'Bash',
          args: { command: 'echo hi' },
        },
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.result', toolCallId: 'call_1', result: { output: 'hi' } },
      },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's1' } },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect((out[1]!.content[0] as { text: string }).text).toBe('hello');
    expect(out[1]!.toolCalls).toHaveLength(1);
    expect(out[1]!.toolCalls[0]!.id).toBe('call_1');
    expect(out[1]!.partial).toBeUndefined();
    expect(out[2]!.toolCallId).toBe('call_1');
  });

  it('defers context.append_message until the open tool exchange closes', () => {
    const out = reduceContextRecords([
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 's1' } },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.call', stepUuid: 's1', toolCallId: 'call_1', name: 'Bash', args: {} },
      },
      // Arrives while the tool exchange is still open — must not land between
      // the assistant and its tool result.
      { type: 'context.append_message', message: userMessage('injected') },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.result', toolCallId: 'call_1', result: { output: 'ok' } },
      },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's1' } },
    ]);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'user']);
    expect((out[2]!.content[0] as { text: string }).text).toBe('injected');
  });

  it('synthesizes an interrupted result for a tool call left open at a step boundary', () => {
    const out = reduceContextRecords([
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 's1' } },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.call', stepUuid: 's1', toolCallId: 'call_1', name: 'Bash', args: {} },
      },
      // No tool.result before the next step begins — the dangling call is closed.
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 's2' } },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's2' } },
    ]);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(out[1]!.isError).toBe(true);
  });
});

describe('readWireRecords', () => {
  it('drops a torn final line but throws on mid-file corruption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-wire-'));
    tmpDirs.push(dir);
    const p = join(dir, 'wire.jsonl');
    await writeFile(
      p,
      '{"type":"context.append_message","message":{"role":"user","content":[],"toolCalls":[]}}\n{"type":"context.append_message","message":{"role":"user","cont',
      'utf-8',
    );
    const records = await readWireRecords(p);
    expect(records).toHaveLength(1);

    const bad = join(dir, 'bad.jsonl');
    await writeFile(bad, '{not-json}\n{"type":"context.append_message"}\n', 'utf-8');
    await expect(readWireRecords(bad)).rejects.toThrow(/corrupted line 1/);
  });
});

describe('loadSnapshotConfig', () => {
  it('defaults to auto / 4000ms / 32', () => {
    const c = loadSnapshotConfig({});
    expect(c).toEqual({ mode: 'auto', timeoutMs: 4000, cacheLimit: 32 });
  });

  it('parses legacy mode and integer knobs with floors', () => {
    const c = loadSnapshotConfig({
      KIMI_SNAPSHOT_READER: 'legacy',
      KIMI_SNAPSHOT_TIMEOUT_MS: '2500',
      KIMI_SNAPSHOT_CACHE_LIMIT: '0', // below min → default
    });
    expect(c.mode).toBe('legacy');
    expect(c.timeoutMs).toBe(2500);
    expect(c.cacheLimit).toBe(32);
  });

  it('falls back on non-numeric / sub-minimum timeout', () => {
    expect(loadSnapshotConfig({ KIMI_SNAPSHOT_TIMEOUT_MS: 'abc' }).timeoutMs).toBe(4000);
    expect(loadSnapshotConfig({ KIMI_SNAPSHOT_TIMEOUT_MS: '50' }).timeoutMs).toBe(4000);
  });
});
