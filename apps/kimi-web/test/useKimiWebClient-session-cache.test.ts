import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppMessage,
  AppSession,
  KimiEventHandlers,
  KimiWebApi,
} from '../src/api/types';

const now = '2026-06-11T00:00:00.000Z';

function session(id: string): AppSession {
  return {
    id,
    title: id,
    createdAt: now,
    updatedAt: now,
    status: 'idle',
    cwd: '/repo',
    model: 'kimi-test',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 128_000,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
  };
}

function userMessage(sessionId: string, id: string): AppMessage {
  return {
    id,
    sessionId,
    role: 'user',
    content: [{ type: 'text', text: id }],
    createdAt: now,
  };
}

async function setup(messages: AppMessage[] = []) {
  vi.resetModules();
  vi.stubGlobal('WebSocket', class WebSocket {});

  let handlers: KimiEventHandlers | undefined;
  const eventConn = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    bindNextPromptId: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(),
  };
  const created = session('sess_1');
  const api = {
    createSession: vi.fn(async () => created),
    listMessages: vi.fn(async () => ({ items: messages, hasMore: false })),
    submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_real' })),
    listTasks: vi.fn(async () => []),
    getGitStatus: vi.fn(async () => ({ branch: 'main', ahead: 0, behind: 0, entries: {} })),
    getSessionStatus: vi.fn(async () => ({
      model: 'kimi-test',
      thinkingLevel: 'high',
      permission: 'manual',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 128_000,
      contextUsage: 0,
    })),
    connectEvents: vi.fn((nextHandlers: KimiEventHandlers) => {
      handlers = nextHandlers;
      return eventConn;
    }),
    getFileUrl: vi.fn((fileId: string) => `/files/${fileId}`),
  } as unknown as KimiWebApi;

  vi.doMock('../src/api', () => ({ getKimiWebApi: () => api }));
  const { useKimiWebClient } = await import('../src/composables/useKimiWebClient');

  return {
    api,
    client: useKimiWebClient(),
    eventConn,
    getHandlers: () => {
      if (!handlers) throw new Error('connectEvents was not called');
      return handlers;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('useKimiWebClient session memory cache', () => {
  it('treats an already loaded empty message array as an L1 hit', async () => {
    const { api, client, eventConn } = await setup([]);

    await client.createSession('/repo');
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(client.sessionLoading.value).toBe(false);

    const secondSelect = client.selectSession('sess_1');

    expect(client.sessionLoading.value).toBe(false);
    await secondSelect;
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(eventConn.subscribe).toHaveBeenLastCalledWith('sess_1', 0);
  });

  it('re-subscribes an L1 hit with the reducer-maintained latest seq', async () => {
    const initial = userMessage('sess_1', 'msg_1');
    const { api, client, eventConn, getHandlers } = await setup([initial]);

    await client.createSession('/repo');
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(eventConn.subscribe).toHaveBeenLastCalledWith('sess_1', 0);

    getHandlers().onEvent(
      { type: 'messageCreated', message: userMessage('sess_1', 'msg_2') },
      { sessionId: 'sess_1', seq: 7 },
    );

    await client.selectSession('sess_1');

    expect(api.listMessages).toHaveBeenCalledTimes(1);
    expect(eventConn.subscribe).toHaveBeenLastCalledWith('sess_1', 7);
  });

  it('keeps the optimistic user turn key stable after submit resolves', async () => {
    const { client, eventConn } = await setup([]);

    await client.createSession('/repo');
    await client.sendPrompt('hello');

    const userTurn = client.turns.value.find((turn) => turn.role === 'user');
    expect(userTurn?.id).toMatch(/^msg_opt_/);
    expect(eventConn.bindNextPromptId).toHaveBeenCalledWith('sess_1', 'pr_1');
  });

  it('merges a user message echo into the optimistic turn instead of appending', async () => {
    const { client, getHandlers } = await setup([]);

    await client.createSession('/repo');
    await client.sendPrompt('hello');
    const optimisticId = client.turns.value.find((turn) => turn.role === 'user')!.id;

    getHandlers().onEvent(
      {
        type: 'messageCreated',
        message: {
          id: 'msg_echo',
          sessionId: 'sess_1',
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          createdAt: now,
          promptId: 'pr_1',
        },
      },
      { sessionId: 'sess_1', seq: 8 },
    );

    const userTurns = client.turns.value.filter((turn) => turn.role === 'user');
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]!.id).toBe(optimisticId);
  });
});
