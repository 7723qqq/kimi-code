import { afterAll, afterEach, beforeAll, describe, expect, it, jest, spyOn } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { ISessionMediaStore } from '@moonshot-ai/agent-core-v2';
import { IReadTool, ReadInputSchema, type ReadInput } from '@moonshot-ai/agent-core-v2';
import {
  Error2,
  ErrorCodes,
  IBootstrapService,
  IOAuthService,
  type Event2,
  type IOAuthService as IOAuthServiceType,
  IAgentChangeNotifierService,
  IAgentContextMemoryService,
  IAgentFullCompactionService,
  IAgentGoalService,
  IAgentConversationUndoService,
  IAgentCronService,
  IAgentEnvironmentBindingService,
  IAgentLifecycleService,
  IAgentProfileService,
  IEnvironmentService,
  IHostFileSystem,
  IAtomicDocumentStore,
  IAgentLoopService,
  IEventBus,
  IEventDispatcher,
  IEventService,
  IModelCatalog,
  IModelService,
  ISessionActivityView,
  ISessionIndexMirror,
  ISessionManager,
  ISessionMetadata,
  ISessionTitleService,
  IWireService,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  MAIN_AGENT_ID,
  closeSessionById,
  ContextAppendMessage,
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  getLiveSessionById,
  resumeSessionById,
  sessionDirOf,
  TurnEnded,
  TurnPrompt,
  TaskStarted,
  type ContextMessage,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import { ISessionLockService } from '@moonshot-ai/agent-core-v2';
import { SessionMetaUpdated } from '@moonshot-ai/agent-core-v2';
import { encodeWorkDirKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';
import { renderToolResultForModel } from '@moonshot-ai/agent-core-v2/agent/contextMemory/toolResultRender';
import { EnvironmentSetBinding } from '@moonshot-ai/agent-core-v2/agent/environmentBinding/environmentBindingOps';
import { TurnStarted } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { TurnSteer } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import { mcpResultToExecutableOutput } from '@moonshot-ai/agent-core-v2/agent/mcp/output';
import { sessionWarningsResponseSchema } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';
import { FakeEnvironment } from '@moonshot-ai/agent-core-v2/environment/fakeEnvironment';
import type { AgentTranscriptSnapshot } from '@moonshot-ai/transcript';

import type { ConversationTurnsPage } from '../src/protocol/conversation';
import { ConversationFeed } from '../src/services/conversation/conversationFeed';
import { type RunningServer, startServer } from '../src/start';
import { ensureMainAgent } from '../src/transport/mainAgent';
import { readAgentState, readUsageState } from '../src/transport/ws/v1/agentState';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { restoreEnvs } from './helpers/stubs';
import { waitForAssertion, waitUntil } from './helpers/waitFor';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
  stack?: string;
}

interface GoalWire {
  goalId: string;
  objective: string;
  status: string;
  turnsUsed: number;
  tokensUsed: number;
}

interface SessionWire {
  id: string;
  workspace_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  busy: boolean;
  main_turn_active: boolean;
  pending_interaction: 'none' | 'approval' | 'question';
  last_turn_reason?: 'completed' | 'cancelled' | 'failed';
  archived?: boolean;
  metadata: { cwd: string } & Record<string, unknown>;
  agent_config: { model: string };
  usage: { input_tokens: number };
  permission_rules: unknown[];
  message_count: number;
}

interface PageWire {
  items: SessionWire[];
  has_more: boolean;
}

function goalContinuationStarts(events: readonly Event2<any>[]): readonly Event2<any>[] {
  return events.filter((event) => {
    if (event.type !== 'turn.started') return false;
    const { origin } = event as TurnStarted;
    return origin.kind === 'system_trigger' && origin.name === 'goal_continuation';
  });
}

describe('server-v2 /api/v1/sessions', () => {
  let server: RunningServer | undefined;
  let baselineServer: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    baselineServer = server;
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    restoreEnvs();
    if (server !== baselineServer) {
      await restartWithFreshHome();
      baselineServer = server;
    }
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, {
        recursive: true,
        force: true,
        maxRetries: 25,
        retryDelay: 100,
      } as never).catch(() => undefined);
      home = undefined;
    }
  });

  async function restartWithFreshHome(): Promise<void> {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, {
        recursive: true,
        force: true,
        maxRetries: 25,
        retryDelay: 100,
      } as never).catch(() => undefined);
    }
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function restartWithModels(): Promise<void> {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    const dir = home as string;
    await writeFile(
      join(dir, 'config.toml'),
      [
        'default_model = "stub"',
        '',
        '[providers.stub]',
        'type = "openai"',
        'base_url = "http://127.0.0.1:9999"',
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 1000',
        'support_efforts = ["low", "high"]',
        'default_effort = "low"',
        '',
        '[models.other]',
        'provider = "stub"',
        'model = "other"',
        'max_context_size = 1000',
        'support_efforts = ["low", "high"]',
        'default_effort = "low"',
        '',
      ].join('\n'),
      'utf-8',
    );
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(
      join(dir, 'agents', 'route-reviewer.md'),
      [
        '---',
        'name: route-reviewer',
        'description: reviewer defined by a user-level agent file',
        '---',
        '',
        'You are a route-test reviewer.',
        '',
      ].join('\n'),
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function patchJson<T>(
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'PATCH',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function deleteJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'DELETE',
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('downloads a ZIP with the supplied Web log and cleans up its temporary directory', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const webLog = [
      JSON.stringify({ event: 'websocket.connected', time: 1 }),
      JSON.stringify({ event: 'prompt.submitted', time: 2 }),
    ].join('\n');

    const res = await fetch(`${base}/api/v1/sessions/${id}/export`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, {
        'content-type': 'application/json',
        connection: 'close',
      }),
      body: JSON.stringify({ web_log: webLog }),
    } as never);
    const archive = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="kimi-session-${id}.zip"`,
    );
    expect(res.headers.get('content-length')).toBe(String(archive.length));
    expect(res.headers.get('cache-control')).toBe('no-store');

    const entries = readZipEntries(archive);
    const manifest = JSON.parse(entries.get('manifest.json')?.toString('utf8') ?? 'null') as {
      sessionId: string;
      kimiCodeVersion: string;
      desktopVersion?: string;
      webLogPath?: string;
    };
    expect(entries.get('logs/kimi-web.jsonl')?.toString('utf8')).toBe(webLog);
    expect(manifest).toMatchObject({
      sessionId: id,
      kimiCodeVersion: TEST_HOST_IDENTITY.version,
      webLogPath: 'logs/kimi-web.jsonl',
    });
    expect(manifest.desktopVersion).toBeUndefined();
    await waitForAssertion(async () => {
      expect(await listExportTempDirs(id)).toEqual([]);
    });
  });

  it('returns the JSON session-not-found envelope instead of a ZIP', async () => {
    const id = 'sess_missing_export';
    const { status, body } = await postJson<null>(`/api/v1/sessions/${id}/export`, {});

    expect(status).toBe(200);
    expect(body.code).toBe(40401);
    await waitForAssertion(async () => {
      expect(await listExportTempDirs(id)).toEqual([]);
    });
  });

  it('cleans up the temporary archive when the client cancels the download', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const sessionDir = sessionDirOf(
      (server as RunningServer).core.accessor.get(IBootstrapService).homeDir,
      `sessions/${created.body.data.workspace_id}`,
      id,
    );
    await writeFile(join(sessionDir, 'cancel-test.bin'), randomBytes(8 * 1024 * 1024));

    const res = await fetch(`${base}/api/v1/sessions/${id}/export`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, {
        'content-type': 'application/json',
        connection: 'close',
      }),
      body: '{}',
    } as never);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(first?.done).toBe(false);
    await reader?.cancel();

    await waitForAssertion(async () => {
      expect(await listExportTempDirs(id)).toEqual([]);
    });
  });

  it('rejects a Web log larger than 256 KiB in UTF-8', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const { status, body } = await postJson<null>(
      `/api/v1/sessions/${created.body.data.id}/export`,
      { web_log: '你'.repeat(87_382) },
    );

    expect(status).toBe(200);
    expect(body.code).toBe(40001);
    expect(body.details?.[0]?.path).toBe('web_log');
  });

  it('bundles the on-disk desktop app log when the desktop flag is set', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    await mkdir(join(home as string, 'logs'), { recursive: true });
    await writeFile(
      join(home as string, 'logs', 'kimi-code-desktop.log'),
      '2026-07-27T00:00:00.000Z INFO  [renderer] hello\n',
      'utf-8',
    );

    const res = await fetch(`${base}/api/v1/sessions/${id}/export`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, {
        'content-type': 'application/json',
        connection: 'close',
      }),
      body: JSON.stringify({ desktop: true }),
    } as never);
    const archive = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    const entries = readZipEntries(archive);
    const manifest = JSON.parse(entries.get('manifest.json')?.toString('utf8') ?? 'null') as {
      kimiCodeVersion: string;
      desktopLogPath?: string;
      desktopVersion?: string;
    };
    expect(entries.get('logs/kimi-desktop.log')?.toString('utf8')).toBe(
      '2026-07-27T00:00:00.000Z INFO  [renderer] hello\n',
    );
    expect(manifest.desktopLogPath).toBe('logs/kimi-desktop.log');
    expect(manifest.kimiCodeVersion).toBe(TEST_HOST_IDENTITY.version);
    expect(manifest.desktopVersion).toBe(TEST_HOST_IDENTITY.version);
  });

  async function createStoppedGoalRig(status: 'paused' | 'blocked') {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'finish the migration' },
    });
    const session = getLiveSessionById((server as RunningServer).core.accessor, id);
    if (session === undefined) throw new Error('expected a live session');
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
    if (agent === undefined) throw new Error('expected a live main agent');

    const eventBus = agent.accessor.get(IEventBus);
    const events: Event2<any>[] = [];
    const subscription = eventBus.subscribe((event) => events.push(event));

    const goal = agent.accessor.get(IAgentGoalService);
    const snapshot =
      status === 'blocked'
        ? await goal.markBlocked({ reason: 'need credentials' })
        : await goal.pauseGoal({});
    if (snapshot === null || snapshot.status !== status) {
      throw new Error(`expected a ${status} goal`);
    }

    return {
      id,
      eventBus,
      events,
      cancel: async () => {
        subscription.dispose();
        await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
          agent_config: { goal_control: 'cancel' },
        });
      },
    };
  }

  async function createBlockedGoalRig() {
    return createStoppedGoalRig('blocked');
  }

  it('creates a session from metadata.cwd', async () => {
    const cwd = home as string;
    const { status, body } = await postJson<SessionWire>('/api/v1/sessions', {
      title: 'hello',
      metadata: { cwd },
    });
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(typeof body.data.id).toBe('string');
    expect(typeof body.data.workspace_id).toBe('string');
    expect(body.data.title).toBe('hello');
    expect(body.data.metadata.cwd).toBe(cwd);
    expect(body.data.busy).toBe(false);
    expect(body.data.main_turn_active).toBe(false);
    expect(body.data.pending_interaction).toBe('none');
    expect(body.data.agent_config).toEqual({ model: '' });
    expect(body.data.permission_rules).toEqual([]);
    expect(body.data.message_count).toBe(0);
    expect(Number.isNaN(Date.parse(body.data.created_at))).toBe(false);
  });

  it('rejects create without cwd or workspace_id (40001)', async () => {
    const { body } = await postJson<null>('/api/v1/sessions', { title: 'no cwd' });
    expect(body.code).toBe(40001);
    expect(body.details?.[0]?.path).toBe('metadata.cwd');
  });

  it('rejects create with unknown workspace_id (40410)', async () => {
    const { body } = await postJson<null>('/api/v1/sessions', {
      workspace_id: 'wd_missing_000000000000',
      metadata: { cwd: '/x' },
    });
    expect(body.code).toBe(40410);
  });

  it('rejects a session for a missing metadata.cwd for a local binding', async () => {
    const missing = join(home as string, 'never-created');
    const created = await postJson<null>('/api/v1/sessions', { metadata: { cwd: missing } });
    expect(created.body.code).toBe(40409);

    const sessions = await getJson<PageWire>('/api/v1/sessions');
    expect(sessions.body.data.items.some((s) => s.metadata.cwd === missing)).toBe(false);
  });

  it('rejects create when metadata.cwd is not a directory (40409)', async () => {
    const file = join(home as string, 'a-file.txt');
    await writeFile(file, 'hi', 'utf8');
    const { body } = await postJson<null>('/api/v1/sessions', { metadata: { cwd: file } });
    expect(body.code).toBe(40409);
  });

  it('preserves a selected managed workspace identity when creating a session', async () => {
    const workspace = await server!.core.accessor
      .get(IWorkspaceService)
      .create({ root: home as string, name: 'Managed project' });
    const created = await postJson<SessionWire>('/api/v1/sessions', { workspace_id: workspace.id });
    expect(created.body.code).toBe(0);
    expect(created.body.data.workspace_id).toBe(workspace.id);
    await closeSessionById(server!.core.accessor, created.body.data.id);
    expect(
      (await getJson<SessionWire>(`/api/v1/sessions/${created.body.data.id}`)).body.data
        .workspace_id,
    ).toBe(workspace.id);
  });

  it('creates a second session via workspace_id resolved from a prior cwd create', async () => {
    const cwd = home as string;
    const first = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    expect(first.body.code).toBe(0);

    const second = await postJson<SessionWire>('/api/v1/sessions', {
      workspace_id: first.body.data.workspace_id,
      metadata: { cwd },
    });
    expect(second.body.code).toBe(0);
    expect(second.body.data.workspace_id).toBe(first.body.data.workspace_id);
    expect(second.body.data.id).not.toBe(first.body.data.id);
  });

  it('rejects create when cwd mismatches workspace root (40001)', async () => {
    const cwd = home as string;
    const first = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await postJson<null>('/api/v1/sessions', {
      workspace_id: first.body.data.workspace_id,
      metadata: { cwd: '/definitely/elsewhere' },
    });
    expect(body.code).toBe(40001);
    expect(body.details?.[0]?.path).toBe('metadata.cwd');
  });

  it('lists created sessions', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await getJson<PageWire>('/api/v1/sessions');
    expect(body.code).toBe(0);
    expect(body.data.items.some((s) => s.id === created.body.data.id)).toBe(true);
    expect(typeof body.data.has_more).toBe('boolean');
  });

  it('fills agent_config.model from the live session profile', async () => {
    await server?.close();
    server = undefined;
    const cwd = home as string;
    await writeFile(
      join(cwd, 'config.toml'),
      [
        'default_model = "stub"',
        '',
        '[providers.stub]',
        'type = "openai"',
        'base_url = "http://127.0.0.1:9999"',
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 1000',
        '',
        '[models.other]',
        'provider = "stub"',
        'model = "other"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;

    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    expect(created.body.data.agent_config).toEqual({ model: 'stub' });

    const updated = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { model: 'other' },
    });
    expect(updated.body.code).toBe(0);
    expect(updated.body.data.agent_config).toEqual({ model: 'other' });

    const listed = await getJson<PageWire>('/api/v1/sessions');
    const item = listed.body.data.items.find((s) => s.id === id);
    expect(item?.agent_config).toEqual({ model: 'other' });

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.data.agent_config).toEqual({ model: 'other' });
  });

  function liveMainAgent(id: string) {
    const session = getLiveSessionById((server as RunningServer).core.accessor, id)!;
    return session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
  }

  it('binds the main agent to the default model when the session is created', async () => {
    await restartWithModels();

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });

    expect(created.body.data.agent_config).toEqual({ model: 'stub' });
    const main = liveMainAgent(created.body.data.id);
    expect(main).toBeDefined();
    expect(main!.accessor.get(IAgentProfileService).data().profileName).toBe('agent');
    expect(readAgentState(main!, false).model).toBe('stub');
  });

  it('waits for the model configuration before choosing the creation model', async () => {
    await restartWithModels();
    const models = (server as RunningServer).core.accessor.get(IModelService);
    let loaded = false;
    let release!: () => void;
    (models as { ready: Promise<void> }).ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    spyOn(models, 'getDefaultModel').mockImplementation(() => (loaded ? 'stub' : undefined));

    const pending = postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    loaded = true;
    release();
    const created = await pending;

    expect(created.body.data.agent_config).toEqual({ model: 'stub' });
  });

  it('keeps a thinking level given at creation without a model', async () => {
    await restartWithModels();

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
      agent_config: { thinking: 'high' },
    });

    expect(created.body.code).toBe(0);
    expect(readAgentState(liveMainAgent(created.body.data.id)!, false)).toMatchObject({
      model: 'stub',
      thinking: 'high',
    });
  });

  it('binds the profile, model and thinking given at creation together', async () => {
    await restartWithModels();

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
      agent_config: { profile: 'route-reviewer', model: 'other', thinking: 'high' },
    });

    expect(created.body.code).toBe(0);
    const main = liveMainAgent(created.body.data.id)!;
    expect(main.accessor.get(IAgentProfileService).data().profileName).toBe('route-reviewer');
    expect(readAgentState(main, false)).toMatchObject({ model: 'other', thinking: 'high' });
  });

  it('rejects changing the profile after the session is created', async () => {
    await restartWithModels();
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });

    const updated = await postJson<SessionWire>(
      `/api/v1/sessions/${created.body.data.id}/profile`,
      {
        agent_config: { profile: 'route-reviewer' },
      },
    );

    expect(updated.body.code).toBe(40001);
    expect(JSON.stringify(updated.body)).toContain('agent_config.profile');
    const main = liveMainAgent(created.body.data.id)!;
    expect(main.accessor.get(IAgentProfileService).data().profileName).toBe('agent');
  });

  it('rejects an unknown profile at creation and creates nothing', async () => {
    await restartWithModels();
    const listed = async (): Promise<string[]> =>
      (await getJson<PageWire>('/api/v1/sessions')).body.data.items.map((session) => session.id);
    const before = await listed();

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
      agent_config: { profile: 'agent_does_not_exist' },
    });

    expect(created.body.code).toBe(40001);
    expect(created.body.msg).toContain('agent_does_not_exist');
    expect(await listed()).toEqual(before);
  });

  it('keeps the model of an existing session when the default model changes', async () => {
    await restartWithModels();
    const first = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });

    await (server as RunningServer).core.accessor.get(IModelCatalog).setDefaultModel('other');
    const second = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });

    const got = await getJson<SessionWire>(`/api/v1/sessions/${first.body.data.id}`);
    expect(got.body.data.agent_config).toEqual({ model: 'stub' });
    expect(second.body.data.agent_config).toEqual({ model: 'other' });
  });

  it('keeps the client flow of model at creation, then thinking and permission through the profile', async () => {
    await restartWithModels();
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
      agent_config: { model: 'other' },
    });
    const id = created.body.data.id;

    const updated = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { thinking: 'high', permission_mode: 'yolo' },
    });

    expect(updated.body.code).toBe(0);
    expect(readAgentState(liveMainAgent(id)!, false)).toMatchObject({
      model: 'other',
      thinking: 'high',
      permission_mode: 'yolo',
    });
  });

  it('creates a session without a model when none is available', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    expect(created.body.code).toBe(0);
    expect(created.body.data.agent_config).toEqual({ model: '' });
    expect(liveMainAgent(created.body.data.id)).toBeUndefined();

    const thinking = await postJson<SessionWire>(
      `/api/v1/sessions/${created.body.data.id}/profile`,
      {
        agent_config: { thinking: 'high' },
      },
    );
    expect(thinking.body.code).toBe(40113);
  });

  for (const agentConfig of [{ thinking: 'high' }, { profile: 'agent' }]) {
    it(`rejects agent_config ${JSON.stringify(agentConfig)} at creation when no model is available`, async () => {
      const listed = async (): Promise<string[]> =>
        (await getJson<PageWire>('/api/v1/sessions')).body.data.items.map((session) => session.id);
      const before = await listed();

      const created = await postJson<SessionWire>('/api/v1/sessions', {
        metadata: { cwd: home as string },
        agent_config: agentConfig,
      });

      expect(created.body.code).toBe(40113);
      expect(await listed()).toEqual(before);
    });
  }

  it('supports exclude_empty when listing sessions', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    const all = await getJson<PageWire>('/api/v1/sessions');
    expect(all.body.data.items.some((s) => s.id === created.body.data.id)).toBe(true);

    const filtered = await getJson<PageWire>('/api/v1/sessions?exclude_empty=true');
    expect(filtered.body.code).toBe(0);
    expect(filtered.body.data.items.some((s) => s.id === created.body.data.id)).toBe(false);
  });

  it('paginates sessions with before_id and terminates on the last page', async () => {
    await restartWithFreshHome();
    const cwd = home as string;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const { body } = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      expect(body.code).toBe(0);
      ids.push(body.data.id);
      await sleep(5);
    }

    const page1 = await getJson<PageWire>('/api/v1/sessions?page_size=3');
    expect(page1.body.code).toBe(0);
    expect(page1.body.data.items.map((s) => s.id)).toEqual(ids.slice(4).toReversed());
    expect(page1.body.data.has_more).toBe(true);

    const cursor1 = page1.body.data.items.at(-1)!.id;
    const page2 = await getJson<PageWire>(
      `/api/v1/sessions?page_size=3&before_id=${encodeURIComponent(cursor1)}`,
    );
    expect(page2.body.data.items.map((s) => s.id)).toEqual(ids.slice(1, 4).toReversed());
    expect(page2.body.data.has_more).toBe(true);

    const cursor2 = page2.body.data.items.at(-1)!.id;
    const page3 = await getJson<PageWire>(
      `/api/v1/sessions?page_size=3&before_id=${encodeURIComponent(cursor2)}`,
    );
    expect(page3.body.data.items.map((s) => s.id)).toEqual([ids[0]!]);
    expect(page3.body.data.has_more).toBe(false);

    const seen = [...page1.body.data.items, ...page2.body.data.items, ...page3.body.data.items].map(
      (s) => s.id,
    );
    expect(new Set(seen).size).toBe(7);
    expect(new Set(seen)).toEqual(new Set(ids));

    const last = await getJson<PageWire>(
      `/api/v1/sessions?page_size=3&before_id=${encodeURIComponent(ids[0]!)}`,
    );
    expect(last.body.data.items).toEqual([]);
    expect(last.body.data.has_more).toBe(false);
  });

  it('returns an empty terminal page for an unknown before_id cursor', async () => {
    const cwd = home as string;
    await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { body } = await getJson<PageWire>(
      '/api/v1/sessions?page_size=3&before_id=sess_does_not_exist',
    );
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
    expect(body.data.has_more).toBe(false);
  });

  it('gets a session by id and 404s for unknown', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    const got = await getJson<SessionWire>(`/api/v1/sessions/${created.body.data.id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.id).toBe(created.body.data.id);

    const missing = await getJson<null>('/api/v1/sessions/nope');
    expect(missing.body.code).toBe(40401);
  });

  it('updates the session title via profile', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const updated = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      title: 'renamed',
    });
    expect(updated.body.code).toBe(0);
    expect(updated.body.data.title).toBe('renamed');

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.data.title).toBe('renamed');
  });

  it('still accepts profile updates that carry the never-applied profile fields', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });

    const updated = await postJson<SessionWire>(
      `/api/v1/sessions/${created.body.data.id}/profile`,
      {
        title: 'renamed',
        agent_config: { system_prompt: 'be brief', tools: ['Read'], mcp_servers: ['docs'] },
        permission_rules: [],
      },
    );

    expect(updated.body.code).toBe(0);
    expect(updated.body.data.title).toBe('renamed');
  });

  it('returns title-unavailable when generation cannot run', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });

    const generated = await postJson<null>(
      `/api/v1/sessions/${created.body.data.id}/title/generate`,
    );

    expect(generated.body.code).toBe(40923);
  });

  it('generates and persists a title through the public REST path', async () => {
    await server?.close();
    server = undefined;
    await writeFile(
      join(home as string, 'config.toml'),
      [
        'default_model = "stub"',
        '',
        '[providers.stub]',
        'type = "openai"',
        'base_url = "http://127.0.0.1:9999"',
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 1000',
        '',
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        'base_url = "https://api.example.test/coding/v1"',
        '',
        '[providers."managed:kimi-code".oauth]',
        'storage = "file"',
        'key = "kimi-code"',
        '',
      ].join('\n'),
      'utf-8',
    );

    const oauth: IOAuthServiceType = {
      _serviceBrand: undefined,
      startLogin: async () => {
        throw new Error('unused');
      },
      getFlow: () => undefined,
      cancelLogin: async () => {
        throw new Error('unused');
      },
      logout: async () => {
        throw new Error('unused');
      },
      status: async () => ({ loggedIn: true, provider: 'managed:kimi-code' }),
      refreshOAuthProviderModels: async () => ({ changed: [], unchanged: [], failed: [] }),
      getManagedUsage: async () => ({ kind: 'error', message: 'unused' }),
      getManagedUserInfo: async () => ({ kind: 'error', message: 'unused' }),
      resolveTokenProvider: () => ({ getAccessToken: async () => 'test-token' }),
      getCachedAccessToken: async () => 'test-token',
      getRegion: () => 'mainland-cn',
      getRegionAsync: async () => 'mainland-cn',
    };
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IOAuthService, oauth]] as ScopeSeed,
    });
    base = `http://127.0.0.1:${server.port}`;

    let toolsRequest: { method: string; params: { chat_content: string } } | undefined;
    const actualFetch = globalThis.fetch.bind(globalThis);
    jest.spyOn(globalThis, 'fetch').mockImplementation((async (
      input: string | Request | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://api.example.test/coding/v1/tools') {
        const body = init?.body;
        if (typeof body !== 'string') {
          throw new TypeError('expected a string request body');
        }
        toolsRequest = JSON.parse(body) as typeof toolsRequest;
        return new Response(JSON.stringify({ title: 'generated from REST' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return actualFetch(input, init);
    }) as unknown as typeof fetch);

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    for (const text of ['first REST prompt', 'second REST prompt', 'third REST prompt']) {
      const submitted = await postJson<{ prompt_id: string }>(`/api/v1/sessions/${id}/prompts`, {
        content: [{ type: 'text', text }],
      });
      expect(submitted.body.code).toBe(0);
    }

    const generated = await postJson<{ title: string }>(`/api/v1/sessions/${id}/title/generate`);
    expect(generated.body).toMatchObject({ code: 0, data: { title: 'generated from REST' } });
    expect(toolsRequest).toEqual({
      method: 'chat_title',
      params: {
        chat_content: 'user: first REST prompt\nuser: second REST prompt\nuser: third REST prompt',
      },
    });

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body).toMatchObject({ code: 0, data: { title: 'generated from REST' } });

    const again = await postJson<null>(`/api/v1/sessions/${id}/title/generate`);
    expect(again.body.code).toBe(40923);

    const forced = await postJson<{ title: string }>(`/api/v1/sessions/${id}/title/generate`, {
      force: true,
    });
    expect(forced.body).toMatchObject({ code: 0, data: { title: 'generated from REST' } });

    await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, { title: 'custom title' });
    const forcedCustom = await postJson<{ title: string }>(
      `/api/v1/sessions/${id}/title/generate`,
      { force: true },
    );
    expect(forcedCustom.body).toMatchObject({ code: 0, data: { title: 'generated from REST' } });
    const afterCustom = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(afterCustom.body.data.title).toBe('generated from REST');

    const digested = await postJson<{ title: string }>(`/api/v1/sessions/${id}/title/generate`, {
      force: true,
      source: 'digest',
    });
    expect(digested.body).toMatchObject({ code: 0, data: { title: 'generated from REST' } });
    expect(toolsRequest?.params.chat_content).toBe(
      'user: first REST prompt\nuser: second REST prompt\nuser: third REST prompt',
    );
  });

  it('returns session-not-found when generating a title for a missing session', async () => {
    const generated = await postJson<null>('/api/v1/sessions/sess_missing_title/title/generate');

    expect(generated.body.code).toBe(40401);
  });

  it('serializes occupied errors from metadata mutation routes', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const handle = getLiveSessionById((server as RunningServer).core.accessor, id)!;
    const occupied = new Error2(ErrorCodes.SESSION_OCCUPIED, 'occupied');

    const setTitle = spyOn(handle.accessor.get(ISessionMetadata), 'setTitle').mockRejectedValue(
      occupied,
    );
    const profile = await postJson(`/api/v1/sessions/${id}/profile`, { title: 'occupied' });
    expect(profile.status).toBe(200);
    expect(profile.body.code).toBe(40931);
    setTitle.mockRestore();

    const generateTitle = spyOn(
      handle.accessor.get(ISessionTitleService),
      'generateTitle',
    ).mockRejectedValue(occupied);
    const generated = await postJson(`/api/v1/sessions/${id}/title/generate`);
    expect(generated.status).toBe(200);
    expect(generated.body.code).toBe(40931);
    generateTitle.mockRestore();

    const createChild = spyOn(
      (server as RunningServer).core.accessor.get(ISessionManager),
      'createChild',
    ).mockRejectedValue(occupied);
    const child = await postJson(`/api/v1/sessions/${id}/children`, {});
    expect(child.status).toBe(200);
    expect(child.body.code).toBe(40931);
    createChild.mockRestore();
  });

  it('no longer serves GET /status', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const res = await getJson<unknown>(`/api/v1/sessions/${created.body.data.id}/status`);
    expect(res.status).toBe(404);
  });

  async function mainAgentOf(id: string) {
    const session = getLiveSessionById((server as RunningServer).core.accessor, id)!;
    return ensureMainAgent(session);
  }

  it('applies plan/swarm/permission agent_config to the main agent state', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const before = readAgentState(await mainAgentOf(id), false);
    expect(before.plan_mode).toBe(false);
    expect(before.swarm_mode).toBe(false);

    await postJson(`/api/v1/sessions/${id}/profile`, {
      agent_config: { plan_mode: true, swarm_mode: true, permission_mode: 'yolo' },
    });

    const after = readAgentState(await mainAgentOf(id), false);
    expect(after.plan_mode).toBe(true);
    expect(after.swarm_mode).toBe(true);
    expect(after.permission_mode).toBe('yolo');
  });

  it('applies agent_config and keeps custom metadata when creating a session', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd, source: 'composer' },
      agent_config: { plan_mode: true, permission_mode: 'yolo' },
    });

    expect(created.body.code).toBe(0);
    expect(created.body.data.metadata).toMatchObject({ cwd, source: 'composer' });
    const state = readAgentState(await mainAgentOf(created.body.data.id), false);
    expect(state.plan_mode).toBe(true);
    expect(state.permission_mode).toBe('yolo');
  });

  it('keeps custom metadata for a session created by workspace_id alone', async () => {
    const cwd = home as string;
    const first = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      workspace_id: first.body.data.workspace_id,
      metadata: { source: 'composer' },
    });

    expect(created.body.code).toBe(0);
    expect(created.body.data.metadata).toMatchObject({ cwd, source: 'composer' });
  });

  it('drops the child-link metadata keys when creating an ordinary session', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd, parent_session_id: parentId, child_session_kind: 'child' },
    });

    expect(created.body.code).toBe(0);
    expect(created.body.data.metadata).not.toHaveProperty('parent_session_id');
    expect(created.body.data.metadata).not.toHaveProperty('child_session_kind');
    const children = await getJson<PageWire>(`/api/v1/sessions/${parentId}/children`);
    expect(children.body.data.items.some((s) => s.id === created.body.data.id)).toBe(false);
  });

  it('moves a session in place to another cwd while retaining history and cold-resume bindings', async () => {
    const destination = join(home as string, 'moved-project');
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'destination.txt'), 'new workspace');
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string, source: 'original' },
      title: 'Keep title',
    });
    const id = created.body.data.id;
    await ensureMainAgent(getLiveSessionById(server!.core.accessor, id)!);
    const originalAgent = getLiveSessionById(server!.core.accessor, id)!
      .accessor.get(IAgentLifecycleService)
      .handleOf('main')!;
    originalAgent.accessor.get(IAgentEnvironmentBindingService).bind('local', home as string);
    await originalAgent.accessor
      .get(IEventDispatcher)
      .dispatch(
        new ContextAppendMessage({
          agentId: 'main',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Keep migration history' }],
            toolCalls: [],
          },
        }),
      );
    const moved = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      metadata: { cwd: destination, marker: 'moved' },
    });
    expect(moved.body.code).toBe(0);
    expect(moved.body.data.id).toBe(id);
    expect(moved.body.data.metadata).toMatchObject({
      cwd: destination,
      source: 'original',
      marker: 'moved',
    });
    expect(moved.body.data.workspace_id).not.toBe(created.body.data.workspace_id!);
    expect(moved.body.data.title).toBe('Keep title');
    await closeSessionById(server!.core.accessor, id);
    const resumed = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(resumed.body.data.metadata.cwd).toBe(destination);
    const read = await postJson<{ content: string }>(`/api/v1/sessions/${id}/fs:read`, {
      path: 'destination.txt',
    });
    expect(read.body.code).toBe(0);
    expect(read.body.data.content).toBe('new workspace');
    const agent = getLiveSessionById(server!.core.accessor, id)!
      .accessor.get(IAgentLifecycleService)
      .handleOf('main')!;
    expect(agent.accessor.get(IAgentEnvironmentBindingService).current.cwd).toBe(destination);
    expect(JSON.stringify(agent.accessor.get(IAgentContextMemoryService).get())).toContain(
      'Keep migration history',
    );
  });

  it('rolls a failed directory migration back without losing its source session', async () => {
    const destination = join(home as string, 'rollback-project');
    await mkdir(destination, { recursive: true });
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const fs = server!.core.accessor.get(IHostFileSystem);
    const rename = fs.rename!.bind(fs);
    let calls = 0;
    const failure = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      calls += 1;
      if (calls === 1) throw new Error('injected move failure');
      await rename(from, to);
    });
    try {
      const result = await postJson<SessionWire>(
        `/api/v1/sessions/${created.body.data.id}/profile`,
        { metadata: { cwd: destination } },
      );
      expect(result.body.code).not.toBe(0);
      const restored = await getJson<SessionWire>(`/api/v1/sessions/${created.body.data.id}`);
      expect(restored.body.data.workspace_id).toBe(created.body.data.workspace_id!);
      expect(restored.body.data.metadata.cwd).toBe(home as string);
    } finally {
      failure.mockRestore();
    }
  });

  it('rolls back a persistence failure after the session directory was moved', async () => {
    const destination = join(home as string, 'rollback-after-rename');
    await mkdir(destination, { recursive: true });
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const docs = server!.core.accessor.get(IAtomicDocumentStore);
    const set = docs.set.bind(docs);
    let injected = false;
    const failure = spyOn(docs, 'set').mockImplementation(async (scope, key, value) => {
      if (
        !injected &&
        key === 'state.json' &&
        typeof value === 'object' &&
        value !== null &&
        'cwd' in value &&
        value.cwd === destination
      ) {
        injected = true;
        throw new Error('injected persistence failure');
      }
      await set(scope, key, value);
    });
    try {
      const result = await postJson<SessionWire>(
        `/api/v1/sessions/${created.body.data.id}/profile`,
        { metadata: { cwd: destination } },
      );
      expect(injected).toBe(true);
      expect(result.body.code).not.toBe(0);
      await closeSessionById(server!.core.accessor, created.body.data.id);
      expect(
        (await getJson<SessionWire>(`/api/v1/sessions/${created.body.data.id}`)).body.data
          .workspace_id,
      ).toBe(created.body.data.workspace_id!);
    } finally {
      failure.mockRestore();
    }
  });

  it('refuses migration when a prompt cannot be quiesced and preserves its original cwd', async () => {
    const destination = join(home as string, 'busy-migration');
    await mkdir(destination, { recursive: true });
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const session = getLiveSessionById(server!.core.accessor, created.body.data.id)!;
    await ensureMainAgent(session);
    const loop = session.accessor
      .get(IAgentLifecycleService)
      .handleOf('main')!
      .accessor.get(IAgentLoopService);
    const pause = loop.tryAcquireQuiescence()!;
    try {
      const result = await postJson<SessionWire>(
        `/api/v1/sessions/${created.body.data.id}/profile`,
        { metadata: { cwd: destination } },
      );
      expect(result.body.code).toBe(40901);
      expect(
        (await getJson<SessionWire>(`/api/v1/sessions/${created.body.data.id}`)).body.data.metadata
          .cwd,
      ).toBe(home as string);
    } finally {
      pause.dispose();
    }
  });

  it('drops the reserved metadata keys when updating the session profile', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const updated = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      metadata: {
        cwd,
        goal: 'not a goal',
        parent_session_id: parentId,
        child_session_kind: 'child',
        source: 'composer',
      },
    });

    expect(updated.body.code).toBe(0);
    expect(updated.body.data.metadata).toEqual({ cwd, source: 'composer' });
    const children = await getJson<PageWire>(`/api/v1/sessions/${parentId}/children`);
    expect(children.body.data.items.some((s) => s.id === id)).toBe(false);
  });

  for (const patch of [
    { source: 'composer' },
    { parent_session_id: null, child_session_kind: null },
    { parent_session_id: 'session_other', child_session_kind: 'child', source: 'composer' },
  ]) {
    it(`keeps a child session linked when its profile metadata is ${JSON.stringify(patch)}`, async () => {
      const cwd = home as string;
      const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      const parentId = parent.body.data.id;
      const child = await postJson<SessionWire>(`/api/v1/sessions/${parentId}/children`, {});
      const childId = child.body.data.id;

      const updated = await postJson<SessionWire>(`/api/v1/sessions/${childId}/profile`, {
        metadata: patch,
      });

      expect(updated.body.code).toBe(0);
      const children = await getJson<PageWire>(`/api/v1/sessions/${parentId}/children`);
      expect(children.body.data.items.some((s) => s.id === childId)).toBe(true);
    });
  }

  it('preserves custom metadata when a profile patch names only its current cwd', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd, source: 'composer' },
    });

    const updated = await postJson<SessionWire>(
      `/api/v1/sessions/${created.body.data.id}/profile`,
      {
        metadata: { cwd },
      },
    );

    expect(updated.body.code).toBe(0);
    expect(updated.body.data.metadata).toEqual({ cwd, source: 'composer' });
  });

  it('reports an unknown creation model as a validation error and creates nothing', async () => {
    const listed = async (): Promise<string[]> =>
      (await getJson<PageWire>('/api/v1/sessions')).body.data.items.map((session) => session.id);
    const before = await listed();

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
      agent_config: { model: 'no-such-model' },
    });

    expect(created.body.code).toBe(40001);
    expect(await listed()).toEqual(before);
  });

  it('rejects enabling tower_mode before creating anything', async () => {
    const listed = async (): Promise<string[]> =>
      (await getJson<PageWire>('/api/v1/sessions')).body.data.items.map((session) => session.id);
    const before = await listed();

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
      agent_config: { tower_mode: true, tower_base: 'release' },
    });

    expect(created.body.code).toBe(40001);
    expect(await listed()).toEqual(before);
  });

  it.each([{ model: '' }, { tower_base: 'main' }])(
    'does not create the main agent for agent_config %o, which has nothing to apply',
    async (agentConfig) => {
      const created = await postJson<SessionWire>('/api/v1/sessions', {
        metadata: { cwd: home as string },
        agent_config: agentConfig,
      });

      expect(created.body.code).toBe(0);
      const session = getLiveSessionById(
        (server as RunningServer).core.accessor,
        created.body.data.id,
      )!;
      expect(session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)).toBeUndefined();
    },
  );

  it('creates nothing and announces nothing when its agent_config cannot be applied', async () => {
    const cwd = home as string;
    const listed = async (): Promise<string[]> =>
      (await getJson<PageWire>('/api/v1/sessions')).body.data.items.map((session) => session.id);
    const before = await listed();
    const announced: string[] = [];
    const subscription = (server as RunningServer).core.accessor
      .get(IEventService)
      .subscribe((event) => announced.push(event.type));

    try {
      const created = await postJson<SessionWire>('/api/v1/sessions', {
        metadata: { cwd },
        agent_config: { goal_control: 'pause' },
      });

      expect(created.body.code).toBe(40914);
      expect(await listed()).toEqual(before);
      expect(announced.filter((type) => type.startsWith('event.session.'))).toEqual([]);
      const index = (server as RunningServer).core.accessor.get(ISessionIndexMirror);
      expect(index.pending().filter((summary) => !before.includes(summary.id))).toEqual([]);
    } finally {
      subscription.dispose();
    }
  });

  it('rejects tower_mode agent_config when the tower feature is unavailable', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    expect(readAgentState(await mainAgentOf(id), false).tower_mode).toBe(false);

    const on = await postJson(`/api/v1/sessions/${id}/profile`, {
      agent_config: { tower_mode: true },
    });
    expect(on.body.code).toBe(40935);
    expect(on.body.msg).toContain('the tower experiment is disabled');
    expect(on.body.msg).toContain('KIMI_CODE_EXPERIMENTAL_TOWER=1');
    expect(readAgentState(await mainAgentOf(id), false).tower_mode).toBe(false);

    const off = await postJson(`/api/v1/sessions/${id}/profile`, {
      agent_config: { tower_mode: false },
    });
    expect(off.body.code).toBe(0);
    expect(readAgentState(await mainAgentOf(id), false).tower_mode).toBe(false);
  });

  it('projects legacy limited goal states as blocked for the official client', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
      agent_config: { goal_objective: 'compatibility' },
    });
    const agent = getLiveSessionById(server!.core.accessor, created.body.data.id)!
      .accessor.get(IAgentLifecycleService)
      .handleOf('main')!;
    const service = agent.accessor.get(IAgentGoalService);
    const current = service.getGoal();
    const limited = spyOn(service, 'getGoal').mockReturnValue({
      ...current,
      goal: { ...current.goal!, status: 'budget_limited' },
    });
    try {
      const goal = await getJson<GoalWire>(`/api/v1/sessions/${created.body.data.id}/goal`);
      expect(goal.body.data.status).toBe('blocked');
      expect(goal.body.data.goalId).toBe(current.goal!.goalId);
    } finally {
      limited.mockRestore();
    }
  });

  it('returns the current goal via GET /goal', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const before = await getJson<unknown>(`/api/v1/sessions/${id}/goal`);
    expect(before.body.data).toBeNull();

    await postJson(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'fix all lint warnings' },
    });

    const after = await getJson<{ objective: string; status: string } | null>(
      `/api/v1/sessions/${id}/goal`,
    );
    expect(after.body.data?.objective).toBe('fix all lint warnings');
    expect(after.body.data?.status).toBe('active');
  });

  it('edits the goal objective via PATCH /goal and publishes goal.updated', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    await postJson(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'fix all lint warnings' },
    });
    const agent = getLiveSessionById((server as RunningServer).core.accessor, id)
      ?.accessor.get(IAgentLifecycleService)
      .handleOf(MAIN_AGENT_ID);
    if (agent === undefined) throw new Error('expected a live main agent');
    const events: Event2<any>[] = [];
    const subscription = agent.accessor.get(IEventBus).subscribe((event) => events.push(event));

    try {
      const edited = await patchJson<GoalWire>(`/api/v1/sessions/${id}/goal`, {
        objective: 'fix all type errors',
      });

      expect(edited.body.code).toBe(0);
      expect(edited.body.data.objective).toBe('fix all type errors');
      expect(edited.body.data.status).toBe('active');
      const updated = events.filter((event) => event.type === 'goal.updated');
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ snapshot: { objective: 'fix all type errors' } });
    } finally {
      subscription.dispose();
    }
  });

  it('maps goal edit failures to typed errors', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;

    const missing = await patchJson<null>(`/api/v1/sessions/${id}/goal`, { objective: 'work' });
    expect(missing.body.code).toBe(40914);

    await postJson(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'fix all lint warnings' },
    });
    const invalid = await patchJson<null>(`/api/v1/sessions/${id}/goal`, {});
    expect(invalid.body.code).toBe(40001);
    const unknown = await patchJson<null>('/api/v1/sessions/ses_missing/goal', {
      objective: 'work',
    });
    expect(unknown.body.code).toBe(40401);
  });

  it('starts one continuation when the Web profile resumes a blocked goal', async () => {
    const rig = await createBlockedGoalRig();
    try {
      const resumed = await postJson<SessionWire>(`/api/v1/sessions/${rig.id}/profile`, {
        agent_config: { goal_control: 'resume' },
      });

      expect(resumed.body.code).toBe(0);
      expect(goalContinuationStarts(rig.events)).toHaveLength(1);
    } finally {
      await rig.cancel();
    }
  });

  it('starts one continuation when the Web profile resumes a paused goal', async () => {
    const rig = await createStoppedGoalRig('paused');
    try {
      const resumed = await postJson<SessionWire>(`/api/v1/sessions/${rig.id}/profile`, {
        agent_config: { goal_control: 'resume' },
      });

      expect(resumed.body.code).toBe(0);
      expect(goalContinuationStarts(rig.events)).toHaveLength(1);
    } finally {
      await rig.cancel();
    }
  });

  it('returns the active goal when the Web refreshes after blocked-goal resume', async () => {
    const rig = await createBlockedGoalRig();
    try {
      rig.eventBus.publish(
        new TurnStarted({ agentId: 'main', turnId: 999, origin: { kind: 'user' } }),
      );
      await postJson<SessionWire>(`/api/v1/sessions/${rig.id}/profile`, {
        agent_config: { goal_control: 'resume' },
      });

      const refreshed = await getJson<{ status: string } | null>(`/api/v1/sessions/${rig.id}/goal`);

      expect(refreshed.body.data?.status).toBe('active');
    } finally {
      await rig.cancel();
    }
  });

  it('takes over the session lock via :takeover', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const takeover = jest.spyOn(
      (server as RunningServer).core.accessor.get(ISessionLockService),
      'takeover',
    );
    try {
      const taken = await postJson<{ taken_over: boolean }>(`/api/v1/sessions/${id}:takeover`);
      expect(taken.body.code).toBe(0);
      expect(taken.body.data).toEqual({ taken_over: true });
      expect(takeover).toHaveBeenCalledWith(id);

      const missing = await postJson<null>('/api/v1/sessions/sess_missing_takeover:takeover');
      expect(missing.body.code).toBe(40401);
      expect(takeover).toHaveBeenCalledTimes(1);
    } finally {
      takeover.mockRestore();
    }
  });

  it('archives a session via :archive and reflects archived flag on get', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const archived = await postJson<{ archived: boolean }>(`/api/v1/sessions/${id}:archive`);
    expect(archived.body.code).toBe(0);
    expect(archived.body.data).toEqual({ archived: true });

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.archived).toBe(true);
  });

  it('resumes a session whose workspace root is gone (root validity deferred to binding) and still archives it', async () => {
    const cwd = join(home as string, 'gone-ws');
    await mkdir(cwd);
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    await closeSessionById((server as RunningServer).core.accessor, id);
    await (server as RunningServer).core.accessor
      .get(IWorkspaceService)
      .delete(encodeWorkDirKey(cwd));
    await rm(cwd, { recursive: true, force: true });

    const resumed = await resumeSessionById((server as RunningServer).core.accessor, id);
    expect(resumed?.id).toBe(id);

    const archived = await postJson<{ archived: boolean }>(`/api/v1/sessions/${id}:archive`);
    expect(archived.body.code).toBe(0);
    expect(archived.body.data).toEqual({ archived: true });

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.archived).toBe(true);
  });

  it('restores an archived session via :restore and returns it to the default list', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    await postJson<{ archived: boolean }>(`/api/v1/sessions/${id}:archive`);

    const restored = await postJson<SessionWire>(`/api/v1/sessions/${id}:restore`);
    expect(restored.body.code).toBe(0);
    expect(restored.body.data.id).toBe(id);
    expect(restored.body.data.archived).toBe(false);

    const listed = await getJson<PageWire>('/api/v1/sessions');
    expect(listed.body.code).toBe(0);
    expect(listed.body.data.items.find((s) => s.id === id)?.archived).toBe(false);
  });

  it('returns 40401 when restoring a missing session', async () => {
    const { body } = await postJson<null>('/api/v1/sessions/sess_missing:restore');
    expect(body.code).toBe(40401);
  });

  it('deletes a session via :delete and publishes event.session.deleted', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    const workspaceId = created.body.data.workspace_id;

    const events: Event2<any>[] = [];
    const sub = (server as RunningServer).core.accessor
      .get(IEventService)
      .subscribe((event) => events.push(event));
    try {
      const deleted = await postJson<{ deleted: boolean }>(`/api/v1/sessions/${id}:delete`);
      expect(deleted.body.code).toBe(0);
      expect(deleted.body.data).toEqual({ deleted: true });

      const got = await getJson<null>(`/api/v1/sessions/${id}`);
      expect(got.body.code).toBe(40401);
      await expect(readFile(join(home!, 'server', 'events', `${id}.jsonl`))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      expect(
        events
          .filter((event) => event.type === 'event.session.deleted')
          .map((event) => (event as { readonly payload?: unknown }).payload),
      ).toEqual([{ sessionId: id, workspaceId }]);
    } finally {
      sub.dispose();
    }
  });

  it('deletes a cold session via :delete and publishes event.session.deleted', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    const workspaceId = created.body.data.workspace_id;
    await closeSessionById((server as RunningServer).core.accessor, id);
    expect(getLiveSessionById((server as RunningServer).core.accessor, id)).toBeUndefined();

    const events: Event2<any>[] = [];
    const sub = (server as RunningServer).core.accessor
      .get(IEventService)
      .subscribe((event) => events.push(event));
    try {
      const deleted = await postJson<{ deleted: boolean }>(`/api/v1/sessions/${id}:delete`);
      expect(deleted.body.code).toBe(0);
      expect(deleted.body.data).toEqual({ deleted: true });

      expect(
        events
          .filter((event) => event.type === 'event.session.deleted')
          .map((event) => (event as { readonly payload?: unknown }).payload),
      ).toEqual([{ sessionId: id, workspaceId }]);
    } finally {
      sub.dispose();
    }
  });

  it('reloads a session via :reload and injects change reminders for external updates', async () => {
    await server?.close();
    server = undefined;
    await writeFile(
      join(home as string, 'config.toml'),
      [
        'default_model = "stub"',
        '',
        '[providers.stub]',
        'type = "openai"',
        'base_url = "http://127.0.0.1:9999"',
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 1000',
        '',
        '[watch]',
        'enabled = false',
        '',
      ].join('\n'),
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;

    const cwd = await mkdtemp(join(tmpdir(), 'kimi-reload-cwd-'));
    const extra = await mkdtemp(join(tmpdir(), 'kimi-reload-extra-'));
    await mkdir(join(cwd, '.git'));
    try {
      const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      const id = created.body.data.id;
      const bound = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
        agent_config: { model: 'stub' },
      });
      expect(bound.body.code).toBe(0);

      const first = await postJson<SessionWire>(`/api/v1/sessions/${id}:reload`);
      expect(first.body.code).toBe(0);
      expect(first.body.data.id).toBe(id);

      const baseline = await getJson<{ items: unknown[]; has_more: boolean }>(
        `/api/v1/sessions/${id}/messages`,
      );
      const baselineCount = baseline.body.data.items.length;

      await writeFile(join(cwd, 'AGENTS.md'), 'new workspace rules');
      const projectsPath = join(home as string, 'workspaces.json');
      const projects = JSON.parse(await readFile(projectsPath, 'utf8')) as {
        workspaces: Record<string, { root: string; additional_dirs?: string[] }>;
      };
      const project = Object.values(projects.workspaces).find((entry) => entry.root === cwd);
      if (project === undefined) throw new Error('expected the session project');
      project.additional_dirs = [extra];
      await writeFile(projectsPath, JSON.stringify(projects), 'utf8');

      const second = await postJson<SessionWire>(`/api/v1/sessions/${id}:reload`);
      expect(second.body.code).toBe(0);

      const after = await getJson<{
        items: {
          content: { type: string; text?: string }[];
          metadata?: { origin?: { variant?: string } };
        }[];
        has_more: boolean;
      }>(`/api/v1/sessions/${id}/messages`);
      expect(after.body.data.items.length).toBeGreaterThan(baselineCount);
      const text = JSON.stringify(after.body.data.items);
      expect(text).toContain('AGENTS.md');
      expect(text).toContain('were not included in your system prompt');
      const workspaceDirsReminders = after.body.data.items.filter(
        (item) => item.metadata?.origin?.variant === 'workspace_dirs_change',
      );
      expect(workspaceDirsReminders).toHaveLength(1);
      expect(
        workspaceDirsReminders[0]?.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join(''),
      ).toContain(`Added directories: ${extra}.`);

      const third = await postJson<SessionWire>(`/api/v1/sessions/${id}:reload`);
      expect(third.body.code).toBe(0);
      const reloaded = await getJson<{
        items: { metadata?: { origin?: { variant?: string } } }[];
        has_more: boolean;
      }>(`/api/v1/sessions/${id}/messages`);
      expect(
        reloaded.body.data.items.filter(
          (item) => item.metadata?.origin?.variant === 'workspace_dirs_change',
        ),
      ).toHaveLength(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(extra, { recursive: true, force: true });
    }
  });

  it('restores workspace-dir reminders when :reload fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'kimi-reload-failure-cwd-'));
    const extra = await mkdtemp(join(tmpdir(), 'kimi-reload-failure-extra-'));
    await mkdir(join(cwd, '.git'));
    try {
      const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      const id = created.body.data.id;
      const before = getLiveSessionById((server as RunningServer).core.accessor, id);
      if (before === undefined) throw new Error('expected a live session');
      const main = await ensureMainAgent(before);
      await main.accessor.get(IAgentChangeNotifierService).notifyWorkspaceDirsChanges();
      const target = (server as RunningServer).core.accessor
        .get(IWorkspaceInstanceManager)
        .get(created.body.data.workspace_id);
      if (target === undefined) throw new Error('expected the session workspace');
      const projectsPath = join(home as string, 'workspaces.json');
      const projects = JSON.parse(await readFile(projectsPath, 'utf8')) as {
        workspaces: Record<string, { root: string; additional_dirs?: string[] }>;
      };
      const project = Object.values(projects.workspaces).find((entry) => entry.root === cwd);
      if (project === undefined) throw new Error('expected the session project');
      project.additional_dirs = [extra];
      await writeFile(projectsPath, JSON.stringify(projects), 'utf8');
      spyOn(target.program.instructions, 'reload').mockRejectedValueOnce(
        new Error('instructions reload failed'),
      );

      const failed = await postJson<SessionWire>(`/api/v1/sessions/${id}:reload`);
      expect(failed.body.code).toBe(50001);
      expect(failed.body.msg).toBe('instructions reload failed');
      expect(getLiveSessionById((server as RunningServer).core.accessor, id)).toBe(before);
      const reminders = main.accessor
        .get(IAgentContextMemoryService)
        .get()
        .filter(
          (message) =>
            message.origin?.kind === 'injection' &&
            message.origin.variant === 'workspace_dirs_change',
        );
      expect(reminders).toHaveLength(1);
      expect(
        reminders[0]?.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      ).toContain(`Added directories: ${extra}.`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(extra, { recursive: true, force: true });
    }
  });

  it('delivers a single subagents reminder when profiles and the model pool change together', async () => {
    await server?.close();
    server = undefined;
    const configToml = [
      'default_model = "stub"',
      '',
      '[providers.stub]',
      'type = "openai"',
      'base_url = "http://127.0.0.1:9999"',
      'api_key = "stub"',
      '',
      '[models.stub]',
      'provider = "stub"',
      'model = "stub"',
      'max_context_size = 1000',
      '',
      '[watch]',
      'enabled = false',
      '',
    ].join('\n');
    await writeFile(join(home as string, 'config.toml'), configToml, 'utf-8');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;

    const cwd = await mkdtemp(join(tmpdir(), 'kimi-reload-pool-cwd-'));
    await mkdir(join(cwd, '.git'));
    try {
      const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      const id = created.body.data.id;
      const bound = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
        agent_config: { model: 'stub' },
      });
      expect(bound.body.code).toBe(0);

      await mkdir(join(home as string, 'agents'), { recursive: true });
      await writeFile(
        join(home as string, 'agents', 'deploy.md'),
        '---\nname: deploy\ndescription: Deploys things.\n---\nYou deploy things.\n',
        'utf-8',
      );
      await writeFile(
        join(home as string, 'config.toml'),
        `${configToml}[secondary_model.models]\n"stub" = "fast stub"\n`,
        'utf-8',
      );

      const reloaded = await postJson<SessionWire>(`/api/v1/sessions/${id}:reload`);
      expect(reloaded.body.code).toBe(0);

      const after = await getJson<{ items: unknown[]; has_more: boolean }>(
        `/api/v1/sessions/${id}/messages`,
      );
      const subagentReminders = (
        after.body.data.items as {
          metadata?: { origin?: { kind?: string; variant?: string } };
        }[]
      ).filter((item) => item.metadata?.origin?.variant === 'subagents_change');
      expect(subagentReminders).toHaveLength(1);
      const text = JSON.stringify(subagentReminders[0]);
      expect(text).toContain('Profiles added: deploy');
      expect(text).toContain('Models added: stub');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(join(home as string, 'agents'), { recursive: true, force: true });
    }
  });

  it.each(['closing', 'cleanup'] as const)(
    'waits for %s before recreating an explicit session id',
    async (phase) => {
      const manager = server!.core.accessor.get(ISessionManager);
      const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home } });
      const id = created.body.data.id;
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const event =
        phase === 'closing' ? manager.onWillCloseSession! : manager.onWillDeleteSession!;
      const sub = event((event) => {
        if (event.sessionId !== id) return;
        event.waitUntil(gate);
        enter();
      });
      try {
        const deletion = manager.delete(id);
        await entered;
        let recreated = false;
        const creation = manager.create({ sessionId: id, workDir: home! }).then((handle) => {
          recreated = true;
          return handle;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(recreated).toBe(false);
        release();
        await deletion;
        await creation;
        expect(manager.get(id)).toBeDefined();
      } finally {
        release();
        sub.dispose();
      }
    },
  );

  it('rejects a missing session delete and an unsupported action suffix with their error codes', async () => {
    const { body } = await postJson<null>('/api/v1/sessions/sess_missing:delete');
    expect(body.code).toBe(40401);

    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const suffix = await postJson<null>(`/api/v1/sessions/${created.body.data.id}:restart`);
    expect(suffix.body.code).toBe(40001);
  });

  it('cold-loads a persisted session on :undo and reports an unknown turn instead of 40401', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    await closeSessionById((server as RunningServer).core.accessor, id);

    const res = await postJson<null>(`/api/v1/sessions/${id}:undo`, { turn_id: 't_missing' });
    expect(res.body.code).toBe(40422);
  });

  it('returns 40901 when :undo reports a busy session', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const session = getLiveSessionById(
      (server as RunningServer).core.accessor,
      created.body.data.id,
    );
    if (session === undefined) throw new Error('expected live session');
    await session.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    await agent.accessor.get(IEventDispatcher).dispatch(
      new TurnPrompt({
        agentId: MAIN_AGENT_ID,
        input: [{ type: 'text', text: 'first prompt' }],
        origin: { kind: 'user' },
        turnId: 0,
      }),
    );
    await agent.accessor.get(IEventDispatcher).dispatch(
      new ContextAppendMessage({
        agentId: MAIN_AGENT_ID,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'first prompt' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      }),
    );
    await agent.accessor
      .get(IEventDispatcher)
      .dispatch(new TurnEnded({ agentId: MAIN_AGENT_ID, turnId: 0, reason: 'completed' }));
    const page = await getJson<ConversationTurnsPage>(
      `/api/v1/sessions/${created.body.data.id}/agents/main/turns`,
    );
    const undo = spyOn(ConversationFeed.prototype, 'undo').mockRejectedValue(
      new Error2(ErrorCodes.SESSION_BUSY, 'session is busy'),
    );

    try {
      const response = await postJson<null>(`/api/v1/sessions/${created.body.data.id}:undo`, {
        turn_id: page.body.data.turns[0]!.turn_id,
      });

      expect(response.body.code).toBe(40901);
    } finally {
      undo.mockRestore();
    }
  });

  it('returns 40901 when :reload is requested during an active compaction', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, id);
    if (session === undefined) throw new Error('expected live session');
    await session.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const compactionService = agent.accessor.get(IAgentFullCompactionService);
    const originalDescriptor = Object.getOwnPropertyDescriptor(compactionService, 'compacting');
    Object.defineProperty(compactionService, 'compacting', {
      configurable: true,
      get: () => ({}) as never,
    });

    try {
      const response = await postJson<null>(`/api/v1/sessions/${id}:reload`);
      expect(response.body.code).toBe(40901);
    } finally {
      if (originalDescriptor === undefined) {
        delete (compactionService as unknown as Record<string, unknown>)['compacting'];
      } else {
        Object.defineProperty(compactionService, 'compacting', originalDescriptor);
      }
    }
  });

  it('returns 40910 when :compact is requested while a compaction is already running', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, id);
    if (session === undefined) throw new Error('expected live session');
    await session.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const begin = spyOn(agent.accessor.get(IAgentFullCompactionService), 'begin').mockReturnValue(
      false,
    );

    try {
      const response = await postJson<null>(`/api/v1/sessions/${id}:compact`, {
        instruction: 'keep the plan',
      });
      expect(response.body.code).toBe(40910);
      expect(begin).toHaveBeenCalledWith({ source: 'manual', instruction: 'keep the plan' });
    } finally {
      begin.mockRestore();
    }
  });

  it('creates a child session tagged with parent_session_id and child_session_kind', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    expect(parent.body.code).toBe(0);
    const parentId = parent.body.data.id;

    const child = await postJson<SessionWire>(`/api/v1/sessions/${parentId}/children`, {
      title: 'child-title',
      metadata: { branch: 'direct-child' },
    });
    expect(child.status).toBe(200);
    expect(child.body.code).toBe(0);
    expect(child.body.data.id).not.toBe(parentId);
    expect(child.body.data.title).toBe('child-title');
    expect(child.body.data.metadata['parent_session_id']).toBe(parentId);
    expect(child.body.data.metadata['child_session_kind']).toBe('child');
    expect(child.body.data.metadata['branch']).toBe('direct-child');
    expect(child.body.data.metadata.cwd).toBe(cwd);
  });

  it('defaults the child title to "Child: <parent title>"', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', {
      title: 'parent-title',
      metadata: { cwd },
    });
    const child = await postJson<SessionWire>(
      `/api/v1/sessions/${parent.body.data.id}/children`,
      {},
    );
    expect(child.body.code).toBe(0);
    expect(child.body.data.title).toBe('Child: parent-title');
  });

  it('lists direct children and omits grandchildren', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const child = await postJson<SessionWire>(`/api/v1/sessions/${parentId}/children`, {
      metadata: { branch: 'child' },
    });
    const childId = child.body.data.id;
    const grandchild = await postJson<SessionWire>(`/api/v1/sessions/${childId}/children`, {
      metadata: { branch: 'grandchild' },
    });
    const grandchildId = grandchild.body.data.id;

    const parentChildren = await getJson<PageWire>(`/api/v1/sessions/${parentId}/children`);
    expect(parentChildren.body.code).toBe(0);
    expect(parentChildren.body.data.items.some((s) => s.id === childId)).toBe(true);
    expect(parentChildren.body.data.items.some((s) => s.id === grandchildId)).toBe(false);

    const childChildren = await getJson<PageWire>(`/api/v1/sessions/${childId}/children`);
    expect(childChildren.body.code).toBe(0);
    expect(childChildren.body.data.items.some((s) => s.id === grandchildId)).toBe(true);
  });

  it('does not list a plain fork as a child (kind must be "child")', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const invalid = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {
      turn_index: -1,
    });
    expect(invalid.body.code).toBe(40001);
    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
    expect(forked.body.code).toBe(0);

    const children = await getJson<PageWire>(`/api/v1/sessions/${parentId}/children`);
    expect(children.body.code).toBe(0);
    expect(children.body.data.items.some((s) => s.id === forked.body.data.id)).toBe(false);
  });

  it('fork clears inherited cron tasks while the source keeps them', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
    expect(session).toBeDefined();
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const main = session!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    main.accessor.get(IAgentContextMemoryService).append({
      role: 'user',
      content: [{ type: 'text', text: 'selected through REST' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    await main.accessor.get(IWireService).flush();
    const cron = main.accessor.get(IAgentCronService);
    const task = cron.addTask({ cron: '0 9 * * *', prompt: 'fork me', recurring: true });

    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {
      turn_index: 0,
    });
    expect(forked.body.code).toBe(0);
    const forkedId = forked.body.data.id;

    expect(getLiveSessionById((server as RunningServer).core.accessor, forkedId)).toBeUndefined();

    const resumed = await resumeSessionById((server as RunningServer).core.accessor, forkedId);
    expect(resumed).toBeDefined();
    const forkedMain = resumed!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    expect(forkedMain.accessor.get(IAgentContextMemoryService).get()[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'selected through REST' }],
    });
    const forkedCron = forkedMain.accessor.get(IAgentCronService);
    expect(forkedCron.list()).toEqual([]);
    expect(cron.list().map((t) => ({ id: t.id, prompt: t.prompt }))).toEqual([
      { id: task.id, prompt: 'fork me' },
    ]);
  });

  it.each([
    {
      kind: 'generated',
      title: 'Generated title',
      apply: (metadata: ISessionMetadata) =>
        metadata.setGeneratedTitleIfUncustomized('Generated title', { force: true }),
    },
    {
      kind: 'custom',
      title: 'Custom title',
      apply: (metadata: ISessionMetadata) => metadata.setTitle('Custom title'),
    },
    {
      kind: 'replaceable',
      title: 'Replaceable title',
      apply: (metadata: ISessionMetadata) =>
        metadata.update({ title: 'Replaceable title', titleKind: 'replaceable' }),
    },
  ])(
    'fork with a default title inherits the source titleKind "$kind"',
    async ({ kind, title, apply }) => {
      const cwd = home as string;
      const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      const parentId = parent.body.data.id;
      const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
      expect(session).toBeDefined();
      await apply(session!.accessor.get(ISessionMetadata));

      const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
      expect(forked.body.code).toBe(0);

      const forkedDir = join(
        home as string,
        'sessions',
        parent.body.data.workspace_id,
        forked.body.data.id,
      );
      const forkedState = JSON.parse(await readFile(join(forkedDir, 'state.json'), 'utf8'));
      expect(forkedState.title).toBe(`Fork: ${title}`);
      expect(forkedState.titleKind).toBe(kind);
    },
  );

  it('marks a fork with an explicit title as custom regardless of the source titleKind', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
    expect(session).toBeDefined();
    await session!.accessor
      .get(ISessionMetadata)
      .setGeneratedTitleIfUncustomized('Generated title', { force: true });

    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {
      title: 'Named fork',
    });
    expect(forked.body.code).toBe(0);

    const forkedDir = join(
      home as string,
      'sessions',
      parent.body.data.workspace_id,
      forked.body.data.id,
    );
    const forkedState = JSON.parse(await readFile(join(forkedDir, 'state.json'), 'utf8'));
    expect(forkedState.title).toBe('Named fork');
    expect(forkedState.titleKind).toBe('custom');
  });

  it('undoes a steered turn by its id together with its in-turn steers', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home } });
    const id = created.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, id)!;
    await session.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const dispatcher = agent.accessor.get(IEventDispatcher);
    await dispatcher.dispatch(
      new TurnPrompt({
        agentId: MAIN_AGENT_ID,
        input: [{ type: 'text', text: 'original prompt' }],
        origin: { kind: 'user' },
        turnId: 0,
      }),
    );
    await dispatcher.dispatch(
      new ContextAppendMessage({
        agentId: MAIN_AGENT_ID,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'original prompt' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      }),
    );
    await dispatcher.dispatch(
      new ContextAppendMessage({
        agentId: MAIN_AGENT_ID,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer before steer' }],
          toolCalls: [],
        },
      }),
    );
    await dispatcher.dispatch(
      new TurnSteer({
        agentId: MAIN_AGENT_ID,
        input: [{ type: 'text', text: 'steered prompt' }],
        origin: { kind: 'user', inTurn: true },
      }),
    );
    await dispatcher.dispatch(
      new ContextAppendMessage({
        agentId: MAIN_AGENT_ID,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'steered prompt' }],
          toolCalls: [],
          origin: { kind: 'user', inTurn: true },
        },
      }),
    );
    await dispatcher.dispatch(
      new ContextAppendMessage({
        agentId: MAIN_AGENT_ID,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer after steer' }],
          toolCalls: [],
        },
      }),
    );
    await dispatcher.dispatch(
      new TurnSteer({
        agentId: MAIN_AGENT_ID,
        input: [{ type: 'text', text: 'second steer' }],
        origin: { kind: 'user', inTurn: true },
      }),
    );
    await dispatcher.dispatch(
      new ContextAppendMessage({
        agentId: MAIN_AGENT_ID,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'second steer' }],
          toolCalls: [],
          origin: { kind: 'user', inTurn: true },
        },
      }),
    );
    await dispatcher.dispatch(
      new ContextAppendMessage({
        agentId: MAIN_AGENT_ID,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer after second steer' }],
          toolCalls: [],
        },
      }),
    );
    await dispatcher.dispatch(
      new TurnEnded({ agentId: MAIN_AGENT_ID, turnId: 0, reason: 'completed' }),
    );
    await agent.accessor.get(IWireService).flush();
    const path = `/api/v1/sessions/${id}/agents/main/turns`;
    const before = await getJson<ConversationTurnsPage>(path);
    expect(before.body.code).toBe(0);
    const [turn] = before.body.data.turns;
    expect(before.body.data.turns).toHaveLength(1);
    expect(
      turn!.items.filter((item) => item.type === 'user_message').map((item) => item.placement),
    ).toEqual(['opener', 'steer', 'steer']);

    expect((await postJson<null>(`/api/v1/sessions/${id}:undo`, {})).body.code).toBe(40001);
    expect(
      (await postJson<null>(`/api/v1/sessions/${id}:undo`, { turn_id: 't_missing' })).body.code,
    ).toBe(40422);
    const undone = await postJson<{ removed_turn_ids: string[] }>(`/api/v1/sessions/${id}:undo`, {
      turn_id: turn!.turn_id,
    });
    expect(undone.body).toMatchObject({ code: 0, data: { removed_turn_ids: [turn!.turn_id] } });
    expect((await getJson<ConversationTurnsPage>(path)).body.data.turns).toEqual([]);
  });

  it('serves tool task links after closing and restoring the session', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home } });
    const id = created.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, id)!;
    await session.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const dispatcher = agent.accessor.get(IEventDispatcher);
    await dispatcher.dispatch(
      new TurnPrompt({
        agentId: MAIN_AGENT_ID,
        input: [{ type: 'text', text: 'run' }],
        origin: { kind: 'user' },
        turnId: 0,
      }),
    );
    for (const message of [
      {
        role: 'user',
        id: 'task-prompt',
        origin: { kind: 'user' },
        content: [{ type: 'text', text: 'run' }],
        toolCalls: [],
      },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'task-call', name: 'Bash', arguments: '{}' }],
      },
    ] satisfies ContextMessage[]) {
      await dispatcher.dispatch(new ContextAppendMessage({ agentId: MAIN_AGENT_ID, message }));
    }
    await dispatcher.dispatch(
      new TaskStarted({
        agentId: MAIN_AGENT_ID,
        info: {
          kind: 'process',
          taskId: 'bash-linked',
          parentToolCallId: 'task-call',
          description: 'done',
          command: 'bun test',
          pid: 0,
          exitCode: 0,
          status: 'completed',
          startedAt: 1,
          endedAt: 2,
        },
      }),
    );
    await dispatcher.dispatch(
      new ContextAppendMessage({
        agentId: MAIN_AGENT_ID,
        message: {
          role: 'tool',
          content: [{ type: 'text', text: 'done' }],
          toolCalls: [],
          toolCallId: 'task-call',
        },
      }),
    );
    await dispatcher.dispatch(
      new TurnEnded({ agentId: MAIN_AGENT_ID, turnId: 0, reason: 'completed' }),
    );
    await agent.accessor.get(IWireService).flush();
    const path = `/api/v1/sessions/${id}/agents/main/turns`;
    const live = await getJson<ConversationTurnsPage>(path);
    expect(live.body.code).toBe(0);
    expect(live.body.data.turns.flatMap((turn) => turn.items)).toContainEqual(
      expect.objectContaining({ item_id: 'task-call', task_id: 'bash-linked' }),
    );
    await closeSessionById((server as RunningServer).core.accessor, id);
    const restored = await getJson<ConversationTurnsPage>(path);
    expect(restored.body.code).toBe(0);
    expect(restored.body.data.turns.flatMap((turn) => turn.items)).toContainEqual(
      expect.objectContaining({ item_id: 'task-call', task_id: 'bash-linked' }),
    );
  });

  it('undoes a turn only once when two requests race for it', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home } });
    const id = created.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, id)!;
    await session.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const agent = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const dispatcher = agent.accessor.get(IEventDispatcher);
    for (let turnId = 0; turnId < 3; turnId++) {
      await dispatcher.dispatch(
        new TurnPrompt({
          agentId: MAIN_AGENT_ID,
          input: [{ type: 'text', text: `prompt ${turnId}` }],
          origin: { kind: 'user' },
          turnId,
        }),
      );
      await dispatcher.dispatch(
        new ContextAppendMessage({
          agentId: MAIN_AGENT_ID,
          message: {
            role: 'user',
            content: [{ type: 'text', text: `prompt ${turnId}` }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        }),
      );
      await dispatcher.dispatch(
        new ContextAppendMessage({
          agentId: MAIN_AGENT_ID,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `answer ${turnId}` }],
            toolCalls: [],
          },
        }),
      );
      await dispatcher.dispatch(
        new TurnEnded({ agentId: MAIN_AGENT_ID, turnId, reason: 'completed' }),
      );
    }
    await agent.accessor.get(IWireService).flush();
    const path = `/api/v1/sessions/${id}/agents/main/turns`;
    const turnIds = (await getJson<ConversationTurnsPage>(path)).body.data.turns.map(
      (turn) => turn.turn_id,
    );
    expect(turnIds).toHaveLength(3);

    const results = await Promise.all([
      postJson<{ removed_turn_ids: string[] }>(`/api/v1/sessions/${id}:undo`, {
        turn_id: turnIds[2],
      }),
      postJson<{ removed_turn_ids: string[] }>(`/api/v1/sessions/${id}:undo`, {
        turn_id: turnIds[2],
      }),
    ]);

    expect(results.map((result) => result.body.code).toSorted()).toEqual([0, 40422]);
    expect(
      (await getJson<ConversationTurnsPage>(path)).body.data.turns.map((turn) => turn.turn_id),
    ).toEqual(turnIds.slice(0, 2));
  });

  it('forks an undo-branched wire self-contained and replays it equivalently', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
    expect(session).toBeDefined();
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const agent = session!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const context = agent.accessor.get(IAgentContextMemoryService);
    const user = (text: string): ContextMessage => ({
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    const assistant = (text: string): ContextMessage => ({
      role: 'assistant',
      content: [{ type: 'text', text }],
      toolCalls: [],
    });
    context.append(user('first prompt'), assistant('first answer'));
    context.append(user('second prompt'), assistant('second answer'));
    await agent.accessor.get(IAgentConversationUndoService).undo(1);
    await agent.accessor.get(IWireService).flush();
    const messageText = (messages: readonly ContextMessage[]) =>
      messages.map((message) =>
        message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      );
    const sourceText = messageText(context.get());
    expect(sourceText).toEqual(['first prompt', 'first answer']);

    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
    expect(forked.body.code).toBe(0);
    const forkedId = forked.body.data.id;

    const wireFiles = (await readdir(home as string, { recursive: true })).filter(
      (path) =>
        path.endsWith(join('agents', 'main', 'wire.jsonl')) &&
        (path.includes(parentId) || path.includes(forkedId)),
    );
    const sourceLines = (
      await readFile(
        join(
          home as string,
          wireFiles.find((path) => path.includes(parentId))!,
        ),
        'utf8',
      )
    )
      .trimEnd()
      .split('\n');
    const forkedLines = (
      await readFile(
        join(
          home as string,
          wireFiles.find((path) => path.includes(forkedId))!,
        ),
        'utf8',
      )
    )
      .trimEnd()
      .split('\n');
    const recordType = (line: string) => (JSON.parse(line) as { type: string }).type;
    expect(forkedLines.some((line) => recordType(line) === 'agent.switched')).toBe(true);
    expect(forkedLines.some((line) => line.includes('second prompt'))).toBe(true);
    expect(forkedLines.slice(0, sourceLines.length)).toEqual(sourceLines);
    expect(recordType(forkedLines.at(-1)!)).toBe('forked');

    const resumed = await resumeSessionById((server as RunningServer).core.accessor, forkedId);
    expect(resumed).toBeDefined();
    const forkedContext = resumed!.accessor
      .get(IAgentLifecycleService)
      .handleOf(MAIN_AGENT_ID)!
      .accessor.get(IAgentContextMemoryService);
    expect(messageText(forkedContext.get())).toEqual(sourceText);
  });

  it('continues a paginated attachment read after forking and removing the source file', async () => {
    const parent = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const parentId = parent.body.data.id;
    const core = (server as RunningServer).core;
    const session = getLiveSessionById(core.accessor, parentId)!;
    const body =
      '😀'.repeat(600) +
      '\n' +
      Array.from({ length: 30 }, (_, i) => `line ${String(i)} é`).join('\n');
    const output = await mcpResultToExecutableOutput(
      {
        isError: false,
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'example://report',
              mimeType: 'text/plain',
              blob: Buffer.from(body).toString('base64'),
            },
          },
        ],
      },
      'mcp__example__report',
      { attachmentStore: session.accessor.get(ISessionMediaStore) },
    );
    const text = renderToolResultForModel(output)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
    const sourcePath = JSON.parse(
      /Original attachment saved at: ("[^\n]+")/.exec(text)![1]!,
    ) as string;
    const reference = JSON.parse(/Attachment reference: ("[^\n]+")/.exec(text)![1]!) as string;
    const sourceAgents = session.accessor.get(IAgentLifecycleService);
    await sourceAgents.create({ agentId: MAIN_AGENT_ID });
    let reader = sourceAgents.handleOf(MAIN_AGENT_ID)!.accessor.get(IReadTool);
    let args: ReadInput | undefined = { path: reference, max_chars: 1000 };
    const firstExecution = await reader.resolveExecution(args);
    if (firstExecution.isError === true) throw new Error(JSON.stringify(firstExecution.output));
    const first = await firstExecution.execute({
      turnId: 1,
      toolCallId: 'read-first',
      signal: new AbortController().signal,
    });
    expect(first.isError).not.toBe(true);
    let recovered = (first.output as string).replaceAll(/^\d+\t/gm, '');
    const firstNext = /Next Read: (\{[^\n]*\})/.exec(first.note ?? '')?.[1];
    expect(firstNext).toBeDefined();
    args = ReadInputSchema.parse(JSON.parse(firstNext!));
    expect(args.path).toBe(reference);
    expect(args.column_offset).toBeGreaterThan(0);
    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
    expect(forked.body.code).toBe(0);
    await rm(sourcePath);
    const resumed = await resumeSessionById(core.accessor, forked.body.data.id);
    const agents = resumed!.accessor.get(IAgentLifecycleService);
    await agents.create({ agentId: MAIN_AGENT_ID });
    reader = agents.handleOf(MAIN_AGENT_ID)!.accessor.get(IReadTool);
    let pages = 0;
    while (args !== undefined && pages < 80) {
      expect(args.path).toBe(reference);
      const execution = await reader.resolveExecution(args);
      if (execution.isError === true) throw new Error(JSON.stringify(execution.output));
      const read = await execution.execute({
        turnId: 1,
        toolCallId: `read-${String(pages++)}`,
        signal: new AbortController().signal,
      });
      expect(read.isError).not.toBe(true);
      if ((args.column_offset ?? 0) === 0) recovered += '\n';
      recovered += (read.output as string).replaceAll(/^\d+\t/gm, '');
      const next = /Next Read: (\{[^\n]*\})/.exec(read.note ?? '')?.[1];
      args = next === undefined ? undefined : ReadInputSchema.parse(JSON.parse(next));
    }
    expect(args).toBeUndefined();
    expect(recovered).toBe(body);
  });

  it('fork copies a corrupted source wire without healing it; the fork heals on resume', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
    expect(session).toBeDefined();
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const cron = session!.accessor
      .get(IAgentLifecycleService)
      .handleOf(MAIN_AGENT_ID)!
      .accessor.get(IAgentCronService);
    const task = cron.addTask({
      cron: '0 9 * * *',
      prompt: 'survives corruption',
      recurring: true,
    });
    await closeSessionById((server as RunningServer).core.accessor, parentId);

    const wireRelatives = (await readdir(home as string, { recursive: true })).filter((path) =>
      path.endsWith(join(parentId, 'agents', 'main', 'wire.jsonl')),
    );
    expect(wireRelatives).toHaveLength(1);
    const wirePath = join(home as string, wireRelatives[0]!);
    const originalLines = (await readFile(wirePath, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0);
    expect(originalLines.length).toBeGreaterThan(1);
    const corrupted = `${[...originalLines, 'GARBAGE'].join('\n')}\n`;
    await writeFile(wirePath, corrupted);

    const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
    expect(forked.body.code).toBe(0);
    const forkedId = forked.body.data.id;

    expect(await readFile(wirePath, 'utf8')).toBe(corrupted);

    const resumed = await resumeSessionById((server as RunningServer).core.accessor, forkedId);
    expect(resumed).toBeDefined();
    const forkedCron = resumed!.accessor
      .get(IAgentLifecycleService)
      .handleOf(MAIN_AGENT_ID)!
      .accessor.get(IAgentCronService);
    expect(forkedCron.list().map((t) => ({ id: t.id, prompt: t.prompt }))).toEqual([
      { id: task.id, prompt: 'survives corruption' },
    ]);
  });

  it(
    'cold-forks a session with hundreds of agents without materializing it',
    { timeout: 30_000 },
    async () => {
      const cwd = home as string;
      const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      const parentId = parent.body.data.id;
      const parentWire = parent.body.data;
      await closeSessionById((server as RunningServer).core.accessor, parentId);

      const sessionDir = join(home as string, 'sessions', parentWire.workspace_id, parentId);
      const statePath = join(sessionDir, 'state.json');
      const state = JSON.parse(await readFile(statePath, 'utf8'));

      const subagentCount = 300;
      const metadataLine = JSON.stringify({
        type: 'metadata',
        protocol_version: '1.5',
        created_at: 1,
      });
      const recordLine = (n: number) =>
        JSON.stringify({
          type: 'context.append_message',
          message: {
            role: 'user',
            content: [{ type: 'text', text: `hello ${n}` }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
          time: n,
        });
      const planRevisionLine = JSON.stringify({
        type: 'plan.revision',
        id: 'plan-1',
        version: 2,
        key: 'plan/plan-1/v2.md',
        sha256: 'deadbeef',
        bytes: 128,
        time: 5,
      });

      const agents: Record<
        string,
        {
          homedir: string;
          type: string;
          parentAgentId: string | null;
          labels: Record<string, string>;
        }
      > = {
        main: {
          homedir: join(sessionDir, 'agents', 'main'),
          type: 'main',
          parentAgentId: null,
          labels: { kind: 'main' },
        },
      };
      await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
      await writeFile(
        join(sessionDir, 'agents', 'main', 'wire.jsonl'),
        `${metadataLine}\n${recordLine(2)}\n${planRevisionLine}\n`,
      );
      for (let i = 0; i < subagentCount; i++) {
        const agentId = `agent-${i}`;
        agents[agentId] = {
          homedir: join(sessionDir, 'agents', agentId),
          type: 'sub',
          parentAgentId: 'main',
          labels: { swarm: 'test' },
        };
        const agentDir = join(sessionDir, 'agents', agentId);
        await mkdir(agentDir, { recursive: true });
        if (i === 0) continue;
        await writeFile(
          join(agentDir, 'wire.jsonl'),
          `${metadataLine}\n${recordLine(i)}\n${recordLine(i + 1000)}\n`,
        );
      }
      state.agents = agents;
      state.custom = { origin: 'large-test' };
      await writeFile(statePath, JSON.stringify(state));

      const startedAt = Date.now();
      const forked = await postJson<SessionWire>(`/api/v1/sessions/${parentId}:fork`, {});
      const elapsedMs = Date.now() - startedAt;
      expect(forked.body.code).toBe(0);
      const forkedId = forked.body.data.id;
      process.stdout.write(
        `fork of ${subagentCount + 1}-agent session completed in ${elapsedMs}ms\n`,
      );

      expect(getLiveSessionById((server as RunningServer).core.accessor, forkedId)).toBeUndefined();

      const forkedDir = join(home as string, 'sessions', parentWire.workspace_id, forkedId);
      const forkedState = JSON.parse(await readFile(join(forkedDir, 'state.json'), 'utf8'));
      expect(forkedState.title).toBe(`Fork: ${parentWire.title || parentId}`);
      expect(forkedState.titleKind).toBeUndefined();
      expect(forkedState.forkedFrom).toBe(parentId);
      expect(forkedState.custom).toEqual({ origin: 'large-test' });
      expect(Object.keys(forkedState.agents)).toHaveLength(subagentCount + 1);
      for (const agentId of ['main', 'agent-0', 'agent-150', `agent-${subagentCount - 1}`]) {
        const entry = forkedState.agents[agentId];
        const source = agents[agentId]!;
        expect(entry.homedir.split(sep).join('/')).toBe(
          join(forkedDir, 'agents', agentId).split(sep).join('/'),
        );
        expect(entry.type).toBe(source.type);
        expect(entry.parentAgentId ?? null).toBe(source.parentAgentId);
        expect(entry.labels).toEqual(
          agentId === 'main' ? source.labels : { ...source.labels, parentAgentId: 'main' },
        );
      }

      const mainWire = (await readFile(join(forkedDir, 'agents', 'main', 'wire.jsonl'), 'utf8'))
        .trim()
        .split('\n');
      expect(mainWire.map((line) => JSON.parse(line).type)).toEqual([
        'metadata',
        'context.append_message',
        'plan.revision',
        'forked',
      ]);
      expect(JSON.parse(mainWire[2]!)).toMatchObject({ key: 'plan/plan-1/v2.md' });

      const emptyWire = (await readFile(join(forkedDir, 'agents', 'agent-0', 'wire.jsonl'), 'utf8'))
        .trim()
        .split('\n');
      expect(emptyWire.map((line) => JSON.parse(line).type)).toEqual(['metadata', 'forked']);

      const sampledWire = (
        await readFile(join(forkedDir, 'agents', 'agent-150', 'wire.jsonl'), 'utf8')
      )
        .trim()
        .split('\n');
      expect(sampledWire.map((line) => JSON.parse(line).type)).toEqual([
        'metadata',
        'context.append_message',
        'context.append_message',
        'forked',
      ]);

      const listed = await getJson<SessionWire>(`/api/v1/sessions/${forkedId}`);
      expect(listed.body.code).toBe(0);

      const transcript = await getJson<{
        items: { kind: string; marker?: string; payload?: { path?: string } }[];
      }>(`/api/v1/sessions/${forkedId}/transcript?agent_id=main`);
      expect(transcript.body.code).toBe(0);
      const revisionMarker = transcript.body.data.items.find(
        (item) => item.kind === 'marker' && item.marker === 'plan.revision',
      );
      expect(revisionMarker?.payload?.path).toContain(forkedId);

      const resumed = await resumeSessionById((server as RunningServer).core.accessor, forkedId);
      expect(resumed).toBeDefined();
      expect(resumed!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)).toBeDefined();
    },
  );

  it('keeps cron tasks across a server restart through the wire', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, parentId);
    expect(session).toBeDefined();
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const task = session!.accessor
      .get(IAgentLifecycleService)
      .handleOf(MAIN_AGENT_ID)!
      .accessor.get(IAgentCronService)
      .addTask({ cron: '0 9 * * *', prompt: 'restart me', recurring: true });

    await (server as RunningServer).close();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;

    const resumed = await (server as RunningServer).core.accessor
      .get(ISessionManager)
      .resume(parentId);
    expect(resumed).toBeDefined();
    const resumedManager = resumed!.accessor.get(IAgentLifecycleService);
    const cron = resumedManager.handleOf(MAIN_AGENT_ID)!.accessor.get(IAgentCronService);
    expect(cron.list().map((t) => ({ id: t.id, prompt: t.prompt }))).toEqual([
      { id: task.id, prompt: 'restart me' },
    ]);
  });

  it('migrates a legacy ACP binding to local and keeps file tools working across restarts', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const sessionId = created.body.data.id;
    const session = getLiveSessionById((server as RunningServer).core.accessor, sessionId);
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const main = session!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    await main.accessor.get(IEventDispatcher).dispatch(
      new EnvironmentSetBinding({
        agentId: MAIN_AGENT_ID,
        environmentId: `acp:${sessionId}`,
        cwd,
      }),
    );
    const filePath = join(cwd, 'legacy-acp.txt');
    await writeFile(filePath, 'legacy ACP read');

    await (server as RunningServer).close();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;

    const resumed = await resumeSessionById((server as RunningServer).core.accessor, sessionId);
    const resumedMain = resumed!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    const execution = await resumedMain.accessor
      .get(IReadTool)
      .resolveExecution({ path: filePath });
    expect(execution.isError, JSON.stringify(execution)).not.toBe(true);
    if (execution.isError) return;
    const read = await execution.execute({
      turnId: 1,
      toolCallId: 'read-legacy-acp',
      signal: new AbortController().signal,
    });
    expect(read.isError).not.toBe(true);
    expect(read.output).toContain('legacy ACP read');
    expect(resumedMain.accessor.get(IAgentEnvironmentBindingService).current).toEqual({
      environmentId: 'local',
      cwd,
    });

    await (server as RunningServer).close();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
    const resumedAgain = await resumeSessionById(
      (server as RunningServer).core.accessor,
      sessionId,
    );
    const binding = resumedAgain!.accessor
      .get(IAgentLifecycleService)
      .handleOf(MAIN_AGENT_ID)!
      .accessor.get(IAgentEnvironmentBindingService).current;
    expect(binding).toEqual({ environmentId: 'local', cwd });
  });

  it('keeps a legacy ACP binding when its environment is still registered', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const sessionId = created.body.data.id;
    const environmentId = `acp:${sessionId}`;
    const session = getLiveSessionById((server as RunningServer).core.accessor, sessionId);
    await session!.accessor.get(IAgentLifecycleService).create({ agentId: MAIN_AGENT_ID });
    const main = session!.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID)!;
    await main.accessor.get(IEventDispatcher).dispatch(
      new EnvironmentSetBinding({
        agentId: MAIN_AGENT_ID,
        environmentId,
        cwd,
      }),
    );
    await closeSessionById((server as RunningServer).core.accessor, sessionId);
    const environment = new FakeEnvironment(
      { environmentId, generation: 'legacy-acp-generation' },
      { capabilities: [] },
    );
    const registration = (server as RunningServer).core.accessor
      .get(IEnvironmentService)
      .register(environment);
    try {
      const resumed = await resumeSessionById((server as RunningServer).core.accessor, sessionId);
      const binding = resumed!.accessor
        .get(IAgentLifecycleService)
        .handleOf(MAIN_AGENT_ID)!
        .accessor.get(IAgentEnvironmentBindingService).current;
      expect(binding).toEqual({ environmentId, cwd });
    } finally {
      await registration.remove();
      await closeSessionById((server as RunningServer).core.accessor, sessionId);
    }
  });

  it('returns 40401 when listing children of a missing parent', async () => {
    const { body } = await getJson<null>('/api/v1/sessions/sess_missing_parent/children');
    expect(body.code).toBe(40401);
  });

  it('returns 40401 when creating a child for a missing parent', async () => {
    const { body } = await postJson<null>('/api/v1/sessions/sess_missing_parent/children', {});
    expect(body.code).toBe(40401);
  });

  it('returns an empty warnings list for an existing session', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const { status, body } = await getJson<{ warnings: unknown[] }>(
      `/api/v1/sessions/${created.body.data.id}/warnings`,
    );
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data).toEqual({ warnings: [] });
    expect(sessionWarningsResponseSchema.parse(body.data)).toEqual({ warnings: [] });
  });

  it('returns 40401 for warnings of a missing session', async () => {
    const { body } = await getJson<null>('/api/v1/sessions/sess_missing_warnings/warnings');
    expect(body.code).toBe(40401);
  });

  it('lists only archived sessions with archived_only', async () => {
    const cwd = home as string;
    const a = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const b = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    expect(a.body.code).toBe(0);
    expect(b.body.code).toBe(0);
    const archivedId = a.body.data.id;
    const liveId = b.body.data.id;

    const archived = await postJson<{ archived: boolean }>(
      `/api/v1/sessions/${archivedId}:archive`,
    );
    expect(archived.body.code).toBe(0);

    const normal = await getJson<PageWire>('/api/v1/sessions');
    expect(normal.body.data.items.some((s) => s.id === liveId)).toBe(true);
    expect(normal.body.data.items.some((s) => s.id === archivedId)).toBe(false);

    const onlyArchived = await getJson<PageWire>('/api/v1/sessions?archived_only=true');
    expect(onlyArchived.body.code).toBe(0);
    expect(onlyArchived.body.data.items.some((s) => s.id === archivedId)).toBe(true);
    expect(onlyArchived.body.data.items.some((s) => s.id === liveId)).toBe(false);

    const all = await getJson<PageWire>('/api/v1/sessions?include_archive=true');
    expect(all.body.data.items.some((s) => s.id === liveId)).toBe(true);
    expect(all.body.data.items.some((s) => s.id === archivedId)).toBe(true);
  });

  it('paginates archived_only without returning empty filtered pages', async () => {
    await restartWithFreshHome();
    const cwd = home as string;
    const archivedOlder = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<{ archived: boolean }>(`/api/v1/sessions/${archivedOlder.body.data.id}:archive`);

    const archivedNewer = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<{ archived: boolean }>(`/api/v1/sessions/${archivedNewer.body.data.id}:archive`);

    await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    const first = await getJson<PageWire>('/api/v1/sessions?archived_only=true&page_size=1');
    expect(first.body.code).toBe(0);
    expect(first.body.data.items).toHaveLength(1);
    expect(first.body.data.items[0]).toMatchObject({
      id: archivedNewer.body.data.id,
      archived: true,
    });
    expect(first.body.data.has_more).toBe(true);

    const second = await getJson<PageWire>(
      `/api/v1/sessions?archived_only=true&page_size=1&before_id=${archivedNewer.body.data.id}`,
    );
    expect(second.body.code).toBe(0);
    expect(second.body.data.items).toHaveLength(1);
    expect(second.body.data.items[0]).toMatchObject({
      id: archivedOlder.body.data.id,
      archived: true,
    });
    expect(second.body.data.has_more).toBe(false);
  });

  it('keeps the after_id lower bound while a filtered drain pages for more candidates', async () => {
    const cwd = home as string;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const archivedOlder = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<{ archived: boolean }>(`/api/v1/sessions/${archivedOlder.body.data.id}:archive`);
    await sleep(5);
    for (let i = 0; i < 3; i++) {
      const { body } = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
      expect(body.code).toBe(0);
      await sleep(5);
    }
    const archivedNewer = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<{ archived: boolean }>(`/api/v1/sessions/${archivedNewer.body.data.id}:archive`);

    const page = await getJson<PageWire>(
      `/api/v1/sessions?archived_only=true&page_size=2&after_id=${archivedOlder.body.data.id}`,
    );
    expect(page.body.code).toBe(0);
    expect(page.body.data.items.map((s) => s.id)).toEqual([archivedNewer.body.data.id]);
    expect(page.body.data.has_more).toBe(false);
  });

  it('rejects archived_only combined with include_archive (40001)', async () => {
    const { body } = await getJson<null>(
      '/api/v1/sessions?archived_only=true&include_archive=true',
    );
    expect(body.code).toBe(40001);
  });

  it('returns a terminal empty page when archived_only busy filtering finds no match', async () => {
    const cwd = home as string;
    const first = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const second = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });

    await postJson<{ archived: boolean }>(`/api/v1/sessions/${first.body.data.id}:archive`);
    await postJson<{ archived: boolean }>(`/api/v1/sessions/${second.body.data.id}:archive`);

    const page = await getJson<PageWire>(
      '/api/v1/sessions?archived_only=true&busy=true&page_size=1',
    );
    expect(page.body.code).toBe(0);
    expect(page.body.data).toEqual({ items: [], has_more: false });
  });

  it('rejects a malformed workspace_id when listing (40001)', async () => {
    const { body } = await getJson<null>('/api/v1/sessions?workspace_id=not-a-workspace-id');
    expect(body.code).toBe(40001);
  });

  it('returns 40410 for an unknown workspace_id when listing', async () => {
    const { body } = await getJson<null>('/api/v1/sessions?workspace_id=wd_missing_000000000000');
    expect(body.code).toBe(40410);
  });

  it('lists the union of legacy split buckets for one workspace, in recency order', async () => {
    await restartWithFreshHome();
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const lowerRoot = 'c:\\users\\foo\\proj';
    const typedId = encodeWorkDirKey(typedRoot);
    const lowerId = encodeWorkDirKey(lowerRoot);
    await writeFile(
      join(home as string, 'workspaces.json'),
      JSON.stringify({
        version: 1,
        workspaces: {
          [typedId]: {
            root: typedRoot,
            name: 'proj',
            created_at: '2024-01-01T00:00:00.000Z',
            last_opened_at: '2024-01-01T00:00:00.000Z',
          },
          [lowerId]: {
            root: lowerRoot,
            name: 'proj',
            created_at: '2024-01-01T00:00:00.000Z',
            last_opened_at: '2024-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );
    const seedBucket = async (wsId: string, sid: string, updatedAt: number): Promise<void> => {
      const dir = join(home as string, 'sessions', wsId, sid);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'state.json'),
        JSON.stringify({ version: 2, cwd: typedRoot, createdAt: 1, updatedAt }),
        'utf8',
      );
    };
    await seedBucket(typedId, 's-typed', 50);
    await seedBucket(lowerId, 's-lower', 60);

    const workspaces = await getJson<{ items: { id: string }[] }>('/api/v1/workspaces');
    const rep = workspaces.body.data.items[0]?.id as string;
    expect([typedId, lowerId]).toContain(rep);

    const listed = await getJson<PageWire>(
      `/api/v1/sessions?workspace_id=${encodeURIComponent(rep)}`,
    );
    expect(listed.body.code).toBe(0);
    expect(listed.body.data.items.map((s) => s.id)).toEqual(['s-lower', 's-typed']);

    const page1 = await getJson<PageWire>(
      `/api/v1/sessions?workspace_id=${encodeURIComponent(rep)}&page_size=1`,
    );
    expect(page1.body.data.items.map((s) => s.id)).toEqual(['s-lower']);
    expect(page1.body.data.has_more).toBe(true);
    const page2 = await getJson<PageWire>(
      `/api/v1/sessions?workspace_id=${encodeURIComponent(rep)}&page_size=1&before_id=s-lower`,
    );
    expect(page2.body.data.items.map((s) => s.id)).toEqual(['s-typed']);
    expect(page2.body.data.has_more).toBe(false);
  });

  it('filters listed sessions by the busy query (post-page, like v1)', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    expect(created.body.data.busy).toBe(false);

    const idle = await getJson<PageWire>('/api/v1/sessions?busy=false');
    expect(idle.body.code).toBe(0);
    expect(idle.body.data.items.some((s) => s.id === id)).toBe(true);

    const running = await getJson<PageWire>('/api/v1/sessions?busy=true');
    expect(running.body.code).toBe(0);
    expect(running.body.data.items.some((s) => s.id === id)).toBe(false);
  });

  it('finds a busy session behind newer idle ones when paging by the busy query', async () => {
    const cwd = home as string;
    const busy = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const session = getLiveSessionById((server as RunningServer).core.accessor, busy.body.data.id);
    if (session === undefined) throw new Error('expected live session');
    const activity = session.accessor.get(ISessionActivityView);
    const state = spyOn(activity, 'state').mockReturnValue({ ...activity.state(), busy: true });

    try {
      const page = await getJson<PageWire>(
        '/api/v1/sessions?busy=true&page_size=1&include_archive=true',
      );
      expect(page.body.code).toBe(0);
      expect(page.body.data.items.map((item) => item.id)).toEqual([busy.body.data.id]);
      expect(page.body.data.has_more).toBe(false);
    } finally {
      state.mockRestore();
    }
  });

  it('filters child sessions by the busy query', async () => {
    const cwd = home as string;
    const parent = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const parentId = parent.body.data.id;
    const child = await postJson<SessionWire>(`/api/v1/sessions/${parentId}/children`, {});
    const childId = child.body.data.id;
    expect(child.body.data.busy).toBe(false);

    const idle = await getJson<PageWire>(`/api/v1/sessions/${parentId}/children?busy=false`);
    expect(idle.body.code).toBe(0);
    expect(idle.body.data.items.some((s) => s.id === childId)).toBe(true);

    const running = await getJson<PageWire>(`/api/v1/sessions/${parentId}/children?busy=true`);
    expect(running.body.code).toBe(0);
    expect(running.body.data.items.some((s) => s.id === childId)).toBe(false);
  });

  it('hides a session from lists after its workspace is unregistered while keeping it gettable (gap G3)', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', {
      title: 'g3',
      metadata: { cwd },
    });
    expect(created.body.code).toBe(0);
    const id = created.body.data.id;
    const workspaceId = created.body.data.workspace_id;

    const del = await deleteJson<{ deleted: boolean }>(`/api/v1/workspaces/${workspaceId}`);
    expect(del.body.code).toBe(0);

    const listed = await getJson<PageWire>('/api/v1/sessions');
    expect(listed.body.code).toBe(0);
    expect(listed.body.data.items.some((session) => session.id === id)).toBe(false);

    const paged = await getJson<PageWire>('/api/v1/sessions?page_size=100');
    expect(paged.body.code).toBe(0);
    expect(paged.body.data.items.some((session) => session.id === id)).toBe(false);

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.metadata.cwd).toBe(cwd);

    const profile = await getJson<SessionWire>(`/api/v1/sessions/${id}/profile`);
    expect(profile.body.code).toBe(0);
    expect(profile.body.data.metadata.cwd).toBe(cwd);
  });

  it('does not page a deleted workspace session into an active project', async () => {
    await restartWithFreshHome();
    const cwd = home as string;
    const activeWorkspace = await postJson<{ id: string }>('/api/v1/workspaces', {
      root: cwd,
      name: 'active',
    });
    const active = await postJson<SessionWire>('/api/v1/sessions', {
      workspace_id: activeWorkspace.body.data.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const removedRoot = join(cwd, 'removed-root');
    await mkdir(removedRoot, { recursive: true });
    const removedWorkspace = await postJson<{ id: string }>('/api/v1/workspaces', {
      root: removedRoot,
      name: 'removed',
    });
    const removed = await postJson<SessionWire>('/api/v1/sessions', {
      workspace_id: removedWorkspace.body.data.id,
    });

    const del = await deleteJson<{ deleted: boolean }>(
      `/api/v1/workspaces/${removedWorkspace.body.data.id}`,
    );
    expect(del.body.code).toBe(0);

    const page = await getJson<PageWire>('/api/v1/sessions?page_size=1');
    expect(page.body.code).toBe(0);
    expect(page.body.data.items.map((session) => session.id)).toEqual([active.body.data.id]);
    expect(page.body.data.has_more).toBe(false);

    const got = await getJson<SessionWire>(`/api/v1/sessions/${removed.body.data.id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.metadata.cwd).toBe(removedRoot);
  });

  it('merges metadata via profile and keeps cwd authoritative', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const first = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      metadata: { foo: 'bar' },
    });
    expect(first.body.code).toBe(0);
    expect(first.body.data.metadata['foo']).toBe('bar');
    expect(first.body.data.metadata.cwd).toBe(cwd);

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.data.metadata['foo']).toBe('bar');
    expect(got.body.data.metadata.cwd).toBe(cwd);
  });

  it('merges custom metadata on a second profile update', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, { metadata: { foo: 'bar' } });
    const second = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      metadata: { baz: 1 },
    });
    expect(second.body.code).toBe(0);
    expect(second.body.data.metadata['foo']).toBe('bar');
    expect(second.body.data.metadata['baz']).toBe(1);
    expect(second.body.data.metadata.cwd).toBe(cwd);
  });

  it('applies agent_config.permission_mode via profile idempotently', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const first = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { permission_mode: 'yolo' },
    });
    expect(first.body.code).toBe(0);

    const again = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { permission_mode: 'yolo' },
    });
    expect(again.body.code).toBe(0);
  });

  it('guards agent_config.plan_mode so a repeated true does not re-enter', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const first = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { plan_mode: true },
    });
    expect(first.body.code).toBe(0);

    const again = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { plan_mode: true },
    });
    expect(again.body.code).toBe(0);
  });

  it('maps goal already_exists from agent_config.goal_objective (40913)', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const first = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'ship the feature' },
    });
    expect(first.body.code).toBe(0);

    const dup = await postJson<null>(`/api/v1/sessions/${id}/profile`, {
      agent_config: { goal_objective: 'ship the feature' },
    });
    expect(dup.body.code).toBe(40913);
  });

  it('publishes session.meta.updated on the core bus when renaming via profile', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;

    const events: { type: string; payload: unknown }[] = [];
    const sub = (server as RunningServer).core.accessor
      .get(IEventService)
      .subscribe((event) => events.push(event as unknown as { type: string; payload: unknown }));

    const updated = await postJson<SessionWire>(`/api/v1/sessions/${id}/profile`, {
      title: 'renamed-via-profile',
    });
    expect(updated.body.code).toBe(0);
    sub.dispose();

    const meta = events.find((e) => e.type === 'session.meta.updated');
    expect(meta).toBeDefined();
    expect((meta?.payload as { title?: string } | undefined)?.title).toBe('renamed-via-profile');
  });

  it('returns 40401 when updating the profile of a missing session', async () => {
    const { body } = await postJson<null>('/api/v1/sessions/sess_missing_profile/profile', {
      title: 'nope',
    });
    expect(body.code).toBe(40401);
  });

  it('derives the session title from the first prompt submitted via /api/v1', async () => {
    await restartWithFreshHome();
    const cwd = home as string;
    await writeFile(
      join(cwd, 'config.toml'),
      [
        'default_model = "stub"',
        '',
        '[providers.stub]',
        'type = "openai"',
        'base_url = "http://127.0.0.1:9999"',
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
      'utf-8',
    );
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const id = created.body.data.id;
    expect(created.body.data.title).toBe('');

    const events: { type: string; payload: unknown }[] = [];
    const sub = (server as RunningServer).core.accessor
      .get(IEventService)
      .subscribe((event) => events.push(event as unknown as { type: string; payload: unknown }));

    const submitted = await postJson<{ prompt_id: string; status: string }>(
      `/api/v1/sessions/${id}/prompts`,
      { content: [{ type: 'text', text: 'hello web title' }] },
    );
    expect(submitted.body.code).toBe(0);
    sub.dispose();

    const got = await getJson<SessionWire>(`/api/v1/sessions/${id}`);
    expect(got.body.code).toBe(0);
    expect(got.body.data.title).toBe('hello web title');

    const meta = events.find((e) => e.type === 'session.meta.updated');
    expect(meta).toBeDefined();
    expect((meta?.payload as { title?: string } | undefined)?.title).toBe('hello web title');
  });
});

async function listExportTempDirs(sessionId: string): Promise<string[]> {
  const prefix = `kimi-session-export-${sessionId}-`;
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith(prefix)).toSorted();
}

function readZipEntries(archive: Buffer): Map<string, Buffer> {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = archive.lastIndexOf(endSignature);
  if (endOffset < 0) throw new Error('ZIP end record not found');

  const entryCount = archive.readUInt16LE(endOffset + 10);
  let centralOffset = archive.readUInt32LE(endOffset + 16);
  const entries = new Map<string, Buffer>();

  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory entry');
    }
    const method = archive.readUInt16LE(centralOffset + 10);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const name = archive
      .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
      .toString('utf8');

    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('Invalid ZIP local entry');
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(compressed));
    else if (method === 8) entries.set(name, inflateRawSync(compressed));
    else throw new Error(`Unsupported ZIP compression method: ${method}`);

    centralOffset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

describe('server-v2 /api/v1/sessions status context window', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-status-'));
    await writeFile(
      join(home, 'config.toml'),
      [
        'default_model = "k2"',
        '',
        '[providers.kimi]',
        'type = "kimi"',
        'api_key = "sk-test"',
        'base_url = "https://api.example.test/v1"',
        '',
        '[models.k2]',
        'provider = "kimi"',
        'model = "kimi-k2"',
        'max_context_size = 131072',
        'display_name = "Kimi K2"',
        '',
      ].join('\n'),
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, {
        recursive: true,
        force: true,
        maxRetries: 25,
        retryDelay: 100,
      } as never).catch(() => undefined);
      home = undefined;
    }
  });

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('reports the default model context window before any model is bound', async () => {
    const cwd = home as string;
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd } });
    const session = getLiveSessionById(
      (server as RunningServer).core.accessor,
      created.body.data.id,
    )!;
    const usage = readUsageState(await ensureMainAgent(session));
    expect(usage?.max_context_tokens).toBe(131072);
    expect(usage?.context_tokens).toBe(0);
  });
});

describe('server-v2 /api/v1/sessions (minidb read model)', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  const READ_MODEL_ENV = 'KIMI_CODE_PERSISTENCE_MINIDB_READMODEL';

  const READ_MODEL_CONFIG = [
    'default_model = "stub"',
    '',
    '[providers.stub]',
    'type = "openai"',
    'base_url = "http://127.0.0.1:9999"',
    'api_key = "stub"',
    '',
    '[models.stub]',
    'provider = "stub"',
    'model = "stub"',
    'max_context_size = 1000',
    '',
  ].join('\n');

  beforeAll(async () => {
    process.env[READ_MODEL_ENV] = '1';
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-rm-'));
    await writeFile(join(home, 'config.toml'), READ_MODEL_CONFIG, 'utf8');
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    process.env[READ_MODEL_ENV] = 'false';
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, {
        recursive: true,
        force: true,
        maxRetries: 25,
        retryDelay: 100,
      } as never).catch(() => undefined);
      home = undefined;
    }
  });

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('prepares the read model at boot and serves immediate reads', async () => {
    const status = await getJson<{ state: string; generation?: number }>(
      '/api/v1/debug/sessionIndex/status',
    );
    expect(status.body.code).toBe(0);
    expect(status.body.data.state).toBe('ready');

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    const id = created.body.data.id;

    await waitForAssertion(
      async () => {
        const listed = await getJson<PageWire>('/api/v1/sessions');
        expect(listed.body.data.items.some((s) => s.id === id)).toBe(true);

        const workspaces = await getJson<{ items: { session_count: number }[] }>(
          '/api/v1/workspaces',
        );
        expect(workspaces.body.data.items[0]?.session_count).toBe(1);

        const paged = await getJson<PageWire>(`/api/v1/sessions?page_size=1&before_id=${id}`);
        expect(paged.body.data.items).toEqual([]);
        expect(paged.body.data.has_more).toBe(false);
      },
      { timeout: 10_000 },
    );

    await postJson<{ archived: boolean }>(`/api/v1/sessions/${id}:archive`);
    const archivedOnly = await getJson<PageWire>('/api/v1/sessions?archived_only=true');
    expect(archivedOnly.body.data.items.map((s) => s.id)).toEqual([id]);

    await (server as RunningServer).close();
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
    const relisted = await getJson<PageWire>('/api/v1/sessions?include_archive=true');
    expect(relisted.body.data.items.map((s) => s.id)).toEqual([id]);
  });

  it('serves session routes from the authoritative store when the read model cannot open', async () => {
    await (server as RunningServer).close();
    server = undefined;
    await drainSessionIndexMirror();
    await drainQueryStoreDisposals();
    await rm(join(home as string, 'cache', 'query-store'), { recursive: true, force: true });
    await writeFile(join(home as string, 'cache', 'query-store'), 'sabotage', 'utf8');

    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;

    const status = await getJson<{ state: string; reason?: string; degradedCount: number }>(
      '/api/v1/debug/sessionIndex/status',
    );
    expect(status.body.data.state).toBe('degraded');
    expect(status.body.data.degradedCount).toBeGreaterThan(0);

    const created = await postJson<SessionWire>('/api/v1/sessions', {
      metadata: { cwd: home as string },
    });
    expect(created.body.code).toBe(0);
    const id = created.body.data.id;
    const listed = await getJson<PageWire>('/api/v1/sessions');
    expect(listed.body.data.items.some((s) => s.id === id)).toBe(true);
    const fetched = await getJson<{ id: string }>(`/api/v1/sessions/${id}`);
    expect(fetched.body.data.id).toBe(id);
  });
});

describe('server-v2 /api/v1/sessions:btw', () => {
  const modelBase = 'https://model.example.test/v1';
  const mainAnswer = 'The main agent answered with a much longer explanation than the side chat.';
  const sideAnswer = 'Short side answer.';
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let releaseSideAnswer: () => void = () => {};
  let sideAnswerGate: Promise<void> = Promise.resolve();

  function sseBody(text: string): string {
    const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake-model',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
    return `${chunk({ role: 'assistant', content: text }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`;
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-btw-'));
    await writeFile(
      join(home, 'config.toml'),
      [
        'default_model = "fake"',
        '',
        '[providers.fake]',
        'type = "openai"',
        'api_key = "sk-test"',
        `base_url = "${modelBase}"`,
        '',
        '[models.fake]',
        'provider = "fake"',
        'model = "fake-model"',
        'max_context_size = 131072',
        '',
      ].join('\n'),
      'utf-8',
    );
    const realFetch = globalThis.fetch;
    spyOn(globalThis, 'fetch').mockImplementation((async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(modelBase)) return realFetch(input, init);
      const messages = JSON.stringify(
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}').messages ?? [],
      );
      const side = messages.includes('side question');
      if (side) await sideAnswerGate;
      return new Response(sseBody(side ? sideAnswer : mainAnswer), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch);
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
  });

  async function postJson<T>(path: string, body: unknown): Promise<Envelope<T>> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  async function transcriptTurns(sessionId: string, agentId: string) {
    const res = await fetch(`${base}/api/v1/sessions/${sessionId}/transcript?agent_id=${agentId}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as Envelope<AgentTranscriptSnapshot>;
    return body.data.items.flatMap((item) => (item.kind === 'turn' ? [item] : []));
  }

  function answerOf(turn: Awaited<ReturnType<typeof transcriptTurns>>[number]): string[] {
    return turn.steps.flatMap((step) =>
      step.frames.flatMap((frame) =>
        frame.kind === 'text' && frame.role === 'assistant' ? [frame.text] : [],
      ),
    );
  }

  it('keeps the first side chat answer when its prompt starts before anyone reads the fork', async () => {
    const created = await postJson<SessionWire>('/api/v1/sessions', { metadata: { cwd: home } });
    const sessionId = created.data.id;
    await transcriptTurns(sessionId, 'main');
    await postJson(`/api/v1/sessions/${sessionId}/prompts`, {
      content: [{ type: 'text', text: 'main question' }],
      model: 'fake',
    });
    await waitForAssertion(
      async () => {
        expect((await transcriptTurns(sessionId, 'main')).map((turn) => turn.state)).toEqual([
          'completed',
        ]);
      },
      { timeout: 10_000 },
    );

    sideAnswerGate = new Promise((resolve) => {
      releaseSideAnswer = resolve;
    });
    const btw = await postJson<{ agent_id: string }>(`/api/v1/sessions/${sessionId}:btw`, {});
    const agentId = btw.data.agent_id;
    await postJson(`/api/v1/sessions/${sessionId}/prompts`, {
      content: [{ type: 'text', text: 'side question' }],
      agent_id: agentId,
      model: 'fake',
    });
    await transcriptTurns(sessionId, agentId);
    releaseSideAnswer();

    await waitForAssertion(
      async () => {
        const own = (await transcriptTurns(sessionId, agentId)).filter(
          (turn) => turn.prompt === 'side question',
        );
        expect(own.map((turn) => turn.state)).toEqual(['completed']);
      },
      { timeout: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    const turns = await transcriptTurns(sessionId, agentId);
    const own = turns.filter((turn) => turn.prompt === 'side question');
    expect(own).toHaveLength(1);
    expect(answerOf(own[0]!)).toEqual([sideAnswer]);
    expect(new Set(turns.map((turn) => turn.turnId)).size).toBe(turns.length);
  });
});
