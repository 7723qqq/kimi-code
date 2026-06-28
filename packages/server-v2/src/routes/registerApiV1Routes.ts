/**
 * `/api/v1` route registration.
 *
 * Mirrors the v1 server's prefixing and per-module delegation, but resolves
 * services from the `agent-core-v2` Core `Scope` instead of the v1 flat
 * `IInstantiationService`. v0.1 mounts the subset of routes that v2 can serve
 * end-to-end today (health, meta, auth readiness, OAuth device flow, shutdown).
 */

import type { Scope } from '@moonshot-ai/agent-core-v2';
import { ulid } from 'ulid';

import { okEnvelope } from '../envelope';
import { registerAuthRoute } from './auth';
import { registerMetaRoute } from './meta';
import { registerOAuthRoutes } from './oauth';
import { registerSessionsRoutes } from './sessions';
import { registerShutdownRoutes } from './shutdown';

interface ApiV1AppHost {
  register(
    plugin: (apiV1: ApiV1RouteHost) => Promise<void> | void,
    opts: { prefix: string },
  ): unknown;
}

interface ApiV1RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: { id: string }, reply: { send(payload: unknown): unknown }) => unknown,
  ): unknown;
}

export interface RegisterApiV1RoutesOptions {
  readonly serverVersion: string;
  readonly debugEndpoints?: boolean;
  readonly onShutdown: () => void;
}

export async function registerApiV1Routes(
  app: ApiV1AppHost,
  core: Scope,
  opts: RegisterApiV1RoutesOptions,
): Promise<void> {
  await app.register(
    async (apiV1) => {
      registerHealthRoute(apiV1);

      registerMetaRoute(apiV1, {
        serverVersion: opts.serverVersion,
        serverId: ulid(),
        startedAt: new Date().toISOString(),
      });

      registerAuthRoute(apiV1 as unknown as Parameters<typeof registerAuthRoute>[0], core);
      registerOAuthRoutes(apiV1 as unknown as Parameters<typeof registerOAuthRoutes>[0], core);
      registerSessionsRoutes(
        apiV1 as unknown as Parameters<typeof registerSessionsRoutes>[0],
        core,
      );
      registerShutdownRoutes(apiV1 as unknown as Parameters<typeof registerShutdownRoutes>[0], {
        onShutdown: opts.onShutdown,
      });
    },
    { prefix: '/api/v1' },
  );
}

function registerHealthRoute(apiV1: ApiV1RouteHost): void {
  apiV1.get(
    '/healthz',
    {
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
    },
    async (req, reply) => {
      return reply.send(okEnvelope({ ok: true }, req.id));
    },
  );
}
