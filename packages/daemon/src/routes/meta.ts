/**
 * `GET /meta` route handler — Chain 1 / P1.1.
 *
 * Returns the daemon's `daemon_version`, declared `capabilities` literal map,
 * a per-process `server_id` (ULID minted at boot — reset on every restart so
 * clients can detect a daemon restart and resync), and `started_at` ISO time.
 *
 * **No DI**: this route doesn't touch services — it's pure daemon-self info
 * per ROADMAP Chain 1 ("不经过 services 包"). The `MetaRouteOptions` payload
 * is provided by `start.ts` at registration time and frozen for the daemon's
 * lifetime.
 *
 * **Wire shape**: matches `metaResponseSchema` (REST.md §3.1) exactly. The
 * envelope wrap is `okEnvelope(data, req.id)` — `req.id` is the bare 26-char
 * ULID set by Fastify's `genReqId` via `resolveRequestId` (W4.3).
 *
 * **Anti-corruption**: no SDK package import, no broker / bridge access. The
 * version source is the daemon's own `package.json` read via
 * `getDaemonVersion()` — no indirection through services or agent-core.
 */

import { metaResponseSchema } from '@moonshot-ai/protocol';

import { okEnvelope } from '../envelope.js';
import { buildRouteSchema } from '../middleware/schema.js';
import type { MetaResponse } from '@moonshot-ai/protocol';

/**
 * Minimal structural shape for the Fastify instance — just the verbs this
 * file calls. Avoids the strict generic mismatch between Fastify's default
 * `FastifyInstance` and the daemon's pino-typed variant
 * (`FastifyInstance<…, DaemonLogger>`), same pattern as
 * `error-handler.ts:ErrorHandlerHost` and `rest-gateway.ts:FastifyLike`.
 */
interface RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export interface MetaRouteOptions {
  /** Daemon `package.json` version. Cached at startup. */
  readonly daemonVersion: string;
  /** Per-process ULID. Minted once at boot in `start.ts`. */
  readonly serverId: string;
  /** ISO 8601 UTC timestamp the daemon went live at. */
  readonly startedAt: string;
}

export function registerMetaRoute(app: RouteHost, opts: MetaRouteOptions): void {
  // Freeze a single response object — this endpoint's payload never changes
  // for the daemon's lifetime (capabilities are first-version literal `true`s).
  const data: MetaResponse = Object.freeze({
    daemon_version: opts.daemonVersion,
    capabilities: Object.freeze({
      websocket: true as const,
      file_upload: true as const,
      fs_query: true as const,
      mcp: true as const,
      background_tasks: true as const,
    }),
    server_id: opts.serverId,
    started_at: opts.startedAt,
  });

  app.get(
    '/meta',
    {
      schema: buildRouteSchema({
        description: 'Get daemon metadata',
        tags: ['meta'],
        response: { 200: metaResponseSchema },
      }),
    },
    async (req, reply) => {
      reply.send(okEnvelope(data, req.id));
    },
  );
}
