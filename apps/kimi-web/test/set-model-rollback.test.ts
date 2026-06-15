import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, KimiEventHandlers, KimiWebApi } from '../src/api/types';

const now = '2026-06-11T00:00:00.000Z';

function session(id: string, model: string): AppSession {
  return {
    id,
    title: id,
    createdAt: now,
    updatedAt: now,
    status: 'idle',
    cwd: '/repo',
    model,
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

async function setup(opts: { updateRejects: boolean }) {
  vi.resetModules();
  vi.stubGlobal('WebSocket', class WebSocket {});

  const created = session('sess_1', 'model-old');
  // The daemon's authoritative model — only a successful updateSession moves it.
  let currentModel = 'model-old';
  const eventConn = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    bindNextPromptId: vi.fn(),
    seedSnapshot: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(),
  };
  const api = {
    createSession: vi.fn(async () => created),
    getSessionSnapshot: vi.fn(async () => ({
      asOfSeq: 0,
      epoch: 'ep_test',
      session: created,
      messages: [],
      hasMoreMessages: false,
      inFlightTurn: null,
      pendingApprovals: [],
      pendingQuestions: [],
    })),
    updateSession: vi.fn(async (_sid: string, patch: { model?: string }) => {
      if (opts.updateRejects) throw new Error('daemon unreachable');
      if (patch.model) currentModel = patch.model;
      return session('sess_1', currentModel);
    }),
    getSessionStatus: vi.fn(async () => ({
      model: currentModel,
      thinkingLevel: 'high',
      permission: 'manual',
      planMode: false,
      swarmMode: false,
      contextTokens: 0,
      maxContextTokens: 128_000,
      contextUsage: 0,
    })),
    listTasks: vi.fn(async () => []),
    getGitStatus: vi.fn(async () => ({ branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0 })),
    connectEvents: vi.fn((h: KimiEventHandlers) => {
      void h;
      return eventConn;
    }),
    getFileUrl: vi.fn((fileId: string) => `/files/${fileId}`),
  } as unknown as KimiWebApi;

  vi.doMock('../src/api', () => ({ getKimiWebApi: () => api }));
  const { useKimiWebClient } = await import('../src/composables/useKimiWebClient');
  const client = useKimiWebClient();
  await client.createSession('/repo');
  return { client, api };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('setModel failure handling', () => {
  it('rolls the picker back and warns when the switch cannot reach the daemon', async () => {
    const { client } = await setup({ updateRejects: true });
    expect(client.status.value.modelId).toBe('model-old');

    await client.setModel('model-new');

    // The optimistic pick must not stick — the UI cannot claim a switch that
    // never landed.
    expect(client.status.value.modelId).toBe('model-old');
    expect(client.warnings.value.length).toBeGreaterThan(0);
  });

  it('keeps the new model and does not warn on success', async () => {
    const { client } = await setup({ updateRejects: false });
    await client.setModel('model-new');
    expect(client.status.value.modelId).toBe('model-new');
    expect(client.warnings.value.length).toBe(0);
  });
});
