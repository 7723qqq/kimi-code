
import { rejects } from 'node:assert/strict';
import { stubGlobals } from '../../vite-preset/test/globals';
import { rejectionOf } from '../../vite-preset/test/promises';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { DaemonKimiWebApi } from '../src/api/daemon/client';
import { DaemonApiError, DaemonNetworkError, isDaemonTimeoutError } from '../src/api/errors';
import { HostRouter } from '../src/api/hostRouting';
import type { RestRequestInfo } from '../src/contracts';
import type { AppEvent, AppSessionRatingReport, KimiEventConnection, ReadRequestOptions } from '../src/api/types';

const stubGlobal = stubGlobals();

const stubbedFetch = mock<typeof fetch>();
const tracedRequests: RestRequestInfo[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly OPEN = FakeWebSocket.OPEN;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: CloseEvent) => void) | null = null;

  constructor(_url: string, _protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }

  send(_data: string): void {}

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createApi(origin = 'http://daemon.test'): DaemonKimiWebApi {
  return new DaemonKimiWebApi({
    origin,
    identity: {
      clientId: 'web_test',
      clientName: 'test',
      clientVersion: '0.0.0',
      clientUiMode: 'test',
    },
    tracer: {
      restRequest: (info) => tracedRequests.push(info),
    },
  });
}

describe('DaemonKimiWebApi lists across hosts', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
  });


  function hostAwareApi(includeHosts: boolean): DaemonKimiWebApi {
    return new DaemonKimiWebApi({
      origin: 'http://daemon.test',
      identity: { clientId: 'web_test', clientName: 'test', clientVersion: '0.0.0', clientUiMode: 'test' },
      includeHosts,
    });
  }

  it('asks this machine for every host and keeps the host the server named', async () => {
    stubbedFetch
      .mockResolvedValueOnce(envelope({
        items: [{ id: 'wm_1', root: '/srv/app', name: 'app', kind: 'managed', additional_dirs: [], session_count: 0, host_id: 'dev' }],
      }))
      .mockResolvedValueOnce(envelope({
        items: [{ id: 's1', host_id: 'dev' }],
        has_more: false,
        next_page_token: null,
        total: 1,
      }));
    const api = hostAwareApi(true);

    const workspaces = await api.listWorkspaces();
    const page = await api.listSessionIds({ pageSize: 10 });

    expect(stubbedFetch.mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/workspaces?hosts=include');
    expect(stubbedFetch.mock.calls[1]?.[0]).toBe('http://daemon.test/api/v1/sessions?page_size=10&fields=id%2Carchived&hosts=include');
    expect(workspaces[0]?.hostId).toBe('dev');
    expect(page).toMatchObject({ items: [{ id: 's1', host_id: 'dev' }] });
  });

  it('lists every session of every host at once and finds a session on its host', async () => {
    const wire = (id: string, hostId?: string) => ({
      id,
      title: id,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      activity: 'idle',
      archived: false,
      cwd: '/srv/app',
      ...(hostId === undefined ? {} : { host_id: hostId }),
    });
    stubbedFetch
      .mockResolvedValueOnce(envelope({ items: [wire('s1', 'dev'), wire('s2')], has_more: false, unavailable_hosts: ['off'] }))
      .mockResolvedValueOnce(envelope({ items: [], has_more: false }))
      .mockResolvedValueOnce(envelope(wire('s1', 'dev')));
    const api = hostAwareApi(true);

    const page = await api.listSessions({ hasPrompt: true });
    await api.listSessions({ workspaceId: 'wm_1', pageSize: 20 });
    const found = await api.findSession('s1');

    expect(stubbedFetch.mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/sessions?has_prompt=true&hosts=include');
    expect(stubbedFetch.mock.calls[1]?.[0]).toBe('http://daemon.test/api/v1/sessions?page_size=20&workspace_id=wm_1&hosts=include');
    expect(stubbedFetch.mock.calls[2]?.[0]).toBe('http://daemon.test/api/v1/sessions/s1?hosts=include');
    expect(page.items.map((session) => [session.id, session.hostId])).toEqual([['s1', 'dev'], ['s2', undefined]]);
    expect(page.unavailableHosts).toEqual(['off']);
    expect(found.hostId).toBe('dev');
  });

  it.each([
    ['beforeId', 'before_id'],
    ['afterId', 'after_id'],
  ] as const)('keeps paging a project with %s on its owning daemon', async (cursor, queryKey) => {
    const sessions = Array.from({ length: 6 }, (_, index) => ({
      id: `s${index + 6}`,
      title: 'Test session',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      activity: 'idle',
      cwd: '/srv/app',
    }));
    stubbedFetch
      .mockResolvedValueOnce(envelope({ hosts: [] }))
      .mockResolvedValueOnce(envelope({ items: sessions.slice(0, 5), has_more: true }))
      .mockResolvedValueOnce(envelope({ items: sessions.slice(5), has_more: false }));
    const api = new HostRouter(hostAwareApi(true), () => hostAwareApi(false)).createApi();

    const request = { workspaceId: 'wm_1', pageSize: 5, hasPrompt: true };
    const first = await api.listSessions({ ...request, [cursor]: 's5' });
    expect(first).toMatchObject({ hasMore: true, nextPageToken: null });
    const next = await api.listSessions({ ...request, [cursor]: first.items.at(-1)?.id });
    expect(next).toMatchObject({ items: [{ id: 's11' }], hasMore: false });
    expect(stubbedFetch.mock.calls.map(([url]) => url)).toEqual([
      'http://daemon.test/api/v1/hosts',
      `http://daemon.test/api/v1/sessions?${queryKey}=s5&page_size=5&workspace_id=wm_1&has_prompt=true`,
      `http://daemon.test/api/v1/sessions?${queryKey}=s10&page_size=5&workspace_id=wm_1&has_prompt=true`,
    ]);
  });

  it('never asks a host to list other hosts', async () => {
    stubbedFetch.mockResolvedValue(envelope({ items: [] }));

    await hostAwareApi(false).listWorkspaces();

    expect(stubbedFetch.mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/workspaces');
  });
});

describe('DaemonKimiWebApi.sessionRating', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
  });


  it.each(['session', 'long_context'] as const)('evaluates a transcript turn for %s', async (survey) => {
    stubbedFetch.mockResolvedValue(envelope({ appearance: { id: 'appearance-1', survey } }));

    expect(await createApi().evaluateSessionRating('session/1', 'transcript-turn-4')).toEqual({
      appearanceId: 'appearance-1', survey,
    });
    expect(stubbedFetch.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['http://daemon.test/api/v1/sessions/session%2F1/rating', 'POST', JSON.stringify({
        op: 'evaluate', turn_id: 'transcript-turn-4',
      })],
    ]);
  });

  it('returns no offer when evaluation is declined', async () => {
    stubbedFetch.mockResolvedValue(envelope({ appearance: null }));
    expect(await createApi().evaluateSessionRating('session-1', 'turn-1')).toBeNull();
  });

  it.each([
    { op: 'shown', appearanceId: 'appearance-1' },
    { op: 'abandon', appearanceId: 'appearance-1' },
    { op: 'respond', appearanceId: 'appearance-1', response: 'bad' },
    { op: 'respond', appearanceId: 'appearance-1', response: 'fine' },
    { op: 'respond', appearanceId: 'appearance-1', response: 'good' },
    { op: 'respond', appearanceId: 'appearance-1', response: 'dismissed' },
  ] satisfies AppSessionRatingReport[])('reports $op $response without a view response', async (report) => {
    stubbedFetch.mockResolvedValue(envelope(null));
    await createApi().reportSessionRating('session/1', report);
    expect(stubbedFetch.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['http://daemon.test/api/v1/sessions/session%2F1/rating', 'POST', JSON.stringify({
        op: report.op,
        appearance_id: 'appearance-1',
        response: report.op === 'respond' ? report.response : undefined,
      })],
    ]);
  });

  it('propagates rating errors instead of restoring a server view', async () => {
    stubbedFetch.mockResolvedValue(new Response(JSON.stringify({
      code: 40001, msg: 'Invalid turn', data: null, request_id: 'request-1',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    await rejects(createApi().evaluateSessionRating('session-1', ''), /Invalid\x20turn/);
  });
});

describe('DaemonKimiWebApi.remoteControl', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
  });


  it('uses the local daemon routes for status, toggle, and device management', async () => {
    stubbedFetch.mockImplementation(async () =>
      envelope({
        enabled: false,
        state: 'off',
        devices: [],
        ok: true,
      }),
    );
    const api = createApi();

    await api.getRemoteControlStatus();
    await api.setRemoteControlEnabled(true);
    await api.listRemoteControlDevices();
    await api.renameRemoteControlDevice('device/one', 'Renamed');
    await api.deactivateRemoteControlDevice('device/one');

    expect(stubbedFetch.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['http://daemon.test/api/v1/remote-control', 'GET', undefined],
      ['http://daemon.test/api/v1/remote-control', 'POST', JSON.stringify({ enabled: true })],
      ['http://daemon.test/api/v1/remote-control/devices', 'GET', undefined],
      [
        'http://daemon.test/api/v1/remote-control/devices/device%2Fone',
        'PATCH',
        JSON.stringify({ alias: 'Renamed' }),
      ],
      [
        'http://daemon.test/api/v1/remote-control/devices/device%2Fone/deactivate',
        'POST',
        JSON.stringify({}),
      ],
    ]);
  });

  it('passes daemon errors through to the caller', async () => {
    stubbedFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ code: 50001, msg: 'cloud unavailable', request_id: 'req_rc' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const caught = await createApi()
      .listRemoteControlDevices()
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonApiError);
    expect(caught).toMatchObject({ code: 50001, message: 'cloud unavailable', requestId: 'req_rc' });
  });
});

describe('DaemonKimiWebApi.workspaceTrust', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
  });


  it('reads and writes workspace trust via the workspace routes', async () => {
    stubbedFetch.mockImplementation(async () => envelope({ trusted: true }));
    const api = createApi();

    expect(await api.getWorkspaceTrust('ws/1')).toEqual({ trusted: true });
    expect(await api.trustWorkspace('ws/1')).toEqual({ trusted: true });

    expect(stubbedFetch.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['http://daemon.test/api/v1/workspaces/ws%2F1/trust', 'GET', undefined],
      ['http://daemon.test/api/v1/workspaces/ws%2F1/trust', 'POST', JSON.stringify({})],
    ]);
  });
});

describe('DaemonKimiWebApi host management', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
  });


  it('lists hosts with their connection status', async () => {
    stubbedFetch.mockResolvedValue(envelope({
      hosts: [{ id: 'devbox', host: 'dev@example.test', identity_file: '~/.ssh/id', name: 'Dev', status: 'disconnected', connect_error: 'refused', connect_failure: 'connection_refused' }],
    }));

    expect(await createApi().listHosts()).toEqual([{
      id: 'devbox',
      host: 'dev@example.test',
      identityFile: '~/.ssh/id',
      remoteBin: undefined,
      name: 'Dev',
      enabled: undefined,
      status: 'disconnected',
      remoteVersion: undefined,
      connectError: 'refused',
      connectFailure: 'connection_refused',
    }]);
    expect(stubbedFetch.mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/hosts');
  });
  it('writes, deletes and connects one host by id', async () => {
    stubbedFetch.mockImplementation(async () => envelope({ ok: true, id: 'dev box', host: 'dev@example.test', status: 'ready' }));
    const api = createApi();

    await api.putHost('dev box', { host: 'dev@example.test', remoteBin: '/opt/kimi', enabled: false });
    await api.deleteHost('dev box');
    expect(await api.connectHost('dev box')).toMatchObject({ id: 'dev box', status: 'ready' });

    const calls = stubbedFetch.mock.calls;
    expect(calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['http://daemon.test/api/v1/hosts/dev%20box', 'PUT'],
      ['http://daemon.test/api/v1/hosts/dev%20box', 'DELETE'],
      ['http://daemon.test/api/v1/hosts:connect', 'POST'],
    ]);
    expect(JSON.parse(calls[0]![1]?.body as string)).toEqual({ host: 'dev@example.test', remote_bin: '/opt/kimi', enabled: false });
    expect(JSON.parse(calls[2]![1]?.body as string)).toEqual({ id: 'dev box' });
  });

  it('reports a failed connection test as a result and forwards its abort signal', async () => {
    stubbedFetch.mockResolvedValue(envelope({ connected: false, connect_error: 'Permission denied', connect_failure: 'authentication_failed' }));
    const controller = new AbortController();

    expect(await createApi().testHost({ host: 'dev@example.test', identityFile: '~/.ssh/id' }, { signal: controller.signal })).toEqual({
      connected: false,
      remoteVersion: undefined,
      connectError: 'Permission denied',
      connectFailure: 'authentication_failed',
    });
    const [url, init] = stubbedFetch.mock.calls[0]!;
    expect(url).toBe('http://daemon.test/api/v1/hosts:test');
    expect(JSON.parse(init?.body as string)).toEqual({ host: 'dev@example.test', identity_file: '~/.ssh/id' });
    expect(init?.signal?.aborted).toBe(false);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
  });

  it('maps SSH config hosts', async () => {
    stubbedFetch.mockResolvedValue(envelope({
      config_path: '/home/me/.ssh/config',
      exists: true,
      hosts: [{ alias: 'devbox', host_name: 'dev.example.test', user: 'me', port: 2222 }],
    }));

    expect(await createApi().listHostSshConfig()).toEqual({
      configPath: '/home/me/.ssh/config',
      exists: true,
      hosts: [{ alias: 'devbox', hostName: 'dev.example.test', user: 'me', port: 2222 }],
    });
    expect(stubbedFetch.mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/hosts:ssh-hosts');
  });

  it('copies custom providers to a host by id', async () => {
    stubbedFetch.mockResolvedValue(envelope({
      providers: ['gateway', 'backup'],
    }));

    expect(await createApi().copyProvidersToHost('devbox')).toEqual({
      providers: ['gateway', 'backup'],
    });
    const [url, init] = stubbedFetch.mock.calls[0]!;
    expect(url).toBe('http://daemon.test/api/v1/hosts:copy-providers');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ id: 'devbox' });
  });

  it('forwards the abort signal of a folder browse', async () => {
    stubbedFetch.mockResolvedValue(envelope({ path: '/srv', parent: '/', entries: [] }));
    const controller = new AbortController();

    await createApi().browseFs('/srv', controller.signal);

    const init = stubbedFetch.mock.calls[0]![1];
    expect(init?.signal?.aborted).toBe(false);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
  });
});

describe('DaemonKimiWebApi.activateSkill', () => {
  beforeEach(() => {
    stubGlobal('location', { search: '' });
    stubbedFetch.mockReset();
    stubbedFetch.mockImplementation(async () => envelope({ activated: true, skill_name: 'example-skill' }));
    stubGlobal('fetch', stubbedFetch);
  });

  it('keeps ordered multimodal context and client metadata separate from skill arguments', async () => {
    const metadata = { display_text: 'Save button', kimi_code_composer: { version: 1 } };
    await createApi().activateSkill('session-1', 'example-skill', 'user args', [{ type: 'text', text: 'image_ref=shot-1' }, { type: 'image', source: { kind: 'file', fileId: 'image-1' } }, { type: 'text', text: 'after image' }], { metadata });
    const body = JSON.parse(stubbedFetch.mock.calls[0]![1]!.body as string);
    expect(body.metadata).toEqual(metadata);
    expect(body.args).toBe('user args');
    expect(body.attachments.map((part: { type: string }) => part.type)).toEqual(['text', 'image', 'text']);
    expect(body.attachments[0].text).toBe('image_ref=shot-1');
    expect(body.attachments[1].source.file_id).toBe('image-1');
    expect(body).not.toHaveProperty('content');
  });

  it('sends the selected variant path when provided', async () => {
    await createApi().activateSkill('session-1', 'example-skill', 'user args', undefined, {
      skillPath: '/work/B/example-skill/SKILL.md',
    });
    expect(JSON.parse(stubbedFetch.mock.calls[0]![1]!.body as string)).toEqual({
      path: '/work/B/example-skill/SKILL.md',
      args: 'user args',
    });
  });

  it('preserves the existing request shape for ordinary skill calls', async () => {
    await createApi().activateSkill('session-1', 'example-skill', 'user args');
    expect(JSON.parse(stubbedFetch.mock.calls[0]![1]!.body as string)).toEqual({ args: 'user args' });
  });
});

describe('DaemonKimiWebApi.exportSession', () => {
  beforeEach(() => {
    stubGlobal('location', { search: '?debug=1' });
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
    tracedRequests.length = 0;
  });

  afterEach(() => {
    tracedRequests.length = 0;
    stubGlobal.restore();
  });

  it('posts the Web log to the encoded session export endpoint and returns the ZIP', async () => {
    stubbedFetch.mockResolvedValue(
      new Response(new Uint8Array([80, 75, 3, 4]), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="session-export.zip"',
        },
      }),
    );

    const result = await createApi().exportSession('sess/1', '{"event":"safe"}');

    expect(stubbedFetch.mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess%2F1/export',
    );
    expect(stubbedFetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ web_log: '{"event":"safe"}' }),
    });
    expect(result.fileName).toBe('session-export.zip');
    expect(result.blob.size).toBe(4);
  });

  it('sends the desktop flag only when requested', async () => {
    const zipResponse = () =>
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      });
    stubbedFetch.mockImplementation(() => Promise.resolve(zipResponse()));

    await createApi().exportSession('sess_1', 'log', { desktop: true });
    expect(stubbedFetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ web_log: 'log', desktop: true }),
    });

    stubbedFetch.mockClear();
    await createApi().exportSession('sess_1', 'log');
    expect(stubbedFetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ web_log: 'log' }),
    });
  });

  it('retries without the desktop flag when the server predates it', async () => {
    stubbedFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 40001, msg: 'unrecognized key: desktop', request_id: 'req_old' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([80, 75, 3, 4]), {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="session-export.zip"',
          },
        }),
      );

    const result = await createApi().exportSession('sess_1', 'log', { desktop: true });

    expect(stubbedFetch).toHaveBeenCalledTimes(2);
    expect(stubbedFetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ web_log: 'log', desktop: true }),
    });
    expect(stubbedFetch.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ web_log: 'log' }),
    });
    expect(result.fileName).toBe('session-export.zip');
  });

  it('falls back to a session-id ZIP name for an unsafe response filename', async () => {
    stubbedFetch.mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="../credentials.zip"',
        },
      }),
    );

    const result = await createApi().exportSession('sess_1');

    expect(result.fileName).toBe('sess_1.zip');
  });

  it('parses a JSON error envelope returned by the export endpoint', async () => {
    stubbedFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ code: 41301, msg: 'export too large', request_id: 'req_server' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const caught = await createApi()
      .exportSession('sess_1', 'log')
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonApiError);
    expect(caught).toMatchObject({ code: 41301, requestId: 'req_server' });
  });

  it('rejects a successful response whose media type is not a ZIP', async () => {
    stubbedFetch.mockResolvedValue(
      new Response('not a zip', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const caught = await createApi().exportSession('sess_1').catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect(caught).toMatchObject({ phase: 'parse', contentType: 'text/plain' });
  });

  it('records only Web-log counts in the request trace', async () => {
    stubbedFetch.mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      }),
    );
    const secret = 'PROMPT_CONTENT_MUST_NOT_ENTER_TRACE';

    await createApi().exportSession('sess_1', `${secret}\nsecond line`);

    const trace = JSON.stringify(tracedRequests);
    expect(tracedRequests).not.toHaveLength(0);
    expect(trace).not.toContain(secret);
    expect(trace).toContain('web_log_bytes');
    expect(trace).toContain('web_log_entries');
  });
});

describe('DaemonKimiWebApi.generateSessionTitle', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
    tracedRequests.length = 0;
  });

  afterEach(() => {
    tracedRequests.length = 0;
    stubGlobal.restore();
  });

  it('posts to the title/generate endpoint and returns the generated title', async () => {
    stubbedFetch.mockResolvedValue(envelope({ title: 'Fix lint warnings' }));

    const result = await createApi().generateSessionTitle('sess/1');

    expect(stubbedFetch.mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess%2F1/title/generate',
    );
    expect(stubbedFetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(result).toBe('Fix lint warnings');
  });

  it('sends the force flag only when requested', async () => {
    stubbedFetch.mockResolvedValue(envelope({ title: 't' }));

    await createApi().generateSessionTitle('sess_1', { force: true });
    expect(stubbedFetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ force: true }),
    });

    stubbedFetch.mockClear();
    await createApi().generateSessionTitle('sess_1');
    expect(stubbedFetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({}),
    });
  });

  it('passes the excerpt source through when given', async () => {
    stubbedFetch.mockResolvedValue(envelope({ title: 't' }));

    await createApi().generateSessionTitle('sess_1', { source: 'first_turn' });
    expect(stubbedFetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ source: 'first_turn' }),
    });

    stubbedFetch.mockClear();
    await createApi().generateSessionTitle('sess_1', { force: true, source: 'digest' });
    expect(stubbedFetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ force: true, source: 'digest' }),
    });
  });

  it('returns null when generation is unavailable (40922)', async () => {
    stubbedFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 40922,
          msg: 'session title generation is unavailable',
          request_id: 'req_1',
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );

    expect(await createApi().generateSessionTitle('sess_1')).toBeNull();
  });

  it('returns null for a bare 404 from a server predating the route', async () => {
    stubbedFetch.mockResolvedValue(
      new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }),
    );

    expect(await createApi().generateSessionTitle('sess_1')).toBeNull();
  });

  it('returns null on a network error', async () => {
    stubbedFetch.mockRejectedValue(new TypeError('fetch failed'));

    expect(await createApi().generateSessionTitle('sess_1')).toBeNull();
  });

  it('returns null when the success envelope carries no usable title', async () => {
    stubbedFetch.mockResolvedValue(envelope({}));

    expect(await createApi().generateSessionTitle('sess_1')).toBeNull();
  });
});

describe('DaemonKimiWebApi.listSkills', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
    tracedRequests.length = 0;
  });

  afterEach(() => {
    tracedRequests.length = 0;
    stubGlobal.restore();
  });

  const WIRE_SKILLS = {
    skills: [
      { name: 'custom-theme', description: 'TUI theme', path: 'builtin://custom-theme', source: 'builtin', scopes: ['tui'] },
      { name: 'write-goal', description: 'Goal helper', path: 'builtin://write-goal', source: 'builtin' },
      { name: 'scope-matched', description: 'Scope matched', path: 'builtin://scope-matched', source: 'builtin', scopes: ['test'] },
    ],
  };

  const EXPECTED_SKILLS = [
    { name: 'write-goal', description: 'Goal helper', path: 'builtin://write-goal', source: 'builtin' },
    { name: 'scope-matched', description: 'Scope matched', path: 'builtin://scope-matched', source: 'builtin' },
  ];

  it('drops skills restricted to other scopes from the session listing', async () => {
    stubbedFetch.mockResolvedValue(envelope(WIRE_SKILLS));

    const skills = await createApi().listSkills('sess/1');

    expect(skills).toEqual(EXPECTED_SKILLS);
  });

  it('drops skills restricted to other scopes from the workspace listing', async () => {
    stubbedFetch.mockResolvedValue(envelope(WIRE_SKILLS));

    const skills = await createApi().listSkillsForWorkspace('ws/1');

    expect(skills).toEqual(EXPECTED_SKILLS);
  });
  it('maps workspace_dir for project skill variants', async () => {
    stubbedFetch.mockResolvedValue(envelope({
      skills: [{
        name: 'review',
        description: 'Secondary',
        path: '/work/B/review/SKILL.md',
        source: 'project',
        workspace_dir: '/work/B',
      }],
    }));

    const skills = await createApi().listSkillsForWorkspace('ws/1');
    expect(skills).toEqual([{
      name: 'review',
      description: 'Secondary',
      path: '/work/B/review/SKILL.md',
      source: 'project',
      workspaceDir: '/work/B',
    }]);
  });
});

describe('DaemonKimiWebApi request timeout budgets', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
  });


  const timeoutRejection = () =>
    Promise.reject(new DOMException('signal timed out', 'TimeoutError'));

  it('forkSession passes the turn and waits five minutes before aborting', async () => {
    stubbedFetch.mockImplementation(timeoutRejection);

    const caught = await createApi()
      .forkSession('sess_1', { turnIndex: 7 })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect(caught).toMatchObject({ timeoutMs: 300_000, phase: 'fetch' });
    expect(isDaemonTimeoutError(caught)).toBe(true);
    expect(stubbedFetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ turn_index: 7 }));
  });

  it('getAgentTurns waits two minutes before aborting', async () => {
    stubbedFetch.mockImplementation(timeoutRejection);

    const caught = await createApi()
      .getAgentTurns('sess_1', 'main', { pageSize: 10 })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect(caught).toMatchObject({ timeoutMs: 120_000, phase: 'fetch' });
    expect(isDaemonTimeoutError(caught)).toBe(true);
  });

  it('ordinary session actions keep the default 30s budget', async () => {
    stubbedFetch.mockImplementation(timeoutRejection);

    const caught = await createApi()
      .undoSession('sess_1', 't_1')
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({ timeoutMs: 30_000 });
    expect(isDaemonTimeoutError(caught)).toBe(true);
  });

  it('a connect failure is not reported as a timeout', async () => {
    stubbedFetch.mockRejectedValue(new TypeError('fetch failed'));

    const caught = await createApi()
      .forkSession('sess_1')
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect(isDaemonTimeoutError(caught)).toBe(false);
  });
});

describe('DaemonKimiWebApi.getAgentTurns', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
  });


  it('pages older turns by before_ordinal and page_size', async () => {
    stubbedFetch.mockResolvedValue(envelope({ turns: [], has_more: true }));

    expect(await createApi().getAgentTurns('sess_1', 'agent/2', { beforeOrdinal: 41, pageSize: 20 })).toEqual({ turns: [], has_more: true });

    expect(stubbedFetch.mock.calls[0]![0]).toBe(
      'http://daemon.test/api/v1/sessions/sess_1/agents/agent%2F2/turns?before_ordinal=41&page_size=20',
    );
  });
});

describe('DaemonKimiWebApi.connectEvents', () => {
  let connection: KimiEventConnection | undefined;

  afterEach(() => {
    connection?.close();
    connection = undefined;
    stubGlobal.restore();
  });

  it('projects list-level work facts from the global session event', () => {
    FakeWebSocket.instances = [];
    stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const received: AppEvent[] = [];
    connection = createApi().connectEvents({
      onEvent(event) {
        received.push(event);
      },
      onError() {},
      onConnectionChange() {},
    });
    const [socket] = FakeWebSocket.instances;
    if (socket === undefined) throw new Error('WebSocket was not created');

    socket.emit({ type: 'server_hello', payload: { protocol_version: 2 } });
    socket.emit({
      type: 'session',
      change: 'updated',
      event_created_at: '2026-01-01T00:00:00.000Z',
      session: {
        id: 'session-1',
        cwd: '/project',
        title: 'Session',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        activity: 'background',
        archived: false,
        pending_interaction: 'question',
      },
    });

    expect(received[0]).toMatchObject({
      type: 'sessionWorkChanged',
      sessionId: 'session-1',
      busy: true,
      mainTurnActive: false,
      pendingInteraction: 'question',
      lastTurnReason: undefined,
    });
  });

  it('projects a session title change from the global session event', () => {
    FakeWebSocket.instances = [];
    stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const received: AppEvent[] = [];
    connection = createApi().connectEvents({
      onEvent(event) {
        received.push(event);
      },
      onError() {},
      onConnectionChange() {},
    });
    const [socket] = FakeWebSocket.instances;
    if (socket === undefined) throw new Error('WebSocket was not created');

    socket.emit({ type: 'server_hello', payload: { protocol_version: 2 } });
    socket.emit({
      type: 'session',
      change: 'updated',
      event_created_at: '2026-01-01T00:00:00.000Z',
      session: {
        id: 'session-1',
        cwd: '/project',
        title: 'Renamed',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        activity: 'idle',
        archived: false,
        last_prompt: 'hello',
      },
    });

    expect(received[0]).toMatchObject({
      type: 'sessionWorkChanged',
      sessionId: 'session-1',
      session: { title: 'Renamed', lastPrompt: 'hello' },
    });
  });
});

describe('DaemonKimiWebApi.startOAuthLogin', () => {
  beforeEach(() => {
    stubGlobal('location', { search: '?debug=1' });
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
    tracedRequests.length = 0;
  });


  const PENDING_FLOW = {
    flow_id: 'oauth_1',
    provider: 'kimi-code',
    status: 'pending',
    verification_uri: 'https://example.com/device',
    verification_uri_complete: 'https://example.com/device?code=ABCD',
    user_code: 'ABCD-EFGH',
    expires_in: 900,
    interval: 5,
    expires_at: '2026-01-01T00:15:00.000Z',
  };

  it('posts the picked region and maps the pending flow', async () => {
    stubbedFetch.mockResolvedValueOnce(envelope(PENDING_FLOW));

    const result = await createApi().startOAuthLogin('global');

    expect(stubbedFetch).toHaveBeenCalledTimes(1);
    expect(stubbedFetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ region: 'global' }),
    });
    expect(result).toMatchObject({
      flowId: 'oauth_1',
      status: 'pending',
      verificationUriComplete: 'https://example.com/device?code=ABCD',
    });
  });

  it('sends an empty body when no region is picked', async () => {
    stubbedFetch.mockResolvedValueOnce(envelope(PENDING_FLOW));

    await createApi().startOAuthLogin();

    expect(stubbedFetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({}),
    });
  });

  it('retries once without the region when the server rejects it with 40001', async () => {
    stubbedFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 40001, msg: 'unrecognized key: region', request_id: 'req_old' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(envelope(PENDING_FLOW));

    const result = await createApi().startOAuthLogin('mainland-cn');

    expect(stubbedFetch).toHaveBeenCalledTimes(2);
    expect(stubbedFetch.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ region: 'mainland-cn' }),
    });
    expect(stubbedFetch.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({}),
    });
    expect(result).toMatchObject({ flowId: 'oauth_1', status: 'pending' });
  });

  it('does not retry on a non-validation error', async () => {
    stubbedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 50001, msg: 'boom', request_id: 'req_x' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await rejects(createApi().startOAuthLogin('mainland-cn'), DaemonApiError);
    expect(stubbedFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 40001 when no region was sent (nothing to drop)', async () => {
    stubbedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 40001, msg: 'bad body', request_id: 'req_y' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await rejects(createApi().startOAuthLogin(), DaemonApiError);
    expect(stubbedFetch).toHaveBeenCalledTimes(1);
  });
});

describe('DaemonKimiWebApi host files', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
  });


  it('rejects an HTTP 200 error envelope instead of reading it as file content', async () => {
    let responseRequestId = '';
    stubbedFetch.mockImplementation((_url, init) => {
      responseRequestId = (init?.headers as Record<string, string>)['X-Request-Id'];
      const body = JSON.stringify({ code: 40409, msg: 'path not found', data: null, request_id: responseRequestId });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json;charset=utf-8', 'content-length': String(body.length) },
      }));
    });

    expect(await rejectionOf(createApi().readHostFileContent('/repo/missing.png'))).toMatchObject({
      name: 'DaemonApiError',
      code: 40409,
      message: 'path not found',
      requestId: responseRequestId,
    });
    expect(responseRequestId).not.toBe('');
  });

  it('downloads host file bytes with an optional range', async () => {
    stubbedFetch.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: { 'content-type': 'image/png' },
      }),
    );

    const blob = await createApi().downloadHostFile('/repo/img/a.png', { prefixBytes: 4096 });

    expect(stubbedFetch.mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/fs:content?path=%2Frepo%2Fimg%2Fa.png',
    );
    expect(stubbedFetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Range: 'bytes=0-4095' });
    expect(blob.size).toBe(3);
  });
});

describe('DaemonKimiWebApi session media', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
  });


  it('builds the session-scoped media URL', () => {
    expect(createApi().getSessionMediaUrl('sess/1', 'f_abc')).toBe(
      'http://daemon.test/api/v1/sessions/sess%2F1/media/f_abc',
    );
  });

  it('fetches session media bytes from the session-scoped route with auth', async () => {
    stubbedFetch.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );

    const blob = await createApi().getSessionMediaBlob('sess/1', 'f_abc');

    expect(stubbedFetch.mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess%2F1/media/f_abc',
    );
    expect(blob.size).toBe(3);
  });

  it('preserves the session_media source kind in prompt submissions', async () => {
    stubbedFetch.mockResolvedValue(
      envelope({
        prompt_id: 'prompt-1',
        user_message_id: 'message-1',
        status: 'running',
        content: [],
        created_at: '2026-01-01T00:00:00.000Z',
      }),
    );

    await createApi().submitPrompt('sess/1', {
      content: [{ type: 'image', source: { kind: 'sessionMedia', fileId: 'f_abc' } }],
    });

    const [url, init] = stubbedFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://daemon.test/api/v1/sessions/sess%2F1/prompts');
    if (typeof init.body !== 'string') throw new Error('expected JSON request body');
    expect(JSON.parse(init.body)).toMatchObject({
      content: [{ type: 'image', source: { kind: 'session_media', file_id: 'f_abc' } }],
    });
  });

  it('submits a direct steer to the single-request steer endpoint', async () => {
    stubbedFetch.mockResolvedValue(envelope({
      prompt_id: 'prompt-1',
      user_message_id: 'message-1',
      status: 'running',
      content: [],
      created_at: '2026-01-01T00:00:00.000Z',
    }));

    await createApi().steerPrompt('sess/1', {
      content: [{ type: 'text', text: 'steer now' }],
    });

    const [url, init] = stubbedFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://daemon.test/api/v1/sessions/sess%2F1/steer');
    expect(init.method).toBe('POST');
    if (typeof init.body !== 'string') throw new Error('expected JSON request body');
    expect(JSON.parse(init.body)).toMatchObject({
      content: [{ type: 'text', text: 'steer now' }],
    });
  });
});

describe('DaemonKimiWebApi.suggestFiles abort signal', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
    tracedRequests.length = 0;
  });

  afterEach(() => {
    tracedRequests.length = 0;
    stubGlobal.restore();
  });

  it('forwards the caller signal into the fetch request (combined with the timeout)', async () => {
    stubbedFetch.mockResolvedValue(envelope({ items: [], truncated: false }));
    const controller = new AbortController();

    await createApi().suggestFiles('ws_1', { query: 'a', limit: 20 }, { signal: controller.signal });

    const init = stubbedFetch.mock.calls[0]?.[1];
    expect(stubbedFetch.mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/workspace/fs:suggest');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
  });

  it('forwards showHidden in the request body', async () => {
    stubbedFetch.mockResolvedValue(envelope({ items: [], truncated: false }));

    await createApi().suggestFiles('ws_1', { query: '', showHidden: true });

    const init = stubbedFetch.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
    expect(JSON.parse(init.body)).toMatchObject({ workspace: 'ws_1', query: '', show_hidden: true });
  });

  it('uses the root-scoped suggest route with absolute roots', async () => {
    stubbedFetch.mockResolvedValue(envelope({ items: [], truncated: false }));

    await createApi().suggestFilesAtRoots(['/repo/B'], { query: 'a', showHidden: true });

    expect(stubbedFetch.mock.calls[0]?.[0]).toBe('http://daemon.test/api/v1/fs:suggest');
    const init = stubbedFetch.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('expected JSON request body');
    expect(JSON.parse(init.body)).toMatchObject({
      roots: ['/repo/B'],
      query: 'a',
      show_hidden: true,
    });
  });

  it('rethrows the caller-initiated AbortError raw — no network-error wrap, no failure trace', async () => {
    const failures: unknown[] = [];
    const api = new DaemonKimiWebApi({
      origin: 'http://daemon.test',
      identity: { clientId: 'web_test', clientName: 'test', clientVersion: '0.0.0', clientUiMode: 'test' },
      tracer: { restFailure: (info) => failures.push(info) },
    });
    stubbedFetch.mockImplementation((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true },
        );
      }));
    const controller = new AbortController();

    const pending = api.suggestFiles('ws_1', { query: 'a' }, { signal: controller.signal });
    const assertion = rejectionOf(pending).then((error) => {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
    });
    controller.abort();
    await assertion;
    expect(failures).toEqual([]);
  });

  it('rethrows the caller-initiated AbortError raw when it fires while reading the body', async () => {
    const failures: unknown[] = [];
    const api = new DaemonKimiWebApi({
      origin: 'http://daemon.test',
      identity: { clientId: 'web_test', clientName: 'test', clientVersion: '0.0.0', clientUiMode: 'test' },
      tracer: { restFailure: (info) => failures.push(info) },
    });
    const controller = new AbortController();
    stubbedFetch.mockImplementation(async () => {
      const response = new Response('', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      let rejectRead: (err: unknown) => void = () => {};
      const read = new Promise<string>((_resolve, reject) => { rejectRead = reject; });
      const abortRead = (): void => rejectRead(new DOMException('The operation was aborted.', 'AbortError'));
      if (controller.signal.aborted) abortRead();
      else controller.signal.addEventListener('abort', abortRead, { once: true });
      response.text = () => read;
      return response;
    });

    const pending = api.suggestFiles('ws_1', { query: 'a' }, { signal: controller.signal });
    const assertion = rejectionOf(pending).then((error) => {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
    });
    controller.abort();
    await assertion;
    expect(failures).toEqual([]);
  });

  it('keeps the plain timeout signal when no caller signal is given', async () => {
    stubbedFetch.mockResolvedValue(envelope({ items: [], truncated: false }));

    await createApi().suggestFiles('ws_1', { query: 'a' });

    expect(stubbedFetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

function deferredResponse(): { promise: Promise<Response>; resolve: (response: Response) => void } {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

async function flushRequests(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

const EMPTY_SESSIONS_PAGE = { items: [], groups: [], has_more: false, total: 0 };
const WIRE_SESSION = {
  id: 'sess/1',
  title: 'Test',
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
  cwd: '/project',
  activity: 'idle',
  archived: false,
};

const BACKGROUND_READS: Array<{
  name: string;
  call: (api: DaemonKimiWebApi, options?: ReadRequestOptions) => Promise<unknown>;
  data: unknown;
  path: string;
  method?: string;
  body?: unknown;
}> = [
  { name: 'warnings', call: (api, options) => api.getSessionWarnings('sess/1', options), data: { warnings: [] }, path: '/sessions/sess%2F1/warnings' },
  { name: 'client config', call: (api, options) => api.getClientConfig('model_switch_confirm', options), data: { name: 'model_switch_confirm', config: null }, path: '/client-configs/model_switch_confirm' },
  { name: 'skills', call: (api, options) => api.listSkills('sess/1', options), data: { skills: [] }, path: '/sessions/sess%2F1/skills' },
  { name: 'workspace skills', call: (api, options) => api.listSkillsForWorkspace('ws/1', options), data: { skills: [] }, path: '/workspaces/ws%2F1/skills' },
  { name: 'workspace trust', call: (api, options) => api.getWorkspaceTrust('ws/1', options), data: { trusted: true }, path: '/workspaces/ws%2F1/trust' },
  { name: 'file changes', call: (api, options) => api.getTurnFileChanges('sess/1', 2, options), data: { changes: [] }, path: '/sessions/sess%2F1/file-history/changes?turn_number=2' },
  { name: 'git POST', call: (api, options) => api.getGitStatus('sess/1', { root: '/repo', paths: ['a.ts'] }, options), data: { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0 }, path: '/sessions/sess%2F1/fs:git_status', method: 'POST', body: { root: '/repo', paths: ['a.ts'] } },
  { name: 'diff POST', call: (api, options) => api.getFileDiff('sess/1', 'a.ts', { root: '/repo' }, options), data: { path: 'a.ts', diff: '', truncated: false }, path: '/sessions/sess%2F1/fs:diff', method: 'POST', body: { path: 'a.ts', root: '/repo' } },
  { name: 'PR POST', call: (api, options) => api.getPullRequest('sess/1', { root: '/repo' }, options), data: null, path: '/sessions/sess%2F1/fs:pull_request', method: 'POST', body: { root: '/repo' } },
  { name: 'git batch POST', call: (api, options) => api.getGitStatusBatch('sess/1', { roots: ['/repo'], includePullRequest: false }, options), data: { results: {}, errors: {} }, path: '/sessions/sess%2F1/fs:git_status:batch', method: 'POST', body: { roots: ['/repo'], include_pull_request: false } },
  { name: 'PR batch POST', call: (api, options) => api.getPullRequestBatch('sess/1', { roots: ['/repo'] }, options), data: { results: {}, errors: {} }, path: '/sessions/sess%2F1/fs:pull_request:batch', method: 'POST', body: { roots: ['/repo'] } },
];

const MIXED_READS: Array<{
  name: string;
  call: (api: DaemonKimiWebApi, options?: ReadRequestOptions) => Promise<unknown>;
  data: unknown;
  url: string;
}> = [
  { name: 'session', call: (api, options) => api.getSession('sess/1', options), data: WIRE_SESSION, url: 'http://daemon.test/api/v1/sessions/sess%2F1' },
  { name: 'sessions', call: (api, options) => api.listSessions({ include: 'git', pageSize: 2 }, options), data: EMPTY_SESSIONS_PAGE, url: 'http://daemon.test/api/v1/sessions?page_size=2&include=git' },
  { name: 'session groups', call: (api, options) => api.listSessionGroups({ groupPageSize: 2 }, options), data: EMPTY_SESSIONS_PAGE, url: 'http://daemon.test/api/v1/sessions?view=by_workspace&group_page_size=2' },
];

describe('DaemonKimiWebApi background admission', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
    tracedRequests.length = 0;
  });

  afterEach(() => {
    tracedRequests.length = 0;
    stubGlobal.restore();
  });

  it('does not block conversation pages or user controls behind two background requests', async () => {
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    stubbedFetch
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    const api = createApi();
    const first = api.getSessionWarnings('sess/1');
    const second = api.getSessionWarnings('sess/1');
    await flushRequests();
    expect(fetch).toHaveBeenCalledTimes(2);
    stubbedFetch.mockImplementation(async (url) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (path.endsWith('/turns')) return envelope({ agent_id: 'main', turns: [], has_more: false });
      if (path.endsWith('/prompts')) return envelope({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' });
      if (path.includes('/interactions/')) return envelope({ outcome: 'approved', ended_at: 'now' });
      return envelope({ cancelled: true });
    });

    const turns = api.getAgentTurns('sess/1', 'main', { pageSize: 10 });
    const prompt = api.submitPrompt('sess/1', { content: [{ type: 'text', text: 'test' }] });
    const cancel = api.cancelSession('sess/1');
    const approval = api.respondApproval('sess/1', 'a1', { decision: 'approved' });
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(await turns).toEqual({ turns: [], has_more: false });
    expect(await prompt).toMatchObject({ promptId: 'p1' });
    expect(await cancel).toEqual({ cancelled: true });
    expect(await approval).toEqual({ outcome: 'approved', endedAt: 'now' });
    expect(tracedRequests.slice(2).every((request) => request.queueMs === undefined)).toBe(true);
    firstResponse.resolve(envelope({ warnings: [] }));
    secondResponse.resolve(envelope({ warnings: [] }));
    await Promise.all([first, second]);
  });

  it.each(BACKGROUND_READS)('defaults $name to background and forwards cancellation without serializing options', async ({ call, data, path, method, body }) => {
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    stubbedFetch
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
      .mockImplementation(async () => envelope(data));
    const api = createApi();
    const first = api.getSessionWarnings('blocking-1');
    const second = api.getSessionWarnings('blocking-2');
    const controller = new AbortController();
    const defaultRequest = call(api);
    const cancelled = call(api, { signal: controller.signal });
    const assertion = rejectionOf(cancelled).then((error) => expect(error).toMatchObject({ name: 'AbortError' }));
    await flushRequests();
    expect(fetch).toHaveBeenCalledTimes(2);

    const explicitSignal = new AbortController();
    await call(api, { background: false, signal: explicitSignal.signal });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(stubbedFetch.mock.calls[2]?.[0]).toBe(`http://daemon.test/api/v1${path}`);
    expect(stubbedFetch.mock.calls[2]?.[1]).toMatchObject({
      method: method ?? 'GET', body: body === undefined ? undefined : JSON.stringify(body),
    });
    explicitSignal.abort();
    expect(stubbedFetch.mock.calls[2]?.[1]?.signal?.aborted).toBe(true);
    controller.abort();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(3);

    firstResponse.resolve(envelope({ warnings: [] }));
    secondResponse.resolve(envelope({ warnings: [] }));
    await Promise.all([first, second, defaultRequest]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(stubbedFetch.mock.calls[3]?.[0]).toBe(`http://daemon.test/api/v1${path}`);
  });

  it.each(MIXED_READS)('keeps $name foreground unless explicitly marked background', async ({ call, data, url }) => {
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    stubbedFetch
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
      .mockImplementation(async () => envelope(data));
    const api = createApi();
    const first = api.getSessionWarnings('blocking-1');
    const second = api.getSessionWarnings('blocking-2');
    const controller = new AbortController();
    const background = call(api, { background: true, signal: controller.signal });
    const assertion = rejectionOf(background).then((error) => expect(error).toMatchObject({ name: 'AbortError' }));
    await flushRequests();
    expect(fetch).toHaveBeenCalledTimes(2);
    await call(api);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(stubbedFetch.mock.calls[2]?.[0]).toBe(url);
    controller.abort();
    await assertion;
    firstResponse.resolve(envelope({ warnings: [] }));
    secondResponse.resolve(envelope({ warnings: [] }));
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('shares the same two-slot FIFO across background reads', async () => {
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    const thirdResponse = deferredResponse();
    stubbedFetch
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
      .mockImplementationOnce(() => thirdResponse.promise)
      .mockImplementation(async () => envelope(WIRE_SESSION));
    const api = createApi();
    const first = api.getSessionWarnings('sess/1');
    const second = api.listSessions(undefined, { background: true });
    const third = api.listSessionGroups(undefined, { background: true });
    const fourth = api.getSession('sess/1', { background: true });
    await flushRequests();
    expect(stubbedFetch.mock.calls.map(([url]) => url)).toEqual([
      'http://daemon.test/api/v1/sessions/sess%2F1/warnings',
      'http://daemon.test/api/v1/sessions',
    ]);
    firstResponse.resolve(envelope({ warnings: [] }));
    await first;
    await flushRequests();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(stubbedFetch.mock.calls[2]?.[0]).toBe('http://daemon.test/api/v1/sessions?view=by_workspace');
    secondResponse.resolve(envelope(EMPTY_SESSIONS_PAGE));
    await second;
    await flushRequests();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(stubbedFetch.mock.calls[3]?.[0]).toBe('http://daemon.test/api/v1/sessions/sess%2F1');
    thirdResponse.resolve(envelope(EMPTY_SESSIONS_PAGE));
    await Promise.all([third, fourth]);
  });

  it.each(['http://daemon.test', 'http://other.test'])('isolates another API instance at %s', async (origin) => {
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    stubbedFetch
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
      .mockImplementation(async () => envelope({ warnings: [] }));
    const api = createApi();
    const otherApi = createApi(origin);
    const first = api.getSessionWarnings('blocking-1');
    const second = api.getSessionWarnings('blocking-2');
    const queued = api.getSessionWarnings('queued');
    const assertion = rejectionOf(queued).then((error) => expect(error).toMatchObject({ name: 'AbortError' }));
    await flushRequests();
    await otherApi.getSessionWarnings('other');
    expect(stubbedFetch.mock.calls[2]?.[0]).toBe(`${origin}/api/v1/sessions/other/warnings`);
    api.dispose();
    await assertion;
    expect(await rejectionOf(api.listSessions())).toMatchObject({ name: 'AbortError' });
    expect(await otherApi.getSessionWarnings('still-open')).toEqual([]);
    firstResponse.resolve(envelope({ warnings: [] }));
    secondResponse.resolve(envelope({ warnings: [] }));
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe('DaemonKimiWebApi.mkdirFs', () => {
  beforeEach(() => {
    stubbedFetch.mockReset();
    stubGlobal('fetch', stubbedFetch);
  });


  it('posts the target path to /fs:mkdir and returns the created path', async () => {
    stubbedFetch.mockResolvedValue(envelope({ path: '/home/user/new-project' }));

    expect(await createApi().mkdirFs('/home/user/new-project')).toEqual({
      path: '/home/user/new-project',
    });
    expect(stubbedFetch.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['http://daemon.test/api/v1/fs:mkdir', 'POST', JSON.stringify({ path: '/home/user/new-project' })],
    ]);
  });

  it('propagates DaemonApiError codes when directory creation fails', async () => {
    stubbedFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 40919,
          msg: 'path already exists: /home/user/dup',
          data: null,
          request_id: 'req-mkdir-1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    expect(await rejectionOf(createApi().mkdirFs('/home/user/dup'))).toMatchObject({
      name: 'DaemonApiError',
      code: 40919,
    });
  });
});
