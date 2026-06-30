/**
 * Server bootstrap — wires `@moonshot-ai/agent-core-v2` (DI × Scope engine) into
 * a Fastify HTTP server that speaks the same `/api/v1` interface as the v1
 * server.
 *
 * Composition root: `bootstrap()` builds the Core `Scope`; route handlers resolve
 * Core-scoped services through `core.accessor.get(IXxx)`.
 */

import {
  bootstrap,
  logSeed,
  resolveConfigPath,
  resolveKimiHome,
  resolveLoggingConfig,
  type Scope,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import Fastify, { type FastifyInstance } from 'fastify';

import { installErrorHandler } from './error-handler';
import { transformOpenApiDocument } from './openapi/transforms';
import { resolveRequestId } from './request-id';
import { registerApiV1Routes } from './routes/registerApiV1Routes';
// Registers the real `node-pty` `ISessionTerminalBackend`, overriding the
// `SessionNotImplementedTerminalBackend` stub from `agent-core-v2`. Side-effect import.
import './terminal/nodePtyTerminalBackend';
import {
  createServerLogger,
  type ServerLogger,
  type ServerLogLevel,
} from './services/pinoLoggerService';
import { join } from 'node:path';

import { registerRpcRoutes } from './transport/registerRpcRoutes';
import {
  ConnectionRegistry,
  type IConnectionRegistry,
} from './transport/ws/connectionRegistry';
import { registerWs, WS_PATH as WS_PATH_V2 } from './transport/ws/registerWs';
import { SessionEventBroadcaster } from './transport/ws/v1/sessionEventBroadcaster';
import { registerWsV1, WS_PATH as WS_PATH_V1 } from './transport/ws/v1/registerWsV1';
import { getServerVersion } from './version';

export interface ServerStartOptions {
  readonly host?: string;
  readonly port?: number;
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly logLevel?: ServerLogLevel;
  readonly logger?: ServerLogger;
  readonly debugEndpoints?: boolean;
  /** When set, require `Authorization: Bearer <rpcToken>` on `/api/v2`. */
  readonly rpcToken?: string;
  /** Extra scope seeds applied at bootstrap (e.g. a host-provided `ISessionModelResolver`). */
  readonly seeds?: ScopeSeed;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly core: Scope;
  readonly connectionRegistry: IConnectionRegistry;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 58627;

export async function startServer(opts: ServerStartOptions = {}): Promise<RunningServer> {
  const homeDir = resolveKimiHome(opts.homeDir);
  const configPath = resolveConfigPath({ homeDir, configPath: opts.configPath });
  // `ILogOptions` (logSeed) is required by the Session-scoped log writer; any
  // route that creates a session (e.g. POST /sessions) would otherwise fail to
  // instantiate the Session scope. Resolve it from env + homeDir like the CLI.
  const logging = resolveLoggingConfig({ homeDir, env: process.env });
  // `bootstrap()` seeds every storage role token (`IStorageService`,
  // `IAtomicDocumentStorage`, `IAppendLogStorage`, `IBlobStorage`) with its own
  // file-backed instance rooted at `homeDir`, so session metadata, wire
  // records, blobs, and the session index all persist to disk.
  const { core } = bootstrap({ homeDir, configPath }, [
    ...logSeed(logging),
    ...(opts.seeds ?? []),
  ]);

  const logger = opts.logger ?? createServerLogger({ level: opts.logLevel ?? 'info' });

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
    genReqId: (req) => resolveRequestId(req.headers),
  }) as unknown as FastifyInstance;
  // Validation is performed by the route-level Zod preHandlers (defineRoute),
  // not by Fastify's AJV layer — keep both compilers as pass-throughs.
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  installErrorHandler(app);

  const close = async (): Promise<void> => {
    await app.close();
    core.dispose();
  };

  const connectionRegistry = new ConnectionRegistry();
  const broadcaster = new SessionEventBroadcaster({
    eventsDir: join(homeDir, 'server', 'events'),
    core,
    logger,
  });

  const serverVersion = getServerVersion();

  async function registerOpenApi(): Promise<void> {
    const { default: swagger } = await import('@fastify/swagger');
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Kimi Code Server API',
          description:
            'REST API for the Kimi Code local server. All JSON responses are wrapped in a uniform envelope `{ code, msg, data, request_id }`.',
          version: serverVersion,
        },
        tags: [
          { name: 'meta', description: 'Server metadata' },
          { name: 'auth', description: 'Auth readiness & login state' },
          { name: 'models', description: 'Configured model aliases' },
          { name: 'providers', description: 'Configured providers' },
          { name: 'sessions', description: 'Session lifecycle' },
          { name: 'workspaces', description: 'Workspace registry + folder picker' },
          { name: 'messages', description: 'Message history' },
          { name: 'prompts', description: 'Prompt submission & abort' },
          { name: 'approvals', description: 'Approval resolution' },
          { name: 'questions', description: 'Question resolution & dismiss' },
          { name: 'tools', description: 'Tool & MCP server management' },
          { name: 'tasks', description: 'Background tasks' },
          { name: 'terminals', description: 'PTY terminal sessions' },
          { name: 'fs', description: 'Filesystem operations' },
          { name: 'files', description: 'File upload & download' },
        ],
      },
      transformObject: (documentObject) => {
        if (!('openapiObject' in documentObject)) {
          return documentObject.swaggerObject;
        }
        return transformOpenApiDocument(documentObject.openapiObject as Record<string, unknown>);
      },
    });
  }

  // `@fastify/swagger` collects route schemas via an `onRoute` hook, so it must
  // be registered before any routes it should document.
  await registerOpenApi();

  await registerApiV1Routes(app, core, {
    serverVersion,
    debugEndpoints: opts.debugEndpoints,
    onShutdown: () => {
      void close();
    },
    connectionRegistry,
    broadcaster,
  });

  registerRpcRoutes(app, core, { token: opts.rpcToken });
  const wssV2 = registerWs(core, { token: opts.rpcToken, registry: connectionRegistry });
  const wssV1 = registerWsV1(core, {
    token: opts.rpcToken,
    registry: connectionRegistry,
    broadcaster,
    logger,
  });

  app.server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (url === WS_PATH_V1 || url.startsWith(`${WS_PATH_V1}?`)) {
      wssV1.handleUpgrade(req, socket, head, (ws) => wssV1.emit('connection', ws, req));
    } else if (url === WS_PATH_V2 || url.startsWith(`${WS_PATH_V2}?`)) {
      wssV2.handleUpgrade(req, socket, head, (ws) => wssV2.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  app.addHook('onClose', async () => {
    connectionRegistry.closeAll('server shutting down');
    wssV1.close();
    wssV2.close();
    await broadcaster.close();
  });

  app.get('/openapi.json', async (_req, reply) => {
    const openApiDocument = (app as unknown as { swagger(): unknown }).swagger();
    return reply.type('application/json').send(openApiDocument);
  });

  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  await app.listen({ host, port });

  const address = app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return { app, core, connectionRegistry, host, port: boundPort, close };
}
