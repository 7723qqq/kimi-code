/**
 * `GET /api/v1/sessions/{session_id}/snapshot` — atomic-at-a-watermark
 * snapshot shape and watermark consistency.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  IEventSink,
  ISessionLifecycleService,
} from '@moonshot-ai/agent-core-v2';
import { sessionSnapshotResponseSchema, type AgentEvent } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';

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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    const body = (await res.json()) as { code: number; data: { id: string } };
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function ensureMainAgent(sessionId: string): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    const agents = session!.accessor.get(IAgentLifecycleService);
    if (agents.getHandle('main') === undefined) await agents.createMain();
  }

  function emit(sessionId: string, event: AgentEvent): void {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    const main = session!.accessor.get(IAgentLifecycleService).getHandle('main');
    main!.accessor.get(IEventSink).emit(event);
  }

  async function snapshot(sid: string) {
    const res = await fetch(`${base}/api/v1/sessions/${sid}/snapshot`);
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
      promptMessageId: 'msg_test_prompt_1',
    } as unknown as AgentEvent); // durable → seq 1
    emit(sid, { type: 'assistant.delta', turnId: 1, delta: 'Hello' } as unknown as AgentEvent); // volatile

    const snap = await snapshot(sid);
    expect(snap.as_of_seq).toBe(1);
    expect(snap.in_flight_turn).toMatchObject({
      turn_id: 1,
      assistant_text: 'Hello',
      current_prompt_id: 'msg_test_prompt_1',
    });
  });

  it('returns 404 for an unknown session', async () => {
    const res = await fetch(`${base}/api/v1/sessions/sess_does_not_exist/snapshot`);
    const body = (await res.json()) as { code: number };
    expect(body.code).not.toBe(0);
  });
});
