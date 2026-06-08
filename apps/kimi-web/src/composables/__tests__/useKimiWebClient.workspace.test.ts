// apps/kimi-web/src/composables/__tests__/useKimiWebClient.workspace.test.ts
// Focused tests for the workspace + session redesign behavior in the composable.
// Each test resets modules and injects a fake KimiWebApi so the module-level
// singleton state starts fresh.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, AppWorkspace, KimiWebApi } from '../../api/types';

// A no-op WS connection so selectSession()'s lazy connect doesn't blow up.
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
    model: '',
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

interface FakeApiOverrides {
  sessions?: AppSession[];
  workspaces?: AppWorkspace[];
  createSession?: ReturnType<typeof vi.fn>;
  // Captures the WS handlers passed to connectEvents so a test can feed events.
  captureHandlers?: (h: import('../../api/types').KimiEventHandlers) => void;
}

function makeFakeApi(o: FakeApiOverrides = {}): KimiWebApi {
  const sessions = o.sessions ?? [];
  return {
    getHealth: vi.fn().mockResolvedValue({ status: 'ok', uptimeSec: 0 }),
    getMeta: vi.fn().mockResolvedValue({ daemonVersion: 'x', serverId: 's', startedAt: '', capabilities: {} }),
    listSessions: vi.fn().mockResolvedValue({ items: sessions, hasMore: false }),
    createSession: o.createSession ?? vi.fn(),
    updateSession: vi.fn(),
    deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
    listMessages: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    submitPrompt: vi.fn(),
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
    connectEvents: vi.fn().mockImplementation((handlers) => {
      o.captureHandlers?.(handlers);
      return fakeConn;
    }),
    listWorkspaces: vi.fn().mockResolvedValue(o.workspaces ?? []),
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

// Mock the api singleton factory; each test sets `currentApi` before importing.
vi.mock('../../api', () => ({
  getKimiWebApi: () => currentApi,
}));

async function freshClient(api: KimiWebApi) {
  currentApi = api;
  vi.resetModules();
  // Re-mock after resetModules so the freshly-imported composable sees it.
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

describe('useKimiWebClient — workspaces', () => {
  it('listWorkspaces 404s → workspaces are DERIVED from session cwds', async () => {
    const api = makeFakeApi({
      sessions: [
        mkSession('a', '/Users/me/projA'),
        mkSession('b', '/Users/me/projA'),
        mkSession('c', '/Users/me/projB'),
      ],
      workspaces: [], // simulates /workspaces returning empty / 404
    });
    const client = await freshClient(api);
    await client.load();

    const ws = client.workspacesView.value;
    // Two distinct cwds → two derived workspaces.
    expect(ws.map((w) => w.root).sort()).toEqual([
      '/Users/me/projA',
      '/Users/me/projB',
    ]);
    const projA = ws.find((w) => w.root === '/Users/me/projA')!;
    expect(projA.name).toBe('projA');
    expect(projA.sessionCount).toBe(2);
    expect(projA.shortPath).toBe('~/projA');
  });

  it('sessionsForView filters by the active workspace in current scope', async () => {
    const api = makeFakeApi({
      sessions: [
        mkSession('a', '/Users/me/projA'),
        mkSession('b', '/Users/me/projB'),
        mkSession('c', '/Users/me/projA'),
      ],
    });
    const client = await freshClient(api);
    await client.load();

    client.selectWorkspace('/Users/me/projA');
    expect(client.sessionsForView.value.map((s) => s.id).sort()).toEqual(['a', 'c']);

    client.selectWorkspace('/Users/me/projB');
    expect(client.sessionsForView.value.map((s) => s.id)).toEqual(['b']);

    // 'all' scope returns every session.
    client.setWorkspaceScope('all');
    expect(client.sessionsForView.value.map((s) => s.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('selectSession loads the session messages directly (persisted sessions are promptable)', async () => {
    const api = makeFakeApi({ sessions: [mkSession('a', '/Users/me/projA')] });
    const client = await freshClient(api);
    await client.load();
    (api.listMessages as ReturnType<typeof vi.fn>).mockClear();
    await client.selectSession('a');
    expect(api.listMessages).toHaveBeenCalledWith('a', expect.anything());
  });

  it('attentionBySession counts pending approvals per session', async () => {
    let handlers: import('../../api/types').KimiEventHandlers | null = null;
    const api = makeFakeApi({
      sessions: [mkSession('a', '/Users/me/projA')],
      captureHandlers: (h) => {
        handlers = h;
      },
    });
    const client = await freshClient(api);
    await client.load(); // auto-selects 'a' → connectEvents → captures handlers

    expect(handlers).not.toBeNull();
    // Feed an approvalRequested event for session 'a'.
    handlers!.onEvent(
      {
        type: 'approvalRequested',
        sessionId: 'a',
        approval: {
          approvalId: 'ap1',
          sessionId: 'a',
          toolCallId: 'tc1',
          toolName: 'bash',
          action: 'run',
          display: {},
          expiresAt: '',
          createdAt: '',
        },
      },
      { sessionId: 'a', seq: 1 },
    );

    expect(client.attentionBySession.value['a']).toBe(1);
  });

  it('attentionByWorkspace sums attentionBySession over a workspace sessions', async () => {
    let handlers: import('../../api/types').KimiEventHandlers | null = null;
    // Two sessions in projA (same cwd → same workspace), one in projB.
    const api = makeFakeApi({
      sessions: [
        mkSession('a', '/Users/me/projA'),
        mkSession('b', '/Users/me/projA'),
        mkSession('c', '/Users/me/projB'),
      ],
      captureHandlers: (h) => {
        handlers = h;
      },
    });
    const client = await freshClient(api);
    await client.load();

    expect(handlers).not.toBeNull();
    const approval = (sid: string, approvalId: string) =>
      handlers!.onEvent(
        {
          type: 'approvalRequested',
          sessionId: sid,
          approval: {
            approvalId,
            sessionId: sid,
            toolCallId: `tc_${approvalId}`,
            toolName: 'bash',
            action: 'run',
            display: {},
            expiresAt: '',
            createdAt: '',
          },
        },
        { sessionId: sid, seq: 1 },
      );

    // One pending approval on 'a', one on 'b' (both projA), one on 'c' (projB).
    approval('a', 'ap_a');
    approval('b', 'ap_b');
    approval('c', 'ap_c');

    const byWs = client.attentionByWorkspace.value;
    // projA workspace id = its cwd in derived mode.
    expect(byWs['/Users/me/projA']).toBe(2);
    expect(byWs['/Users/me/projB']).toBe(1);
  });

  it('createSessionInWorkspace creates a session with workspaceId + cwd=root', async () => {
    const created = mkSession('new', '/Users/me/projA');
    const createSession = vi.fn().mockResolvedValue(created);
    const api = makeFakeApi({
      sessions: [mkSession('a', '/Users/me/projA')],
      createSession,
    });
    const client = await freshClient(api);
    await client.load();

    await client.createSessionInWorkspace('/Users/me/projA');
    expect(createSession).toHaveBeenCalledWith({
      workspaceId: '/Users/me/projA',
      cwd: '/Users/me/projA',
    });
    // Newly-created session is prepended + selected.
    expect(client.activeSessionId.value).toBe('new');
  });
});
