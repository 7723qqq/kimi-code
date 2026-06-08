// apps/kimi-web/src/composables/__tests__/useKimiWebClient.planMode.test.ts
// Focused tests for plan mode: persistence, toggle, and that it's sent on every
// prompt submission (was previously hardcoded false). Each test resets modules
// and injects a fake KimiWebApi so the module-level singleton starts fresh.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, KimiWebApi } from '../../api/types';

const fakeConn = {
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  bindNextPromptId: vi.fn(),
  abort: vi.fn(),
  close: vi.fn(),
};

function mkSession(id: string, cwd: string, opts: Partial<AppSession> = {}): AppSession {
  return {
    id,
    title: id,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    status: 'idle',
    cwd,
    model: 'm',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
    ...opts,
  };
}

function makeFakeApi(sessions: AppSession[], submitPrompt: ReturnType<typeof vi.fn>): KimiWebApi {
  return {
    getHealth: vi.fn().mockResolvedValue({ status: 'ok', uptimeSec: 0 }),
    getMeta: vi.fn().mockResolvedValue({ daemonVersion: 'x', serverId: 's', startedAt: '', capabilities: {} }),
    listSessions: vi.fn().mockResolvedValue({ items: sessions, hasMore: false }),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
    listMessages: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    submitPrompt,
    abortPrompt: vi.fn(),
    respondApproval: vi.fn(),
    respondQuestion: vi.fn(),
    dismissQuestion: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
    cancelTask: vi.fn(),
    listDirectory: vi.fn(),
    readFile: vi.fn(),
    searchFiles: vi.fn(),
    grepFiles: vi.fn(),
    getGitStatus: vi.fn().mockRejectedValue(new Error('no git')),
    connectEvents: vi.fn().mockReturnValue(fakeConn),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    addWorkspace: vi.fn(),
    browseFs: vi.fn().mockResolvedValue({ path: '', parent: null, entries: [] }),
    getFsHome: vi.fn().mockResolvedValue({ home: '/Users/me', recentRoots: [] }),
    listModels: vi.fn().mockResolvedValue([]),
    listProviders: vi.fn().mockResolvedValue([]),
    addProvider: vi.fn(),
    deleteProvider: vi.fn(),
    refreshProvider: vi.fn(),
    uploadFile: vi.fn(),
    getAuth: vi.fn().mockResolvedValue({ ready: true, providersCount: 1, defaultModel: 'm', managedProvider: null }),
    startOAuthLogin: vi.fn(),
    pollOAuthLogin: vi.fn(),
    cancelOAuthLogin: vi.fn(),
    logout: vi.fn(),
  } as unknown as KimiWebApi;
}

let currentApi: KimiWebApi;

vi.mock('../../api', () => ({
  getKimiWebApi: () => currentApi,
}));

async function freshClient(api: KimiWebApi) {
  currentApi = api;
  vi.resetModules();
  vi.doMock('../../api', () => ({ getKimiWebApi: () => api }));
  const mod = await import('../useKimiWebClient');
  return mod.useKimiWebClient();
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.doUnmock('../../api');
});

describe('useKimiWebClient — plan mode', () => {
  it('planMode 默认 false', async () => {
    const client = await freshClient(makeFakeApi([], vi.fn()));
    expect(client.planMode.value).toBe(false);
  });

  it('togglePlanMode 翻转 planMode 并持久化到 localStorage', async () => {
    const client = await freshClient(makeFakeApi([], vi.fn()));
    client.togglePlanMode();
    expect(client.planMode.value).toBe(true);
    expect(localStorage.getItem('kimi-web.plan-mode')).toBe('true');
    client.togglePlanMode();
    expect(client.planMode.value).toBe(false);
    expect(localStorage.getItem('kimi-web.plan-mode')).toBe('false');
  });

  it('setPlanMode(true) 后，提交 prompt 时 planMode 随线上请求发送', async () => {
    const submitPrompt = vi.fn().mockResolvedValue({ promptId: 'pr1', userMessageId: 'um1' });
    const api = makeFakeApi([mkSession('a', '/Users/me/projA')], submitPrompt);
    const client = await freshClient(api);
    await client.load(); // auto-selects 'a'

    client.setPlanMode(true);
    await client.sendPrompt('do the thing');

    expect(submitPrompt).toHaveBeenCalledTimes(1);
    const [, body] = submitPrompt.mock.calls[0]!;
    expect(body.planMode).toBe(true);
  });

  it('planMode 持久化后，重新创建客户端会读回 true', async () => {
    localStorage.setItem('kimi-web.plan-mode', 'true');
    const client = await freshClient(makeFakeApi([], vi.fn()));
    expect(client.planMode.value).toBe(true);
  });

  it('默认（plan off）时提交 prompt 发送 planMode=false', async () => {
    const submitPrompt = vi.fn().mockResolvedValue({ promptId: 'pr1', userMessageId: 'um1' });
    const api = makeFakeApi([mkSession('a', '/Users/me/projA')], submitPrompt);
    const client = await freshClient(api);
    await client.load();

    await client.sendPrompt('hi');
    const [, body] = submitPrompt.mock.calls[0]!;
    expect(body.planMode).toBe(false);
  });
});
