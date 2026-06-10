// apps/kimi-web/test/steer.test.ts
//
// steerPrompt (TUI ctrl+s parity): while a turn is running, the composer text
// plus any locally queued prompts merge into ONE message that is submitted
// (daemon parks it) and then steered into the active turn. When the session is
// idle it degrades to a normal send.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, KimiEventHandlers, KimiWebApi } from '../src/api/types';

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

async function setup(opts?: { submitStatuses?: ('running' | 'queued')[] }) {
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
  const statuses = [...(opts?.submitStatuses ?? [])];
  let promptN = 0;
  const created = session('sess_1');
  const api = {
    createSession: vi.fn(async () => created),
    listMessages: vi.fn(async () => ({ items: [], hasMore: false })),
    submitPrompt: vi.fn(async () => {
      promptN += 1;
      return {
        promptId: `pr_${promptN}`,
        userMessageId: `msg_real_${promptN}`,
        status: statuses.shift() ?? 'running',
      };
    }),
    steerPrompts: vi.fn(async (_sid: string, ids: string[]) => ({ steered: true, promptIds: ids })),
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

describe('steerPrompt', () => {
  it('submits then steers the parked prompt while a turn is running', async () => {
    const { api, client } = await setup({ submitStatuses: ['running', 'queued'] });
    await client.createSession('/repo');
    await client.sendPrompt('first');            // turn in flight
    await client.steerPrompt('change of plan');  // steer into it

    expect(api.submitPrompt).toHaveBeenCalledTimes(2);
    expect(api.steerPrompts).toHaveBeenCalledWith('sess_1', ['pr_2']);
    // The steered text shows up in the transcript like any user message.
    const userTurns = client.turns.value.filter((t) => t.role === 'user');
    expect(userTurns.map((t) => t.text)).toEqual(['first', 'change of plan']);
  });

  it('merges queued prompts + live text into one steered message and clears the queue', async () => {
    const { api, client } = await setup({ submitStatuses: ['running', 'queued'] });
    await client.createSession('/repo');
    await client.sendPrompt('first');
    await client.sendPrompt('queued idea');      // running → goes to the local queue
    expect(client.queued.value).toHaveLength(1);

    await client.steerPrompt('and do this now');

    expect(client.queued.value).toHaveLength(0);
    const submitted = (api.submitPrompt as ReturnType<typeof vi.fn>).mock.calls[1]![1] as {
      content: { type: string; text?: string }[];
    };
    expect(submitted.content).toEqual([{ type: 'text', text: 'queued idea\n\nand do this now' }]);
    expect(api.steerPrompts).toHaveBeenCalledTimes(1);
  });

  it('degrades to a normal send when the session is idle', async () => {
    const { api, client, getHandlers } = await setup({ submitStatuses: ['running', 'running'] });
    await client.createSession('/repo');
    await client.sendPrompt('first');
    // Turn ends → session back to idle.
    getHandlers().onEvent(
      { type: 'sessionStatusChanged', sessionId: 'sess_1', status: 'idle', previousStatus: 'running' },
      { sessionId: 'sess_1', seq: 5 },
    );

    await client.steerPrompt('just send it');

    expect(api.steerPrompts).not.toHaveBeenCalled();
    expect(api.submitPrompt).toHaveBeenCalledTimes(2);
  });

  it('treats a steer race (turn ended between submit and steer) as success', async () => {
    const { api, client } = await setup({ submitStatuses: ['running', 'queued'] });
    (api.steerPrompts as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('PROMPT_NOT_FOUND'));
    await client.createSession('/repo');
    await client.sendPrompt('first');

    await client.steerPrompt('late message');

    // No warning, no transcript rollback — the parked prompt runs as its own turn.
    expect(client.warnings.value).toHaveLength(0);
    const userTurns = client.turns.value.filter((t) => t.role === 'user');
    expect(userTurns.map((t) => t.text)).toEqual(['first', 'late message']);
  });
});
