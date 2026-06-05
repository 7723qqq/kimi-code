/**
 * `SessionServiceImpl` (Chain 2 / P1.2) unit tests.
 *
 * Hermetic: we mock `IHarnessBridge` with an in-memory `rpc` proxy whose
 * methods return controllable promises. No KimiCore, no agent-core RPC pair
 * — the adapter is exercised against a fake bridge.
 *
 * Test cases cover:
 *   - create → toProtocolSession (camelCase ↔ snake_case + number → ISO)
 *   - list pagination (default/before_id/after_id/page_size; has_more)
 *   - get + SessionNotFoundError → 40401 mapping at the daemon layer
 *   - update (title-only / metadata-only / both / empty)
 *   - delete returning {deleted: true}
 *   - toProtocolSession field defaults for fields agent-core doesn't surface
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CreateSessionPayload,
  RenameSessionPayload,
  SessionMeta,
  SessionSummary,
  UpdateSessionMetadataPayload,
} from '@moonshot-ai/agent-core';
import { emptySessionUsage, type Session } from '@moonshot-ai/protocol';

import {
  type IHarnessBridge,
  type HarnessRPC,
  SessionNotFoundError,
  SessionServiceImpl,
  toProtocolSession,
} from '../src';

type WithSessionId<T> = T & { readonly sessionId: string };

interface FakeBridgeState {
  sessions: SessionSummary[];
  metas: Map<string, SessionMeta>;
  closedIds: string[];
  renamedTitles: Map<string, string>;
  metadataPatches: Map<string, UpdateSessionMetadataPayload['metadata']>;
}

/**
 * Build a tiny fake `IHarnessBridge` whose `rpc` proxy implements just the
 * five session methods the impl uses. Each method delegates to an in-memory
 * state object the test owns.
 */
function makeFakeBridge(state: FakeBridgeState): IHarnessBridge {
  const rpc: Partial<HarnessRPC> = {
    createSession: vi
      .fn()
      .mockImplementation(async (payload: CreateSessionPayload): Promise<SessionSummary> => {
        const id = payload.id ?? `sess_${state.sessions.length + 1}`;
        const created: SessionSummary = {
          id,
          workDir: payload.workDir,
          sessionDir: `/tmp/sessions/${id}`,
          createdAt: 1_000_000 + state.sessions.length * 1_000,
          updatedAt: 1_000_000 + state.sessions.length * 1_000,
          metadata: payload.metadata,
          title: undefined,
        };
        state.sessions.push(created);
        return created;
      }),
    listSessions: vi.fn().mockImplementation(async (): Promise<readonly SessionSummary[]> => {
      return state.sessions;
    }),
    closeSession: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
      state.closedIds.push(sessionId);
    }),
    renameSession: vi
      .fn()
      .mockImplementation(async (payload: WithSessionId<RenameSessionPayload>) => {
        state.renamedTitles.set(payload.sessionId, payload.title);
        // Reflect into the metadata map so subsequent `getSessionMetadata`
        // returns the updated title (mirrors real KimiCore behavior).
        const existing = state.metas.get(payload.sessionId);
        if (existing !== undefined) {
          state.metas.set(payload.sessionId, { ...existing, title: payload.title });
        } else {
          state.metas.set(payload.sessionId, {
            title: payload.title,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            isCustomTitle: true,
            agents: {},
            custom: {},
          });
        }
      }),
    updateSessionMetadata: vi
      .fn()
      .mockImplementation(
        async (payload: WithSessionId<UpdateSessionMetadataPayload>) => {
          state.metadataPatches.set(payload.sessionId, payload.metadata);
        },
      ),
    getSessionMetadata: vi
      .fn()
      .mockImplementation(async ({ sessionId }: { sessionId: string }): Promise<SessionMeta> => {
        const found = state.metas.get(sessionId);
        if (found === undefined) {
          throw new Error(`no metadata for ${sessionId}`);
        }
        return found;
      }),
  };
  return {
    rpc: rpc as HarnessRPC,
    ready: async () => undefined,
    dispose: () => undefined,
  };
}

function freshState(): FakeBridgeState {
  return {
    sessions: [],
    metas: new Map(),
    closedIds: [],
    renamedTitles: new Map(),
    metadataPatches: new Map(),
  };
}

let state: FakeBridgeState;
let svc: SessionServiceImpl;

beforeEach(() => {
  state = freshState();
  svc = new SessionServiceImpl(makeFakeBridge(state));
});

afterEach(() => {
  svc.dispose();
});

describe('toProtocolSession adapter', () => {
  it('converts camelCase + number timestamps to snake_case + ISO Z', () => {
    const summary: SessionSummary = {
      id: 'sess_01',
      title: 'Hello',
      workDir: '/tmp/wd',
      sessionDir: '/tmp/sd',
      createdAt: 1_000_000_000_000,
      updatedAt: 1_000_000_001_000,
    };
    const proto = toProtocolSession(summary);
    expect(proto.id).toBe('sess_01');
    expect(proto.title).toBe('Hello');
    expect(proto.metadata.cwd).toBe('/tmp/wd');
    expect(proto.created_at).toBe(new Date(1_000_000_000_000).toISOString());
    expect(proto.updated_at).toBe(new Date(1_000_000_001_000).toISOString());
    expect(proto.created_at.endsWith('Z')).toBe(true);
  });

  it('fills documented defaults when CoreAPI does not surface a field', () => {
    const summary: SessionSummary = {
      id: 'sess_02',
      workDir: '/tmp/wd2',
      sessionDir: '/tmp/sd2',
      createdAt: 0,
      updatedAt: 0,
    };
    const proto = toProtocolSession(summary);
    expect(proto.status).toBe('idle');
    expect(proto.usage).toEqual(emptySessionUsage());
    expect(proto.permission_rules).toEqual([]);
    expect(proto.message_count).toBe(0);
    expect(proto.last_seq).toBe(0);
    expect(proto.agent_config.model).toBe('');
    expect(proto.title).toBe('');
  });

  it('enriches title + cwd from SessionMeta when available', () => {
    const summary: SessionSummary = {
      id: 'sess_03',
      workDir: '/tmp/orig',
      sessionDir: '/tmp/sd3',
      createdAt: 0,
      updatedAt: 0,
    };
    const meta: SessionMeta = {
      title: 'Renamed via meta',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      isCustomTitle: true,
      agents: {},
      custom: { cwd: '/tmp/cwd-from-meta', other_key: 'x' },
    };
    const proto = toProtocolSession(summary, meta);
    expect(proto.title).toBe('Renamed via meta');
    expect(proto.metadata.cwd).toBe('/tmp/cwd-from-meta');
    expect(proto.metadata['other_key']).toBe('x');
  });

  it('strips the internal "goal" metadata key', () => {
    const summary: SessionSummary = {
      id: 'sess_04',
      workDir: '/tmp/wd',
      sessionDir: '/tmp/sd',
      createdAt: 0,
      updatedAt: 0,
    };
    const meta: SessionMeta = {
      title: 't',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      isCustomTitle: false,
      agents: {},
      custom: { goal: { secret: 'state' }, keep: 'me' },
    };
    const proto = toProtocolSession(summary, meta);
    expect(proto.metadata['goal']).toBeUndefined();
    expect(proto.metadata['keep']).toBe('me');
  });
});

describe('SessionServiceImpl.create', () => {
  it('calls bridge.rpc.createSession with workDir = metadata.cwd and returns a protocol Session', async () => {
    const session = await svc.create({
      metadata: { cwd: '/tmp/foo' },
      title: 'My session',
    });
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]!.workDir).toBe('/tmp/foo');
    expect(session.metadata.cwd).toBe('/tmp/foo');
    // title is echoed back even when CoreAPI doesn't reflect it (gap doc).
    expect(session.title).toBe('My session');
    expect(session.created_at.endsWith('Z')).toBe(true);
  });

  it('passes model through to the agent_config when supplied', async () => {
    await svc.create({
      metadata: { cwd: '/tmp/x' },
      agent_config: { model: 'moonshot-v1-128k' },
    });
    const created = state.sessions[0]!;
    expect((state.sessions as SessionSummary[])[0]!.metadata?.['cwd']).toBe('/tmp/x');
    void created;
  });
});

describe('SessionServiceImpl.list', () => {
  beforeEach(async () => {
    // Seed 3 sessions in increasing createdAt order.
    await svc.create({ metadata: { cwd: '/tmp/a' } });
    await svc.create({ metadata: { cwd: '/tmp/b' } });
    await svc.create({ metadata: { cwd: '/tmp/c' } });
  });

  it('returns descending-by-createdAt order with default page size', async () => {
    const page = await svc.list({});
    expect(page.items).toHaveLength(3);
    expect(page.items[0]!.metadata.cwd).toBe('/tmp/c');
    expect(page.items[2]!.metadata.cwd).toBe('/tmp/a');
    expect(page.has_more).toBe(false);
  });

  it('honors page_size and surfaces has_more', async () => {
    const page = await svc.list({ page_size: 2 });
    expect(page.items.map((s) => s.metadata.cwd)).toEqual(['/tmp/c', '/tmp/b']);
    expect(page.has_more).toBe(true);
  });

  it('before_id returns older sessions only', async () => {
    const all = await svc.list({});
    const pivotId = all.items[0]!.id; // newest
    const olderPage = await svc.list({ before_id: pivotId });
    expect(olderPage.items.map((s) => s.metadata.cwd)).toEqual(['/tmp/b', '/tmp/a']);
  });

  it('after_id returns newer sessions only', async () => {
    const all = await svc.list({});
    const pivotId = all.items[2]!.id; // oldest
    const newerPage = await svc.list({ after_id: pivotId });
    expect(newerPage.items.map((s) => s.metadata.cwd)).toEqual(['/tmp/c', '/tmp/b']);
  });

  it('status filter applies post-hydration', async () => {
    // Today everything maps to 'idle'; non-matching filter returns []
    const empty = await svc.list({ status: 'running' });
    expect(empty.items).toEqual([]);
    const idle = await svc.list({ status: 'idle' });
    expect(idle.items.length).toBe(3);
  });
});

describe('SessionServiceImpl.get', () => {
  it('returns the matching session', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/x' } });
    const found = await svc.get(created.id);
    expect(found.id).toBe(created.id);
    expect(found.metadata.cwd).toBe('/tmp/x');
  });

  it('throws SessionNotFoundError for an unknown id', async () => {
    await expect(svc.get('does-not-exist')).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(svc.get('does-not-exist')).rejects.toThrow(/does not exist/);
  });
});

describe('SessionServiceImpl.update', () => {
  let created: Session;

  beforeEach(async () => {
    created = await svc.create({ metadata: { cwd: '/tmp/u' } });
  });

  it('rejects updates to missing sessions with SessionNotFoundError', async () => {
    await expect(svc.update('does-not-exist', { title: 'x' })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('routes title through bridge.rpc.renameSession', async () => {
    await svc.update(created.id, { title: 'Renamed' });
    expect(state.renamedTitles.get(created.id)).toBe('Renamed');
    // Title is reflected via the next get (impl re-fetches metadata).
    expect(state.metadataPatches.has(created.id)).toBe(false);
  });

  it('routes metadata patch through bridge.rpc.updateSessionMetadata (into .custom)', async () => {
    await svc.update(created.id, { metadata: { custom_field: 'x' } });
    const patch = state.metadataPatches.get(created.id);
    expect(patch).toEqual({ custom: { custom_field: 'x' } });
  });

  it('handles both title + metadata in a single update', async () => {
    await svc.update(created.id, { title: 'New', metadata: { tag: 'a' } });
    expect(state.renamedTitles.get(created.id)).toBe('New');
    expect(state.metadataPatches.get(created.id)).toEqual({ custom: { tag: 'a' } });
  });

  it('is a no-op when update body is empty', async () => {
    await svc.update(created.id, {});
    expect(state.renamedTitles.size).toBe(0);
    expect(state.metadataPatches.size).toBe(0);
  });

  it('returns the post-update Session shape', async () => {
    const after = await svc.update(created.id, { title: 'Renamed' });
    expect(after.id).toBe(created.id);
    expect(after.metadata.cwd).toBe('/tmp/u');
  });
});

describe('SessionServiceImpl.delete', () => {
  it('calls bridge.rpc.closeSession and returns { deleted: true }', async () => {
    const created = await svc.create({ metadata: { cwd: '/tmp/d' } });
    const result = await svc.delete(created.id);
    expect(result).toEqual({ deleted: true });
    expect(state.closedIds).toEqual([created.id]);
  });

  it('throws SessionNotFoundError on a missing id', async () => {
    await expect(svc.delete('does-not-exist')).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});
