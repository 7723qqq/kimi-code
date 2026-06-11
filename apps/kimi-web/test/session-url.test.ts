// apps/kimi-web/test/session-url.test.ts
//
// Session ↔ URL binding without a router: clicking a session pushes
// /sessions/<id>; loading the app honours a deep link (fetching the session
// when it is beyond the first page); back/forward drive selection via
// popstate without re-writing the URL; deleting the active session repairs
// the address bar with replaceState.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, KimiEventHandlers, KimiWebApi } from '../src/api/types';
import { readSessionIdFromLocation, sessionUrl } from '../src/lib/sessionRoute';

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

async function setup(opts: {
  sessions?: AppSession[];
  /** Sessions only reachable via getSession (beyond the first page). */
  extraSessions?: AppSession[];
  /** Sessions that vanish when their transcript is loaded. */
  messageMissingSessions?: string[];
  initialPath?: string;
}) {
  vi.resetModules();
  vi.stubGlobal('WebSocket', class WebSocket {});
  window.history.replaceState(null, '', opts.initialPath ?? '/');

  const listed = opts.sessions ?? [];
  const extras = opts.extraSessions ?? [];
  const messageMissingSessions = new Set(opts.messageMissingSessions ?? []);

  let handlers: KimiEventHandlers | undefined;
  const eventConn = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    bindNextPromptId: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(),
  };
  const api = {
    getHealth: vi.fn(async () => ({ status: 'ok', uptimeSec: 1 })),
    getMeta: vi.fn(async () => ({ daemonVersion: 't', serverId: 's', startedAt: now, capabilities: {} })),
    getAuth: vi.fn(async () => ({ ready: true, defaultModel: 'kimi-test', managedProvider: null })),
    listModels: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => []),
    getFsHome: vi.fn(async () => ({ home: '/home', recentRoots: [] })),
    listSessions: vi.fn(async () => ({ items: listed, hasMore: false })),
    getSession: vi.fn(async (id: string) => {
      const found = extras.find((s) => s.id === id) ?? listed.find((s) => s.id === id);
      if (!found) throw new Error('SESSION_NOT_FOUND');
      return found;
    }),
    deleteSession: vi.fn(async () => ({ deleted: true })),
    listMessages: vi.fn(async (id: string) => {
      if (messageMissingSessions.has(id)) {
        throw { name: 'DaemonApiError', code: 40401, message: `session ${id} does not exist` };
      }
      return { items: [], hasMore: false };
    }),
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

/** Simulate back/forward: the browser changes the URL itself, then fires
    popstate. jsdom's history traversal is unreliable, so emulate directly. */
function firePopState(path: string): void {
  window.history.replaceState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('sessionRoute helpers', () => {
  it('parses /sessions/<id> and nothing else', () => {
    expect(readSessionIdFromLocation({ pathname: '/sessions/abc' })).toBe('abc');
    expect(readSessionIdFromLocation({ pathname: '/sessions/a%2Fb' })).toBe('a/b');
    expect(readSessionIdFromLocation({ pathname: '/' })).toBeUndefined();
    expect(readSessionIdFromLocation({ pathname: '/sessions/' })).toBeUndefined();
    expect(readSessionIdFromLocation({ pathname: '/sessions/a/b' })).toBeUndefined();
    expect(readSessionIdFromLocation({ pathname: '/settings' })).toBeUndefined();
    expect(readSessionIdFromLocation({ pathname: '/sessions/%E0%A4%A' })).toBeUndefined(); // bad escape
  });

  it('builds canonical URLs', () => {
    expect(sessionUrl('abc')).toBe('/sessions/abc');
    expect(sessionUrl(undefined)).toBe('/');
  });
});

describe('session ↔ URL binding', () => {
  it('selectSession pushes /sessions/<id>; re-selecting the same session does not stack entries', async () => {
    const { client } = await setup({ sessions: [session('sess_1'), session('sess_2')] });
    await client.load();
    expect(window.location.pathname).toBe('/sessions/sess_1'); // auto-select → replace

    const lenAfterLoad = window.history.length;
    await client.selectSession('sess_2');
    expect(window.location.pathname).toBe('/sessions/sess_2');
    expect(window.history.length).toBe(lenAfterLoad + 1);

    await client.selectSession('sess_2');
    expect(window.history.length).toBe(lenAfterLoad + 1);
  });

  it('load() honours a deep link to a listed session without adding a history entry', async () => {
    const { client } = await setup({
      sessions: [session('sess_1'), session('sess_2')],
      initialPath: '/sessions/sess_2',
    });
    const lenBefore = window.history.length;
    await client.load();

    expect(client.activeSessionId.value).toBe('sess_2');
    expect(window.location.pathname).toBe('/sessions/sess_2');
    expect(window.history.length).toBe(lenBefore);
  });

  it('load() fetches a deep-linked session beyond the first page via getSession', async () => {
    const old = session('sess_old');
    const { api, client } = await setup({
      sessions: [session('sess_1')],
      extraSessions: [old],
      initialPath: '/sessions/sess_old',
    });
    await client.load();

    expect(api.getSession).toHaveBeenCalledWith('sess_old');
    expect(client.activeSessionId.value).toBe('sess_old');
    // Appended (not prepended) so the recency ordering stays intact.
    expect(client.sessions.value.map((s) => s.id)).toEqual(['sess_1', 'sess_old']);
  });

  it('load() falls back to the most recent session and repairs a dead deep link', async () => {
    const { client } = await setup({
      sessions: [session('sess_1')],
      initialPath: '/sessions/sess_gone',
    });
    await client.load();

    expect(client.activeSessionId.value).toBe('sess_1');
    expect(window.location.pathname).toBe('/sessions/sess_1');
  });

  it('load() repairs a deep link when the listed session vanishes before messages load', async () => {
    const { api, client } = await setup({
      sessions: [session('sess_gone'), session('sess_1')],
      messageMissingSessions: ['sess_gone'],
      initialPath: '/sessions/sess_gone',
    });
    await client.load();

    expect(api.listMessages).toHaveBeenCalledWith('sess_gone', { pageSize: 100 });
    expect(client.activeSessionId.value).toBe('sess_1');
    expect(client.sessions.value.map((s) => s.id)).toEqual(['sess_1']);
    expect(window.location.pathname).toBe('/sessions/sess_1');
    expect(client.warnings.value.some((w) => w.includes('Failed to load messages'))).toBe(false);
  });

  it('popstate selects the session from the URL without writing the URL again', async () => {
    const { client } = await setup({ sessions: [session('sess_1'), session('sess_2')] });
    await client.load();
    await client.selectSession('sess_2');

    const lenBefore = window.history.length;
    firePopState('/sessions/sess_1');
    await vi.waitFor(() => {
      expect(client.activeSessionId.value).toBe('sess_1');
    });
    expect(window.location.pathname).toBe('/sessions/sess_1');
    expect(window.history.length).toBe(lenBefore);
  });

  it('popstate to "/" clears the active session', async () => {
    const { client } = await setup({ sessions: [session('sess_1')] });
    await client.load();
    expect(client.activeSessionId.value).toBe('sess_1');

    firePopState('/');
    expect(client.activeSessionId.value).toBe(''); // composable maps undefined → ''
  });

  it('deleting the active session replaces the URL with the next session', async () => {
    const { client } = await setup({ sessions: [session('sess_1'), session('sess_2')] });
    await client.load();
    expect(client.activeSessionId.value).toBe('sess_1');

    const lenBefore = window.history.length;
    await client.deleteSession('sess_1');

    expect(client.activeSessionId.value).toBe('sess_2');
    expect(window.location.pathname).toBe('/sessions/sess_2');
    expect(window.history.length).toBe(lenBefore);
  });
});
