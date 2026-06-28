/**
 * Server bootstrap — wires `@moonshot-ai/agent-core-v2` (DI × Scope engine) into
 * a Fastify HTTP server that speaks the same `/api/v1` interface as the v1
 * server.
 *
 * Composition root: `bootstrap()` builds the Core `Scope`; route handlers resolve
 * Core-scoped services through `core.accessor.get(IXxx)`.
 */

import { bootstrap, resolveConfigPath, resolveKimiHome, type Scope } from '@moonshot-ai/agent-core-v2';
import Fastify, { type FastifyInstance } from 'fastify';

import { installErrorHandler } from './error-handler';
import { registerApiV1Routes } from './routes/registerApiV1Routes';
import { resolveRequestId } from './request-id';
import {
  createServerLogger,
  type ServerLogger,
  type ServerLogLevel,
} from './services/pinoLoggerService';
import { getServerVersion } from './version';

export interface ServerStartOptions {
  readonly host?: string;
  readonly port?: number;
  readonly homeDir?: string;
  readonly configPath?: string;
  readonly logLevel?: ServerLogLevel;
  readonly logger?: ServerLogger;
  readonly debugEndpoints?: boolean;
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly core: Scope;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 58627;

export async function startServer(opts: ServerStartOptions = {}): Promise<RunningServer> {
  const homeDir = resolveKimiHome(opts.homeDir);
  const configPath = resolveConfigPath({ homeDir, configPath: opts.configPath });
  const { core } = bootstrap({ homeDir, configPath });

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

  await registerApiV1Routes(app, core, {
    serverVersion: getServerVersion(),
    debugEndpoints: opts.debugEndpoints,
    onShutdown: () => {
      void close();
    },
  });

  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  await app.listen({ host, port });

  const address = app.server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return { app, core, host, port: boundPort, close };
}
