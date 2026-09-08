import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as netCreateServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stat as fsStat, realpath as fsRealpath } from 'node:fs/promises';

import {
  IHostFileSystem,
  ISessionIndex,
  ISessionIndexMirror,
  ISessionManager,
  ISessionMetadata,
  IWorkspaceService,
  IWorkspaceSessions,
  type ScopeSeed,
} from './core.js';

const ENGINE_READY_TIMEOUT_MS = 15_000;
const ENGINE_READY_POLL_MS = 150;

export interface EngineHandle {
  readonly baseUrl: string;
  request(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>;
  dispose(): void;
}

export interface EngineSeeds {
  readonly seeds: readonly ScopeSeed[];
  dispose(): void;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function resolveEngineBinary(): string | undefined {
  const candidates = [
    process.env['KIMI_AGENT_SERVER_BIN'],
    join(MODULE_DIR, '../../../kimi-agent/target/release/kimi-agent-cli.exe'),
    join(MODULE_DIR, '../../../kimi-agent/target/debug/kimi-agent-cli.exe'),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = netCreateServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const liveEngines = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of liveEngines) child.kill();
});

class EngineProcess implements EngineHandle {
  private child: ChildProcess | undefined;
  private readonly pending: Promise<void>;

  private constructor(
    readonly baseUrl: string,
    spawn_: () => ChildProcess,
  ) {
    this.pending = new Promise<void>((resolve, reject) => {
      this.child = spawn_();
      this.child.once('error', reject);
      resolve();
    });
  }

  static async start(homeDir: string): Promise<EngineProcess> {
    const binary = resolveEngineBinary();
    if (binary === undefined) throw new Error('engine binary not found');
    const port = await allocateFreePort();
    const dataDir = join(homeDir, '.kimi-agent');
    const child = spawn(binary, ['--serve', `127.0.0.1:${port}`, '--data-dir', dataDir, '--no-auth'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    liveEngines.add(child);
    child.once('exit', () => liveEngines.delete(child));
    const handle = new EngineProcess(`http://127.0.0.1:${port}`, () => child);
    const deadline = Date.now() + ENGINE_READY_TIMEOUT_MS;
    for (;;) {
      try {
        const res = await handle.request('GET', '/api/v1/health');
        if (res.status === 200) return handle;
      } catch {
        // engine not accepting connections yet
      }
      if (Date.now() > deadline) {
        handle.dispose();
        throw new Error('engine server did not become ready in time');
      }
      await sleep(ENGINE_READY_POLL_MS);
    }
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text.length > 0 ? (JSON.parse(text) as any) : undefined;
    return { status: res.status, json };
  }

  dispose(): void {
    this.child?.kill();
  }
}

function wireWorkspaceToEntity(wire: any): Record<string, unknown> {
  return {
    id: wire.id,
    root: wire.root,
    name: wire.name,
    createdAt: Date.parse(wire.created_at),
    lastOpenedAt: Date.parse(wire.last_opened_at),
    sessionCount: wire.session_count ?? 0,
  };
}

function wireSessionToMeta(wire: any): Record<string, unknown> {
  return {
    id: wire.id,
    workspaceId: wire.workspace_id,
    title: wire.title,
    createdAt: Date.parse(wire.created_at),
    updatedAt: Date.parse(wire.updated_at),
    archived: wire.archived === true,
    archivedAt: wire.archived_at === undefined || wire.archived_at === null ? undefined : Date.parse(wire.archived_at),
  };
}

function sessionMetaHandle(meta: Record<string, unknown>): {
  id: string;
  accessor: { get(token: unknown): unknown };
  dispose(): void;
} {
  return {
    id: meta['id'] as string,
    accessor: {
      get: (token: unknown) => {
        if (token === ISessionMetadata) {
          return {
            read: async () => meta,
            setTitle: async () => {},
            entries: async () => [],
            describeAgent: () => undefined,
          };
        }
        return undefined;
      },
    },
    dispose: () => {},
  };
}

export function createEngineSeeds(options: { homeDir: string }): EngineSeeds {
  const disposables: Array<() => void> = [];
  let enginePromise: Promise<EngineHandle> | undefined;

  const engine = (): Promise<EngineHandle> => {
    enginePromise ??= EngineProcess.start(options.homeDir).catch((error: unknown) => {
      enginePromise = undefined;
      throw new Error(`engine bridge unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    return enginePromise;
  };

  const withEngine = async (
    run: (engine: EngineHandle) => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      return await run(await engine());
    } catch (error) {
      if (process.env['KIMI_BRIDGE_DEBUG'] === '1') console.error('[engine-bridge]', error);
      return undefined;
    }
  };

  const listWireSessions = (engine: EngineHandle): Promise<any[]> =>
    engine.request('GET', '/api/v1/sessions').then((res) => res.json?.sessions ?? []);

  const seeds = [
    [
      IWorkspaceService,
      {
        list: () =>
          withEngine((engine) =>
            engine
              .request('GET', '/api/v1/workspaces')
              .then((res) => (res.json?.items ?? []).map(wireWorkspaceToEntity)),
          ),
        all: () =>
          withEngine((engine) =>
            engine
              .request('GET', '/api/v1/workspaces')
              .then((res) => (res.json?.items ?? []).map(wireWorkspaceToEntity)),
          ),
        get: (workspaceId: string) =>
          withEngine(async (engine) => {
            const res = await engine.request('GET', '/api/v1/workspaces');
            const wire = (res.json?.items ?? []).find((w: any) => w.id === workspaceId);
            return wire === undefined ? undefined : wireWorkspaceToEntity(wire);
          }),
        createOrTouch: (workDir: string, name?: string) =>
          withEngine(async (engine) => {
            const res = await engine.request('GET', '/api/v1/workspaces');
            const existing = (res.json?.items ?? []).find((w: any) => w.root === workDir);
            if (existing !== undefined) return wireWorkspaceToEntity(existing);
            const created = await engine.request('POST', '/api/v1/workspaces', {
              root: workDir,
              name,
            });
            if (created.json === undefined || created.json === null) return undefined;
            return { ...wireWorkspaceToEntity(created.json), root: workDir };
          }),
        update: (workspaceId: string, patch: { name?: string }) =>
          withEngine(async (engine) => {
            const res = await engine.request(
              'PATCH',
              `/api/v1/workspaces/${workspaceId}`,
              patch,
            );
            if (res.status >= 400) return undefined;
            return res.json === undefined || res.json === null
              ? undefined
              : wireWorkspaceToEntity(res.json);
          }),
        delete: (workspaceId: string) =>
          withEngine(async (engine) => {
            const res = await engine.request('DELETE', `/api/v1/workspaces/${workspaceId}`);
            return res.status < 400;
          }),
      },
    ],
    [
      ISessionManager,
      {
        create: (input: { workspaceId?: string; workDir?: string }) =>
          withEngine(async (engine) => {
            const created = await engine.request('POST', '/api/v1/sessions', {
              workspaceId: input.workspaceId,
            });
            const sessionId = created.json?.sessionId;
            if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
            const listed = await listWireSessions(engine);
            const wire = listed.find((s) => s.id === sessionId);
            return sessionMetaHandle(wire === undefined ? { id: sessionId } : wireSessionToMeta(wire));
          }),
        get: (sessionId: string) =>
          withEngine(async (engine) => {
            const listed = await listWireSessions(engine);
            const wire = listed.find((s) => s.id === sessionId);
            return wire === undefined ? undefined : sessionMetaHandle(wireSessionToMeta(wire));
          }),
        delete: (sessionId: string) =>
          withEngine(async (engine) => {
            await engine.request('DELETE', `/api/v1/sessions/${sessionId}`);
          }),
        status: () => ({ state: 'ready' }),
      },
    ],
    [
      ISessionIndex,
      {
        prepare: async () => ({ state: 'ready', generation: 1, degradedCount: 0 }),
        status: () => ({ state: 'ready', generation: 1, degradedCount: 0 }),
        get: (sessionId: string) =>
          withEngine(async (engine) => {
            const listed = await listWireSessions(engine);
            const wire = listed.find((s) => s.id === sessionId);
            return wire === undefined ? undefined : wireSessionToMeta(wire);
          }),
        listRecent: (query: { before?: string; limit?: number }) =>
          withEngine(async (engine) => {
            const listed = await listWireSessions(engine);
            const metas = listed.map(wireSessionToMeta);
            metas.sort((a: any, b: any) => b.updatedAt - a.updatedAt || String(b.id).localeCompare(String(a.id)));
            const start = query.before === undefined ? 0 : metas.findIndex((m: any) => m.id === query.before) + 1;
            const page = metas.slice(start, start + (query.limit ?? 20));
            const next =
              start + page.length < metas.length && page.length > 0
                ? page[page.length - 1]!['id']
                : undefined;
            return { items: page, nextCursor: next };
          }),
        count: () =>
          withEngine((engine) =>
            listWireSessions(engine).then((listed) => listed.length),
          ),
      },
    ],
    [
      IHostFileSystem,
      {
        stat: async (path: string) => {
          const s = await fsStat(path);
          return {
            isDirectory: s.isDirectory(),
            isFile: s.isFile(),
            size: s.size,
            mtimeMs: s.mtimeMs,
          };
        },
        realpath: async (path: string) => fsRealpath(path),
      },
    ],
    [
      IWorkspaceSessions,
      {
        count: (workspaceId: string) =>
          withEngine((engine) =>
            listWireSessions(engine).then(
              (listed) =>
                listed.filter((s) => s.workspace_id === workspaceId || workspaceId === undefined)
                  .length,
            ),
          ),
      },
    ],
    [
      ISessionIndexMirror,
      {
        drain: async () => undefined,
        shutdown: async () => {},
        dispose: () => {},
      },
    ],
  ];

  return {
    seeds: seeds as unknown as readonly ScopeSeed[],
    dispose: () => {
      for (const dispose of disposables) dispose();
      if (enginePromise !== undefined) {
        void enginePromise.then(
          (engine) => engine.dispose(),
          () => {},
        );
      }
    },
  };
}