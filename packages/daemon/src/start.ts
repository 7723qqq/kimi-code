import {
  type ServiceIdentifier,
  InstantiationService,
  resolveConfigPath,
  resolveKimiHome,
  setUnexpectedErrorHandler,
} from '@moonshot-ai/agent-core';
import {
  IApprovalService,
  IAuthSummaryService,
  IEnvironmentService,
  IEventService,
  ICoreProcessService,
  IModelCatalogService,
  IMcpService,
  IMessageService,
  IOAuthService,
  IFileStore,
  IFsGitService,
  IFsSearchService,
  IFsService,
  IFsWatcher,
  ILogService,
  IPromptService,
  IQuestionService,
  ISessionService,
  ITaskService,
  IToolService,
  IWorkspaceFsService,
  IWorkspaceRegistry,
  FsPathEscapesError,
  FsWatchLimitError,
  FsWatcherService,
  SessionNotFoundError,
  createConnectionLookup,
  resolveSafePath,
  type CoreProcessServiceOptions,
} from '@moonshot-ai/services';
import { ErrorCode } from '@moonshot-ai/protocol';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ulid } from 'ulid';
import { promises as fspPromises } from 'node:fs';
import { sep as nodePathSep, relative as nodePathRelativeNative } from 'node:path';

import { okEnvelope } from './envelope';
import { installErrorHandler } from './error-handler';
import { transformOpenApiDocument } from './openapi/transforms';
import { acquireLock, DaemonLockedError } from './lock';
import {
  createDaemonLogger,
  type DaemonLogLevel,
  type DaemonLogger,
} from './services/pinoLoggerService';
import { resolveRequestId } from './request-id';
import { registerFsRoutes } from './routes/fs';
import { registerFilesRoutes } from './routes/files';
import { registerMessagesRoutes } from './routes/messages';
import { registerMetaRoute } from './routes/meta';
import { registerModelCatalogRoutes } from './routes/modelCatalog';
import { registerPromptsRoutes } from './routes/prompts';
import { registerApprovalsRoutes } from './routes/approvals';
import { registerAuthRoute } from './routes/auth';
import { registerOAuthRoutes } from './routes/oauth';
import { registerQuestionsRoutes } from './routes/questions';
import { registerSessionsRoutes } from './routes/sessions';
import { registerTasksRoutes } from './routes/tasks';
import { registerToolsRoutes } from './routes/tools';
import { registerDebugRoutes } from './routes/debug';
import { registerWorkspacesRoutes } from './routes/workspaces';
import { registerWorkspaceFsRoutes } from './routes/workspaceFs';
import { IConnectionRegistry } from '#/services/gateway';
import { IRestGateway } from '#/services/gateway';
import { ISessionClientsService } from '#/services/gateway';
import { createDaemonServiceCollection } from '#/services/serviceCollection';
import { IWSGateway, type WSGatewayOptions } from '#/services/gateway';
import { IWSBroadcastService } from '#/services/gateway';
import { getDaemonVersion } from './version';

export interface DaemonStartOptions {
  host: string;
  port: number;
  logLevel?: DaemonLogLevel;

  logger?: DaemonLogger;

  lockPath?: string;

  coreProcessOptions?: CoreProcessServiceOptions;

  wsGatewayOptions?: WSGatewayOptions;

  debugEndpoints?: boolean;

  serviceOverrides?: ReadonlyArray<readonly [ServiceIdentifier<unknown>, unknown]>;
}

export interface RunningDaemon {

  readonly address: string;

  readonly logger: DaemonLogger;

  readonly services: InstantiationService;

  close(): Promise<void>;
}

export { DaemonLockedError };

export async function startDaemon(opts: DaemonStartOptions): Promise<RunningDaemon> {
  const pinoLogger: DaemonLogger =
    opts.logger ?? createDaemonLogger({ level: opts.logLevel ?? 'info' });

  const lockHandle = acquireLock({ port: opts.port, lockPath: opts.lockPath });

  const app = Fastify({
    loggerInstance: pinoLogger,
    disableRequestLogging: false,
    genReqId: (req) => resolveRequestId(req.headers),
  });

  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  installErrorHandler(app);

  const daemonVersion = getDaemonVersion();
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Kimi Code Daemon API',
        description:
          'REST API for the Kimi Code local daemon. All JSON responses are wrapped in a uniform envelope `{ code, msg, data, request_id }`.',
        version: daemonVersion,
      },
      tags: [
        { name: 'meta', description: 'Daemon metadata' },
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

  const envService: IEnvironmentService = {
    _serviceBrand: undefined,
    homeDir: resolveKimiHome(opts.coreProcessOptions?.homeDir),
    configPath: resolveConfigPath({
      homeDir: opts.coreProcessOptions?.homeDir,
      configPath: opts.coreProcessOptions?.configPath,
    }),
  };

  const services = createDaemonServiceCollection({
    daemon: opts,
    app,
    pinoLogger,
    envService,
  });
  const ix = new InstantiationService(services);

  await app.register(async (apiV1) => {
    apiV1.get('/healthz', {
      schema: {
        description: 'Health check',
        response: {
          200: {
            type: 'object',
            properties: {
              code: { type: 'number' },
              msg: { type: 'string' },
              data: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
              },
              request_id: { type: 'string' },
            },
          },
        },
      },
    }, async (req, reply) => {
      return reply.send(okEnvelope({ ok: true }, req.id));
    });

    const daemonId = ulid();
    const startedAt = new Date().toISOString();
    registerMetaRoute(apiV1, {
      daemonVersion,
      daemonId,
      startedAt,
    });

    registerAuthRoute(apiV1 as unknown as Parameters<typeof registerAuthRoute>[0], ix);

    registerOAuthRoutes(apiV1 as unknown as Parameters<typeof registerOAuthRoutes>[0], ix);

    registerModelCatalogRoutes(
      apiV1 as unknown as Parameters<typeof registerModelCatalogRoutes>[0],
      ix,
    );

    registerSessionsRoutes(apiV1 as unknown as Parameters<typeof registerSessionsRoutes>[0], ix);

    registerMessagesRoutes(apiV1 as unknown as Parameters<typeof registerMessagesRoutes>[0], ix);

    registerPromptsRoutes(apiV1 as unknown as Parameters<typeof registerPromptsRoutes>[0], ix);

    registerApprovalsRoutes(
      apiV1 as unknown as Parameters<typeof registerApprovalsRoutes>[0],
      ix,
    );

    registerQuestionsRoutes(
      apiV1 as unknown as Parameters<typeof registerQuestionsRoutes>[0],
      ix,
    );

    registerToolsRoutes(
      apiV1 as unknown as Parameters<typeof registerToolsRoutes>[0],
      ix,
    );

    registerTasksRoutes(
      apiV1 as unknown as Parameters<typeof registerTasksRoutes>[0],
      ix,
    );

    registerFsRoutes(
      apiV1 as unknown as Parameters<typeof registerFsRoutes>[0],
      ix,
    );

    registerFilesRoutes(
      apiV1 as unknown as Parameters<typeof registerFilesRoutes>[0],
      ix,
    );

    registerWorkspacesRoutes(
      apiV1 as unknown as Parameters<typeof registerWorkspacesRoutes>[0],
      ix,
    );

    registerWorkspaceFsRoutes(
      apiV1 as unknown as Parameters<typeof registerWorkspaceFsRoutes>[0],
      ix,
    );

    if (opts.debugEndpoints === true) {
      registerDebugRoutes(
        apiV1 as unknown as Parameters<typeof registerDebugRoutes>[0],
        ix,
      );
    }
  }, { prefix: '/api/v1' });

  await app.register(swaggerUi, {
    routePrefix: '/documentation',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  try {
    await app.ready();
  } catch (err) {
    lockHandle.release();
    throw err;
  }

  let coreProcess: ICoreProcessService;
  try {
    coreProcess = ix.invokeFunction((a) => {

      const log = a.get(ILogService);
      a.get(IRestGateway);

      setUnexpectedErrorHandler((err) => {
        log.error(
          err instanceof Error ? { msg: err.message, stack: err.stack } : { err },
          '[unexpected]',
        );
      });

      a.get(IConnectionRegistry);

      a.get(ISessionClientsService);

      a.get(IEventService);

      const wsBroadcast = a.get(IWSBroadcastService);

      a.get(IApprovalService);
      a.get(IQuestionService);

      const wsGw = a.get(IWSGateway);

      const built = a.get(ICoreProcessService);

      const sessionService = a.get(ISessionService);
      a.get(IMessageService);

      a.get(IAuthSummaryService);

      a.get(IOAuthService);

      a.get(IModelCatalogService);

      const promptService = a.get(IPromptService);

      wsGw.setAbortHandler({
        abort: (sid, pid) => promptService.abort(sid, pid),
        currentSeq: (sid) => wsBroadcast.currentSeq(sid),
      });

      a.get(IToolService);
      a.get(IMcpService);

      a.get(ITaskService);

      a.get(IFsService);

      a.get(IFsSearchService);

      a.get(IFsGitService);

      const registry = a.get(IConnectionRegistry);
      const fsWatcher = ix.createInstance(
        FsWatcherService,
        createConnectionLookup((id) => registry.get(id)),
        {},
      );
      services.set(IFsWatcher, fsWatcher);
      a.get(IFsWatcher);

      const fsWatchHandler = {
        async add(sessionId: string, connectionId: string, wirePaths: readonly string[]) {
          try {
            const session = await sessionService.get(sessionId);

            const realCwd = await fspPromises.realpath(session.metadata.cwd);

            fsWatcher.bindSessionCwd(sessionId, realCwd);
            const absPaths: string[] = [];
            for (const p of wirePaths) {
              const safe = await resolveSafePath(session.metadata.cwd, p);
              absPaths.push(safe.absolute);
            }
            fsWatcher.addPaths(sessionId, connectionId, absPaths);
            const watched = fsWatcher.watchedPaths(connectionId, sessionId);

            const wire = watched.map((abs) => toPosixRelativeForCwd(realCwd, abs));
            return {
              ok: true as const,
              watched_paths: wire,
              current_count: fsWatcher.countForConnection(connectionId),
            };
          } catch (err) {
            return mapFsWatchError(err);
          }
        },
        async remove(sessionId: string, connectionId: string, wirePaths: readonly string[]) {
          try {
            const session = await sessionService.get(sessionId);
            const realCwd = await fspPromises.realpath(session.metadata.cwd);
            const absPaths: string[] = [];
            for (const p of wirePaths) {

              const safe = await resolveSafePath(session.metadata.cwd, p);
              absPaths.push(safe.absolute);
            }
            fsWatcher.removePaths(sessionId, connectionId, absPaths);
            const watched = fsWatcher.watchedPaths(connectionId, sessionId);
            const wire = watched.map((abs) => toPosixRelativeForCwd(realCwd, abs));
            return {
              ok: true as const,
              watched_paths: wire,
              current_count: fsWatcher.countForConnection(connectionId),
            };
          } catch (err) {
            return mapFsWatchError(err);
          }
        },
        cleanupConnection(connectionId: string) {
          fsWatcher.forgetConnection(connectionId);
        },
      };
      wsGw.setFsWatchHandler(fsWatchHandler);

      a.get(IFileStore);

      a.get(IWorkspaceRegistry);

      a.get(IWorkspaceFsService);

      return built;
    });
  } catch (err) {

    try {
      ix.dispose();
    } catch {

    }
    lockHandle.release();
    throw err;
  }

  try {
    await coreProcess.ready();
  } catch (err) {
    try {
      ix.dispose();
    } catch {

    }
    lockHandle.release();
    throw err;
  }
  pinoLogger.info('core process ready');

  let address: string;
  try {
    address = await ix.invokeFunction((a) => a.get(IRestGateway).listen(opts.host, opts.port));
  } catch (err) {
    try {
      ix.dispose();
    } catch {

    }
    lockHandle.release();
    throw err;
  }
  pinoLogger.info({ address, lockPath: lockHandle.lockPath }, 'daemon listening');

  let closed = false;
  return {
    address,
    logger: pinoLogger,
    services: ix,
    close: async () => {
      if (closed) return;
      closed = true;

      try {
        ix.invokeFunction((a) => a.get(IWSGateway));

        ix.invokeFunction((a) => a.get(IConnectionRegistry).closeAll('daemon shutting down'));
      } catch {

      }

      try {
        await app.close();
      } catch {

      }

      try {
        ix.dispose();
      } catch {

      }

      lockHandle.release();
    },
  };
}

function toPosixRelativeForCwd(cwd: string, abs: string): string {
  if (abs === cwd) return '.';
  const rel = nodePathRelativeNative(cwd, abs);
  if (rel === '') return '.';
  return rel.split(nodePathSep).join('/');
}

function mapFsWatchError(err: unknown):
  | { ok: false; code: number; msg: string } {
  if (err instanceof FsWatchLimitError) {
    return {
      ok: false,
      code: ErrorCode.FS_WATCH_LIMIT_EXCEEDED,
      msg: err.message,
    };
  }
  if (err instanceof FsPathEscapesError) {
    return {
      ok: false,
      code: ErrorCode.FS_PATH_ESCAPES_SESSION,
      msg: err.message,
    };
  }
  if (err instanceof SessionNotFoundError) {
    return {
      ok: false,
      code: ErrorCode.SESSION_NOT_FOUND,
      msg: 'session not found',
    };
  }
  return {
    ok: false,
    code: ErrorCode.INTERNAL_ERROR,
    msg: err instanceof Error ? err.message : 'fs watch error',
  };
}
