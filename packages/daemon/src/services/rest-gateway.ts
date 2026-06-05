/**
 * `IRestGateway` DI surface (W4.4 / P0.14).
 *
 * Wraps the Fastify instance the daemon constructs at boot so consumer
 * services can inject it without taking a direct `fastify` dependency. The
 * concrete impl forwards `listen()` to Fastify and disposes by calling
 * `app.close()` — Fastify drains in-flight requests then shuts down the HTTP
 * server.
 *
 * Construction-order positioning: registered SECOND (right after ILogger).
 * Dispose order then runs gateway BEFORE logger, which is the safe ordering —
 * Fastify's drain logs through the still-alive pino instance.
 *
 * The interface declares `app` with a structural shape rather than the
 * concrete `FastifyInstance<…, DaemonLogger>` generic, so consumers don't
 * need to know about the daemon's pino-typed instance. Internally
 * `FastifyRestGateway` accepts any FastifyInstance variant via the
 * `FastifyLike` structural type (sidesteps the strict-generic mismatch
 * between Fastify's default `FastifyInstance` and the daemon's pino-typed
 * variant).
 */

import type { Server as HttpServer } from 'node:http';

import { Disposable, createDecorator } from '@moonshot-ai/agent-core';

/**
 * Minimum shape we need from a Fastify instance. Avoids the strict-generic
 * mismatch between `FastifyInstance<…, DaemonLogger>` and `FastifyInstance`'s
 * default generics that surfaces at the route-options level.
 *
 * W5.1: `server` (the raw Node `http.Server` Fastify wraps) is required so
 * `WSGateway` can attach a typed `'upgrade'` handler for `/api/v1/ws` without
 * pulling in `fastify-websocket`. Fastify exposes `app.server` after
 * `await app.ready()` (or after `listen()`); we add the typed property here
 * rather than widening to `any` — the anti-corruption discipline matters.
 */
export interface FastifyLike {
  listen(opts: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
  /** Raw Node HTTP server; populated by Fastify lazily (post-`ready()`). */
  readonly server: HttpServer;
}

export interface IRestGateway {
  readonly app: FastifyLike;
  listen(host: string, port: number): Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IRestGateway = createDecorator<IRestGateway>('IRestGateway');

export class FastifyRestGateway extends Disposable implements IRestGateway {
  constructor(public readonly app: FastifyLike) {
    super();
  }

  async listen(host: string, port: number): Promise<string> {
    return await this.app.listen({ host, port });
  }

  override dispose(): void {
    if (this._isDisposed) return;
    // Fire-and-forget — Fastify's close is async but the DI dispose contract is sync.
    // The daemon's RunningDaemon.close() awaits `app.close()` explicitly before
    // calling ix.dispose(), so by the time we get here the listener is already
    // stopped; this is a defensive belt-and-suspenders for non-CLI consumers.
    void this.app.close();
    super.dispose();
  }
}

