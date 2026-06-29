import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentLifecycleService,
  IContextMemory,
  ISessionLifecycleService,
  modelResolverSeed,
  SingleModelResolver,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface MessageWire {
  id: string;
  session_id: string;
  role: string;
  content: { type: string; [key: string]: unknown }[];
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface PageWire {
  items: MessageWire[];
  has_more: boolean;
}

describe('server-v2 /api/v1/sessions/{sid}/messages', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-messages-'));
    // Seed a stub IModelResolver so the agent scope can instantiate if a
    // transitive service needs it; IContextMemory itself does not.
    const modelResolver = new SingleModelResolver({
      type: 'openai',
      model: 'stub',
      apiKey: 'stub',
    });
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: modelResolverSeed(modelResolver),
    });
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

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home as string } }),
    });
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  // The main agent scope is not created automatically on session creation
  // (server-v2 gap G10); create it here, then splice messages directly into
  // its IContextMemory to bypass the LLM loop.
  async function seedMainAgentMessages(
    sessionId: string,
    messages: Parameters<IContextMemory['splice']>[2],
  ): Promise<void> {
    const session = server!.core.accessor.get(ISessionLifecycleService).get(sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    let agent = session.accessor.get(IAgentLifecycleService).getHandle('main');
    if (agent === undefined) {
      agent = await session.accessor.get(IAgentLifecycleService).createMain();
    }
    if (messages.length > 0) {
      agent.accessor.get(IContextMemory).splice(0, 0, messages);
    }
  }

  const messageId = (sid: string, index: number): string =>
    `msg_${sid}_${String(index).padStart(6, '0')}`;

  it('returns an empty page when the session has no main agent', async () => {
    const id = await createSession();
    const { body } = await getJson<PageWire>(`/api/v1/sessions/${id}/messages`);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
    expect(body.data.has_more).toBe(false);
  });

  it('returns an empty page when the main agent has no messages yet', async () => {
    const id = await createSession();
    await seedMainAgentMessages(id, []);
    const { body } = await getJson<PageWire>(`/api/v1/sessions/${id}/messages`);
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
  });

  it('lists spliced messages newest-first with derived ids and mapped content', async () => {
    const id = await createSession();
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'running' }],
        toolCalls: [{ type: 'function', id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' }],
      },
      { role: 'tool', content: [{ type: 'text', text: 'file.txt' }], toolCalls: [], toolCallId: 'call_1' },
    ]);

    const { body } = await getJson<PageWire>(`/api/v1/sessions/${id}/messages`);
    expect(body.code).toBe(0);
    expect(body.data.has_more).toBe(false);
    expect(body.data.items.map((m) => m.id)).toEqual([
      messageId(id, 2),
      messageId(id, 1),
      messageId(id, 0),
    ]);
    expect(body.data.items.every((m) => m.session_id === id)).toBe(true);

    // index 0: plain user text.
    expect(body.data.items[2]).toMatchObject({
      id: messageId(id, 0),
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    });

    // index 1: assistant text + a tool_use part parsed from the tool call.
    expect(body.data.items[1]).toMatchObject({
      id: messageId(id, 1),
      role: 'assistant',
      content: [
        { type: 'text', text: 'running' },
        {
          type: 'tool_use',
          tool_call_id: 'call_1',
          tool_name: 'Bash',
          input: { cmd: 'ls' },
        },
      ],
    });

    // index 2: tool result flattened to a single tool_result part.
    expect(body.data.items[0]).toMatchObject({
      id: messageId(id, 2),
      role: 'tool',
      content: [{ type: 'tool_result', tool_call_id: 'call_1', output: 'file.txt' }],
    });
  });

  it('gets a single message by id and 404s for an unknown message', async () => {
    const id = await createSession();
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
    ]);

    const got = await getJson<MessageWire>(
      `/api/v1/sessions/${id}/messages/${messageId(id, 1)}`,
    );
    expect(got.body.code).toBe(0);
    expect(got.body.data).toMatchObject({
      id: messageId(id, 1),
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    });

    const missing = await getJson<null>(
      `/api/v1/sessions/${id}/messages/${messageId(id, 99)}`,
    );
    expect(missing.body.code).toBe(40403);
  });

  it('rejects a message id that belongs to another session (40403)', async () => {
    const id = await createSession();
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);
    const foreignId = messageId('sess_other', 0);
    const { body } = await getJson<null>(`/api/v1/sessions/${id}/messages/${foreignId}`);
    expect(body.code).toBe(40403);
  });

  it('returns 40401 for an unknown session on both endpoints', async () => {
    const list = await getJson<null>('/api/v1/sessions/nope/messages');
    expect(list.body.code).toBe(40401);

    const got = await getJson<null>(`/api/v1/sessions/nope/messages/${messageId('nope', 0)}`);
    expect(got.body.code).toBe(40401);
  });

  it('paginates with page_size and before_id / after_id cursors', async () => {
    const id = await createSession();
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'm0' }], toolCalls: [] },
      { role: 'user', content: [{ type: 'text', text: 'm1' }], toolCalls: [] },
      { role: 'user', content: [{ type: 'text', text: 'm2' }], toolCalls: [] },
    ]);
    const ids = [messageId(id, 0), messageId(id, 1), messageId(id, 2)];

    // page_size=1 → newest only, more available.
    const first = await getJson<PageWire>(`/api/v1/sessions/${id}/messages?page_size=1`);
    expect(first.body.data.items.map((m) => m.id)).toEqual([ids[2]]);
    expect(first.body.data.has_more).toBe(true);

    // before_id = newest → the two older entries.
    const older = await getJson<PageWire>(
      `/api/v1/sessions/${id}/messages?before_id=${ids[2]}`,
    );
    expect(older.body.data.items.map((m) => m.id)).toEqual([ids[1], ids[0]]);
    expect(older.body.data.has_more).toBe(false);

    // after_id = oldest → the two newer entries.
    const newer = await getJson<PageWire>(
      `/api/v1/sessions/${id}/messages?after_id=${ids[0]}`,
    );
    expect(newer.body.data.items.map((m) => m.id)).toEqual([ids[2], ids[1]]);
    expect(newer.body.data.has_more).toBe(false);
  });

  it('filters the page by role after pagination', async () => {
    const id = await createSession();
    await seedMainAgentMessages(id, [
      { role: 'user', content: [{ type: 'text', text: 'q' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'a' }], toolCalls: [] },
      { role: 'user', content: [{ type: 'text', text: 'q2' }], toolCalls: [] },
    ]);
    const { body } = await getJson<PageWire>(`/api/v1/sessions/${id}/messages?role=user`);
    expect(body.code).toBe(0);
    expect(body.data.items.every((m) => m.role === 'user')).toBe(true);
    expect(body.data.items.map((m) => m.id)).toEqual([messageId(id, 2), messageId(id, 0)]);
  });
});
