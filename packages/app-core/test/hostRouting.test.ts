import { rejects } from 'node:assert/strict';
import type { Mock } from 'bun:test';
import { rejectionOf } from '../../vite-preset/test/promises';
import { describe, expect, it, mock } from 'bun:test';

import { HostRouter, type HostRoutingControls } from '../src/api/hostRouting';
import type { DaemonKimiWebApi } from '../src/api/daemon/client';
import type { AppHost, AppWorkspace, KimiEventHandlers, KimiWebApi } from '../src/api/types';

function workspace(id: string, root = `/${id}`): AppWorkspace {
  return {
    id,
    root,
    name: id,
    kind: 'managed',
    additionalDirs: [],
    sessionCount: 0,
  } as AppWorkspace;
}

function connection() {
  return {
    subscribeConversation: mock(),
    unsubscribeConversation: mock(),
    watchTaskOutput: mock(),
    unwatchTaskOutput: mock(),
    stopTask: mock(),
    backgroundTask: mock(),
    health: mock(() => ({ connected: true, open: true, stale: false })),
    reconnect: mock(),
    close: mock(),
  };
}

function client(workspaces: AppWorkspace[], overrides: Record<string, unknown> = {}) {
  const stream = connection();
  return {
    stream,
    api: {
      listHosts: mock(async () => [] as AppHost[]),
      listHostSshConfig: mock(async () => ({ configPath: '', exists: false, hosts: [] })),
      connectHost: mock(async () => undefined),
      listWorkspaces: mock(async () => workspaces),
      listModels: mock(async () => [{ id: 'model' }]),
      readHostFileContent: mock(async () => ({ content: 'file' })),
      uploadFile: mock(async () => ({ id: 'file' })),
      getFileUrl: mock(() => 'url'),
      putHost: mock(async () => undefined),
      testHost: mock(async () => ({ connected: true })),
      submitPrompt: mock(async () => ({})),
      updateSession: mock(async () => ({})),
      getPluginInfo: mock(async () => ({})),
      listCapabilities: mock(async () => []),
      getAuth: mock(async () => ({})),
      getUserInfo: mock(async () => ({})),
      getUsage: mock(async () => ({})),
      deleteWorkspace: mock(async () => undefined),
      openInApp: mock(async () => undefined),
      getConfig: mock(async () => ({ providers: {}, defaultModel: 'local-model' })),
      setConfig: mock(async () => ({ providers: {} })),
      addWorkspace: mock(async () => workspace('created', '/created')),
      browseFs: mock(async () => ({ path: '/', parent: null, entries: [] })),
      createSession: mock(async () => ({ id: 'new-session' })),
      getSession: mock(async (id: string) => ({ id })),
      findSession: mock(async (id: string): Promise<{ id: string; hostId?: string }> => ({ id })),
      listSessions: mock(async () => ({ items: [], hasMore: false, nextPageToken: null, total: 0 })),
      archiveSessions: mock(async (ids: string[]) => ({ results: ids.map((id) => ({ id, ok: true })) })),
      restoreSessions: mock(async (ids: string[]) => ({ results: ids.map((id) => ({ id, ok: true })) })),
      getSessionMediaUrl: mock(() => 'local-media-url'),
      connectEvents: mock(() => stream),
      dispose: mock(),
      ...overrides,
    },
  };
}

function host(id: string, status: AppHost['status'] = 'ready', extra: Partial<AppHost> = {}): AppHost {
  return { id, host: id, status, ...extra };
}

async function setup(records: AppHost[] = [host('dev')], remoteWorkspaces = [workspace('remote-ws')]) {
  const local = client([workspace('local-ws'), ...remoteWorkspaces.map((item) => ({ ...item, hostId: 'dev' }))]);
  local.api.listHosts.mockResolvedValue(records);
  const remote = client(remoteWorkspaces);
  const router = new HostRouter(local.api as unknown as DaemonKimiWebApi, () => remote.api as unknown as DaemonKimiWebApi);
  const api = router.createApi() as KimiWebApi & HostRoutingControls;
  return { local, remote, api };
}

describe('HostRouter', () => {
  it('sends plain calls to this machine without waiting for host discovery', async () => {
    const { api, local } = await setup();
    local.api.listHosts.mockReturnValue(new Promise(() => undefined) as never);

    await api.readHostFileContent('/file');

    expect(local.api.readHostFileContent).toHaveBeenCalledWith('/file');
  });

  it('takes the projects of every host from this machine as the server tagged them', async () => {
    const { api, remote } = await setup();
    const workspaces = await api.listWorkspaces();

    expect(workspaces.map((item) => [item.id, item.hostId])).toEqual([
      ['local-ws', undefined],
      ['remote-ws', 'dev'],
    ]);
    expect(remote.api.listWorkspaces).not.toHaveBeenCalled();
  });

  it('routes each call by what it targets, never by the open project', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();

    await api.listModels();
    await api.readHostFileContent('/same/path');
    await api.uploadFile({ file: new Blob(['x']) });
    await api.getPluginInfo('plugin');
    await api.listCapabilities();
    await api.getAuth();
    await api.getUserInfo();
    await api.getUsage();
    await api.setConfig({ defaultModel: 'model' });
    await api.putHost('dev', { host: 'dev' });
    await api.testHost({ host: 'dev' });

    for (const method of ['listModels', 'readHostFileContent', 'uploadFile', 'getPluginInfo', 'listCapabilities', 'getAuth', 'getUserInfo', 'getUsage', 'setConfig', 'putHost', 'testHost'] as const) {
      expect(local.api[method]).toHaveBeenCalledTimes(1);
      expect(remote.api[method]).not.toHaveBeenCalled();
    }
  });

  it('keeps an uploaded file on the host it was uploaded to', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();
    remote.api.uploadFile.mockResolvedValue({ id: 'remote-file' });

    const uploaded = await api.uploadFile({ file: new Blob(['x']), hostId: 'dev' });
    api.getFileUrl(uploaded.id);
    api.getFileUrl('local-file');

    expect(remote.api.uploadFile).toHaveBeenCalledWith({ file: expect.any(Blob) });
    expect(remote.api.getFileUrl).toHaveBeenCalledWith('remote-file');
    expect(local.api.getFileUrl).toHaveBeenCalledWith('local-file');
  });

  it('keeps a session on its host after the active project changes', async () => {
    const { api, remote, local } = await setup();
    await api.listWorkspaces();
    const session = await api.createSession({ workspaceId: 'remote-ws' });

    await api.submitPrompt(session.id, {} as never);

    expect(remote.api.submitPrompt).toHaveBeenCalledTimes(1);
    expect(local.api.submitPrompt).not.toHaveBeenCalled();
  });

  it('creates remote projects on the host as local projects there', async () => {
    const { api, remote } = await setup();
    await api.listWorkspaces();

    const created = await api.addWorkspace({ root: '/created', idempotencyKey: 'key', hostId: 'dev' });

    expect(remote.api.addWorkspace).toHaveBeenCalledWith({ root: '/created', idempotencyKey: 'key' });
    expect(created.hostId).toBe('dev');
  });

  it('forgets a removed host', async () => {
    const { api, local } = await setup();
    await api.listWorkspaces();
    local.api.listHosts.mockResolvedValue([]);

    await api.listHosts();

    expect(() => api.deviceApi('dev')).toThrow('not configured');
  });

  it('does not create a host when connecting', async () => {
    const { api, local } = await setup();
    local.api.connectHost.mockResolvedValue(host('dev') as never);

    expect(await api.connectHost('dev')).toMatchObject({ id: 'dev' });
    expect(local.api.connectHost).toHaveBeenCalledWith('dev');
    expect(local.api.putHost).not.toHaveBeenCalled();
  });

  it('hands out the API of an explicitly picked device', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();

    await api.deviceApi('dev').browseFs('/srv');
    await api.deviceApi(undefined).browseFs('/home');

    expect(remote.api.browseFs).toHaveBeenCalledWith('/srv');
    expect(local.api.browseFs).toHaveBeenCalledWith('/home');
  });

  it('creates host sessions with exactly the input it is given', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();

    await api.createSession({ workspaceId: 'remote-ws', planMode: true });
    await api.createSession({ workspaceId: 'local-ws' });

    expect(remote.api.createSession).toHaveBeenCalledWith({ workspaceId: 'remote-ws', planMode: true });
    expect(local.api.createSession).toHaveBeenCalledWith({ workspaceId: 'local-ws' });
    expect(local.api.getConfig).not.toHaveBeenCalled();
  });

  it('reports the host list whenever it changes', async () => {
    const { api, local } = await setup([host('dev', 'pending')]);
    local.api.connectHost.mockResolvedValue(host('dev', 'pending') as never);
    await api.listWorkspaces();
    const handlers = { onEvent: mock(), onError: mock(), onConnectionChange: mock() } as unknown as KimiEventHandlers;
    api.connectEvents(handlers);
    const changes = () => (handlers.onEvent as ReturnType<Mock>).mock.calls.map(([event]) => event);

    local.api.listHosts.mockResolvedValue([host('dev', 'ready')]);
    await api.listHosts();
    await api.listHosts();
    local.api.listHosts.mockResolvedValue([]);
    await api.listHosts();

    expect(changes()).toEqual([
      { type: 'hostsChanged', hosts: [expect.objectContaining({ status: 'pending' })] },
      { type: 'hostsChanged', hosts: [expect.objectContaining({ status: 'ready' })] },
      { type: 'hostsChanged', hosts: [] },
    ]);
  });

  it('leaves connecting pending hosts to the server', async () => {
    const { api, local } = await setup([host('dev', 'pending')]);
    await api.listHosts();

    expect(local.api.connectHost).not.toHaveBeenCalled();
  });

  it('rejects actions that would run on the wrong machine for remote sessions', async () => {
    const { api, remote } = await setup();
    await api.listWorkspaces();
    const session = await api.createSession({ workspaceId: 'remote-ws' });

    await rejects(api.openInApp(session.id, 'editor', '/file'), /remote\x20host/);
    expect(remote.api.openInApp).not.toHaveBeenCalled();
  });

  it('splits batch operations by host', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();
    const session = await api.createSession({ workspaceId: 'remote-ws' });
    const response = await api.archiveSessions(['local-session', session.id]);

    expect(local.api.archiveSessions).toHaveBeenCalledWith(['local-session']);
    expect(remote.api.archiveSessions).toHaveBeenCalledWith([session.id]);
    expect(response.results).toHaveLength(2);
  });

  it('does not send a batch operation to this machine when the owner cannot be determined', async () => {
    const { api, local } = await setup();
    const unavailable = Object.assign(new Error('host offline'), { code: 50005 });
    local.api.findSession.mockRejectedValue(unavailable);

    expect(await rejectionOf(api.archiveSessions(['remote-session']))).toBe(unavailable);
    expect(await rejectionOf(api.restoreSessions(['remote-session']))).toBe(unavailable);
    expect(local.api.archiveSessions).not.toHaveBeenCalled();
    expect(local.api.restoreSessions).not.toHaveBeenCalled();
  });

  it('looks up an unknown session before producing its media URL', async () => {
    const { api, local, remote } = await setup();
    local.api.findSession.mockResolvedValue({ id: 'remote-session', hostId: 'dev' });
    remote.api.getSessionMediaUrl.mockReturnValue('remote-media-url');

    expect(await api.getSessionMediaUrl('remote-session', 'image.png')).toBe('remote-media-url');
    expect(local.api.findSession).toHaveBeenCalledWith('remote-session');
    expect(remote.api.getSessionMediaUrl).toHaveBeenCalledWith('remote-session', 'image.png');
    expect(local.api.getSessionMediaUrl).not.toHaveBeenCalled();
  });

  it('asks this machine which host owns a session it has not seen yet', async () => {
    const { api, local, remote } = await setup();
    local.api.findSession.mockResolvedValue({ id: 'pinned', hostId: 'dev' });

    const [session] = await Promise.all([api.getSession('pinned'), api.submitPrompt('pinned', {} as never)]);
    await api.updateSession('pinned', {});

    expect(session).toEqual({ id: 'pinned', hostId: 'dev' });
    expect(local.api.findSession).toHaveBeenCalledTimes(1);
    expect(local.api.getSession).not.toHaveBeenCalled();
    expect(remote.api.submitPrompt).toHaveBeenCalledWith('pinned', {});
    expect(remote.api.updateSession).toHaveBeenCalledWith('pinned', {});
  });

  it('reports an unreachable owner instead of treating the session as local', async () => {
    const { api, local } = await setup();
    const unavailable = Object.assign(new Error('host offline'), { code: 50005 });
    local.api.findSession.mockRejectedValueOnce(unavailable).mockResolvedValueOnce({ id: 'pinned' });

    expect(await rejectionOf(api.submitPrompt('pinned', {} as never))).toBe(unavailable);
    expect(local.api.submitPrompt).not.toHaveBeenCalled();
    await api.submitPrompt('pinned', {} as never);
    expect(local.api.findSession).toHaveBeenCalledTimes(2);
    expect(local.api.submitPrompt).toHaveBeenCalledWith('pinned', {});
  });

  it('sends sessions straight to this machine when no host is configured', async () => {
    const { api, local } = await setup([]);

    await api.getSession('plain');

    expect(local.api.findSession).not.toHaveBeenCalled();
    expect(local.api.getSession).toHaveBeenCalledWith('plain');
  });

  it('lists sessions of every host through this machine and routes them by the host the server named', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();
    local.api.listSessions.mockResolvedValue({
      items: [{ id: 'listed-remote', hostId: 'dev' }, { id: 'listed-local' }],
      hasMore: true,
      nextPageToken: 'merged',
      total: 2,
    } as never);

    const page = await api.listSessions({ pageToken: 'previous' });
    await api.submitPrompt('listed-remote', {} as never);
    await api.submitPrompt('listed-local', {} as never);

    expect(page.nextPageToken).toBe('merged');
    expect(local.api.listSessions).toHaveBeenCalledWith({ pageToken: 'previous' });
    expect(remote.api.listSessions).not.toHaveBeenCalled();
    expect(remote.api.submitPrompt).toHaveBeenCalledWith('listed-remote', {});
    expect(local.api.submitPrompt).toHaveBeenCalledWith('listed-local', {});
  });

  it('routes grouped sessions by the host the server named', async () => {
    const { api, local, remote } = await setup();
    local.api.listSessionGroups = mock(async () => ({
      groups: [{ workspaceId: 'remote-ws', sessions: [{ id: 'grouped-remote', hostId: 'dev' }], total: 1 }],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    }));

    await api.listSessionGroups({ groupPageSize: 5 }, { background: true });
    await api.submitPrompt('grouped-remote', {} as never);

    expect(remote.api.submitPrompt).toHaveBeenCalledWith('grouped-remote', {});
    expect(local.api.submitPrompt).not.toHaveBeenCalled();
  });

  it('applies a host status event without polling', async () => {
    const { api, local } = await setup([host('dev', 'pending')]);
    await api.listWorkspaces();
    let captured: KimiEventHandlers | undefined;
    local.api.connectEvents.mockImplementation((next: KimiEventHandlers) => {
      captured = next;
      return local.stream;
    });
    const handlers = { onEvent: mock(), onError: mock(), onConnectionChange: mock() } as unknown as KimiEventHandlers;
    api.connectEvents(handlers);
    (handlers.onEvent as ReturnType<Mock>).mockClear();
    const listCalls = local.api.listHosts.mock.calls.length;

    captured!.onEvent({ type: 'hostsChanged', hosts: [host('dev', 'ready')] }, { sessionId: '' });

    expect(handlers.onEvent).toHaveBeenCalledWith(
      { type: 'hostsChanged', hosts: [expect.objectContaining({ status: 'ready' })] },
      { sessionId: '' },
    );
    expect(local.api.listHosts.mock.calls.length).toBe(listCalls);
  });

  it('forwards remote account and plugin events tagged with their host', async () => {
    const { api, remote } = await setup();
    await api.listWorkspaces();
    const handlers = { onEvent: mock(), onError: mock(), onConnectionChange: mock() } as unknown as KimiEventHandlers;
    api.connectEvents(handlers);
    const hostHandlers = (remote.api.connectEvents.mock.calls as unknown as [KimiEventHandlers][])[0]![0];

    hostHandlers.onEvent({ type: 'configChanged', changedFields: ['providers'], config: { providers: {} } }, { sessionId: '' });
    hostHandlers.onEvent({ type: 'modelCatalogChanged', changed: [], unchanged: [], failed: [] }, { sessionId: '' });
    hostHandlers.onEvent({ type: 'pluginsChanged' }, { sessionId: '' });
    hostHandlers.onEvent({ type: 'capabilityChanged', capabilityId: 'notify', install: true }, { sessionId: '' });

    expect(handlers.onEvent.mock.calls.slice(1).map(([event, meta]) => [event.type, meta.hostId])).toEqual([
      ['configChanged', 'dev'],
      ['modelCatalogChanged', 'dev'],
      ['pluginsChanged', 'dev'],
      ['capabilityChanged', 'dev'],
    ]);
  });

  it('reports the first connect of a host stream so late hosts get loaded', async () => {
    const { api, remote } = await setup();
    await api.listWorkspaces();
    const handlers = { onEvent: mock(), onError: mock(), onConnectionChange: mock() } as unknown as KimiEventHandlers;

    api.connectEvents(handlers);
    const hostHandlers = (remote.api.connectEvents.mock.calls as unknown as [KimiEventHandlers][])[0]![0];
    hostHandlers.onConnectionChange(true);
    hostHandlers.onConnectionChange(true);
    expect(handlers.onConnectionChange).toHaveBeenCalledTimes(1);

    hostHandlers.onConnectionChange(false);
    hostHandlers.onConnectionChange(true);
    expect(handlers.onConnectionChange).toHaveBeenCalledTimes(2);
    expect(handlers.onConnectionChange).not.toHaveBeenCalledWith(false);
  });

  it('dispatches conversation subscriptions to the stream of the session host', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();
    const session = await api.createSession({ workspaceId: 'remote-ws' });
    const handlers = { onEvent: mock(), onError: mock(), onConnectionChange: mock() } as unknown as KimiEventHandlers;
    let hostHandlers: KimiEventHandlers | undefined;
    remote.api.connectEvents.mockImplementation((next: KimiEventHandlers) => {
      hostHandlers = next;
      return remote.stream;
    });

    const events = api.connectEvents(handlers);
    hostHandlers!.onEvent({ type: 'sessionMetaUpdated', sessionId: session.id, title: 'Remote session' }, { sessionId: session.id });
    await api.submitPrompt(session.id, {} as never);
    expect(remote.api.submitPrompt).toHaveBeenCalledTimes(1);
    events.subscribeConversation(session.id, 'main');
    events.subscribeConversation('local-session', 'main');

    expect(remote.stream.subscribeConversation).toHaveBeenCalledWith(session.id, 'main');
    expect(local.stream.subscribeConversation).toHaveBeenCalledWith('local-session', 'main');
  });

  it('closes the stream of a disconnected host without surfacing WebSocket errors and resubscribes once ready', async () => {
    const { api, local, remote } = await setup();
    await api.listWorkspaces();
    const session = await api.createSession({ workspaceId: 'remote-ws' });
    const handlers = { onEvent: mock(), onError: mock(), onConnectionChange: mock() } as unknown as KimiEventHandlers;
    let localHandlers: KimiEventHandlers | undefined;
    let hostHandlers: KimiEventHandlers | undefined;
    local.api.connectEvents.mockImplementation((next: KimiEventHandlers) => {
      localHandlers = next;
      return local.stream;
    });
    remote.api.connectEvents.mockImplementation((next: KimiEventHandlers) => {
      hostHandlers = next;
      return remote.stream;
    });

    const events = api.connectEvents(handlers);
    events.subscribeConversation(session.id, 'main');
    events.watchTaskOutput(session.id, 'main', 'task-1');
    hostHandlers!.onError(0, 'WebSocket error', false);
    expect(handlers.onError).not.toHaveBeenCalled();

    localHandlers!.onEvent(
      { type: 'hostsChanged', hosts: [{ id: 'dev', host: 'dev.example.test', status: 'disconnected', connectError: 'Connection reset' }] },
      { sessionId: '' },
    );
    expect(remote.stream.close).toHaveBeenCalledTimes(1);

    remote.stream.subscribeConversation.mockClear();
    remote.stream.watchTaskOutput.mockClear();
    local.stream.subscribeConversation.mockClear();
    events.subscribeConversation(session.id, 'sub-1');
    expect(local.stream.subscribeConversation).not.toHaveBeenCalled();

    localHandlers!.onEvent(
      { type: 'hostsChanged', hosts: [{ id: 'dev', host: 'dev.example.test', status: 'ready' }] },
      { sessionId: '' },
    );
    expect(remote.api.connectEvents).toHaveBeenCalledTimes(2);
    expect(remote.stream.subscribeConversation).toHaveBeenCalledWith(session.id, 'main');
    expect(remote.stream.subscribeConversation).toHaveBeenCalledWith(session.id, 'sub-1');
    expect(remote.stream.watchTaskOutput).toHaveBeenCalledWith(session.id, 'main', 'task-1');

    remote.stream.subscribeConversation.mockClear();
    remote.stream.watchTaskOutput.mockClear();
    localHandlers!.onEvent(
      { type: 'hostsChanged', hosts: [] },
      { sessionId: '' },
    );
    local.api.listWorkspaces.mockResolvedValue([workspace('local-ws'), { ...workspace('remote-ws'), hostId: 'dev-readded' }]);
    remote.api.listSessions.mockResolvedValue({ items: [{ id: session.id }], hasMore: false, nextPageToken: null, total: 1 } as never);
    localHandlers!.onEvent(
      { type: 'hostsChanged', hosts: [{ id: 'dev-readded', host: 'dev.example.test', status: 'ready' }] },
      { sessionId: '' },
    );
    await api.listWorkspaces();
    await api.listSessions({ workspaceId: 'remote-ws' });
    expect(remote.stream.subscribeConversation).toHaveBeenCalledWith(session.id, 'main');
    expect(remote.stream.subscribeConversation).toHaveBeenCalledWith(session.id, 'sub-1');
    expect(remote.stream.watchTaskOutput).toHaveBeenCalledWith(session.id, 'main', 'task-1');
  });
});
