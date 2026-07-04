/**
 * `GET /api/v1/sessions/{session_id}/snapshot` — atomic-at-a-watermark
 * snapshot shape and watermark consistency.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentContextMemoryService,
  IAgentEventSinkService,
  IAgentLifecycleService,
  ISessionContext,
  ISessionLifecycleService,
} from '@moonshot-ai/agent-core-v2';
import { sessionSnapshotResponseSchema, type AgentEvent } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

describe('server-v2 GET /api/v1/sessions/:id/snapshot', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-snapshot-test-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await res.json()) as { code: number; data: { id: string } };
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function ensureMainAgent(sessionId: string): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    const agents = session!.accessor.get(IAgentLifecycleService);
    if (agents.getHandle('main') === undefined) await agents.create({ agentId: 'main' });
  }

  function emit(sessionId: string, event: AgentEvent): void {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    const main = session!.accessor.get(IAgentLifecycleService).getHandle('main');
    main!.accessor.get(IAgentEventSinkService).emit(event);
  }

  async function snapshot(sid: string) {
    const res = await fetch(`${base}/api/v1/sessions/${sid}/snapshot`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as { code: number; data: unknown };
    expect(body.code).toBe(0);
    return sessionSnapshotResponseSchema.parse(body.data);
  }

  it('returns a well-formed snapshot for a fresh session', async () => {
    const sid = await createSession();
    const snap = await snapshot(sid);

    expect(snap.session.id).toBe(sid);
    expect(snap.as_of_seq).toBe(0);
    expect(snap.epoch).toMatch(/^ep_/);
    expect(snap.messages.items).toEqual([]);
    expect(snap.in_flight_turn).toBeNull();
    expect(snap.pending_approvals).toEqual([]);
    expect(snap.pending_questions).toEqual([]);
  });

  it('reflects the durable watermark and in-flight turn after events', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    await snapshot(sid); // activate the journal (as_of_seq 0)

    emit(sid, {
      type: 'turn.started',
      turnId: 1,
    } as unknown as AgentEvent); // durable → seq 1
    emit(sid, { type: 'assistant.delta', turnId: 1, delta: 'Hello' } as unknown as AgentEvent); // volatile

    const snap = await snapshot(sid);
    expect(snap.as_of_seq).toBe(1);
    expect(snap.in_flight_turn).toMatchObject({
      turn_id: 1,
      assistant_text: 'Hello',
    });
  });

  it('returns 404 for an unknown session', async () => {
    const res = await fetch(`${base}/api/v1/sessions/sess_does_not_exist/snapshot`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as { code: number };
    expect(body.code).not.toBe(0);
  });

  // Regression for the cold-session 404: a session that exists on disk but is
  // not live in this process (e.g. carried over from a prior process, or
  // created by v1) must load from disk instead of returning 40401. We restart
  // the whole server on the same homeDir so the session is genuinely cold.
  it('loads a cold (not live) session from disk instead of 404', async () => {
    const sid = await createSession();

    await server!.close();
    server = undefined;
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;

    // Guard: nothing is live in the new process — the session is cold.
    expect(server!.core.accessor.get(ISessionLifecycleService).get(sid)).toBeUndefined();

    const snap = await snapshot(sid);
    expect(snap.session.id).toBe(sid);
  });

  // Regression for the v1-layout 50001 ("Invalid time value"): v1 persists
  // `createdAt`/`updatedAt` as ISO strings (and omits the v2 `id` field) in
  // `state.json`. Projecting that raw metadata broke message timestamp
  // arithmetic and dropped the session id. `ISessionMetadata` now normalizes
  // legacy documents on load. We rewrite `state.json` in the v1 layout, restart
  // so the session is cold, then seed messages into the live (resumed) context
  // so the snapshot exercises the message-timestamp projection deterministically
  // (no reliance on wire-restore timing).
  it('serves a v1-layout session (ISO timestamps, no id field) without crashing', async () => {
    const sid = await createSession();
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sid);
    if (session === undefined) throw new Error(`session ${sid} not found`);
    const metaScope = session.accessor.get(ISessionContext).metaScope;

    // Shut down, then rewrite state.json in the v1 layout (ISO-string
    // timestamps, no `id`) so the next boot reads a cold legacy session.
    await server!.close();
    server = undefined;
    const statePath = join(home as string, metaScope, 'state.json');
    await writeFile(
      statePath,
      JSON.stringify({
        title: 'v1 session',
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T11:00:00.000Z',
        archived: false,
        custom: { source: 'v1' },
      }),
    );

    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;

    // Resume the cold session, then seed messages into the live context so the
    // snapshot projects message timestamps from the normalized numeric base.
    const resumed = await server!.core.accessor.get(ISessionLifecycleService).resume(sid);
    if (resumed === undefined) throw new Error(`session ${sid} failed to resume`);
    const main = await resumed.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    main.accessor.get(IAgentContextMemoryService).splice(0, 0, [
      { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);

    const snap = await snapshot(sid);
    expect(snap.session.id).toBe(sid);
    expect(snap.session.title).toBe('v1 session');
    // Session- and message-level timestamps are derived from the normalized
    // numeric base — they must be valid ISO strings, not "Invalid time value".
    expect(Number.isNaN(Date.parse(snap.session.created_at))).toBe(false);
    expect(snap.messages.items).toHaveLength(2);
    for (const message of snap.messages.items) {
      expect(Number.isNaN(Date.parse(message.created_at))).toBe(false);
    }
  });
});
