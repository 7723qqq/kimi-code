/**
 * `/v1/sessions/*` REST routes (Chain 2 / P1.2).
 *
 * 5 endpoints (REST.md §3.3):
 *
 *   POST   /v1/sessions               body: SessionCreate    data: Session
 *   GET    /v1/sessions               query: ListSessions    data: Page<Session>
 *   GET    /v1/sessions/{id}          -                      data: Session
 *   PATCH  /v1/sessions/{id}          body: SessionUpdate    data: Session
 *   DELETE /v1/sessions/{id}          -                      data: { deleted: true }
 *
 * Each handler validates input with the Zod `validateBody` / `validateQuery`
 * preHandler (40001 on failure with `details` path), invokes
 * `accessor.get(ISessionService).<method>(...)`, and emits an `okEnvelope`.
 *
 * **Error mapping**: `SessionNotFoundError` → envelope `code: 40401`. Other
 * errors fall through to the W4 `installErrorHandler` (→ 50001).
 *
 * **Wiring**: takes an `IInstantiationService` so each request can resolve
 * `ISessionService` via the same DI container the daemon constructs in
 * `start.ts`. The handler closures don't capture the service directly — that
 * would break the per-request request_id flow and the dispose-cascade story.
 *
 * **Anti-corruption**: this file is part of `packages/daemon/src/`. No direct
 * SDK package imports — sessions go through `accessor.get(ISessionService)`
 * whose impl lives in `@moonshot-ai/services`.
 */

import {
  ErrorCode,
  createSessionRequestSchema,
  sessionStatusSchema,
  updateSessionRequestSchema,
  type SessionCreate,
  type SessionUpdate,
} from '@moonshot-ai/protocol';
import {
  ISessionService,
  SessionNotFoundError,
  type SessionListQuery,
} from '@moonshot-ai/services';
import { z } from 'zod';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';

/**
 * Per-request structural typing — we never need the full FastifyRequest type;
 * the fields below are the only ones the handlers touch.
 */
interface SessionRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[] },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[] } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  // Fastify exposes `patch` and `delete` as instance methods.
  patch(
    path: string,
    options: { preHandler: unknown[] },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[] } | undefined,
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

// --- Query coercion ---------------------------------------------------------

/**
 * HTTP query strings arrive as `Record<string, string>`. The protocol's
 * `cursorQuerySchema` expects `page_size: number`. We coerce at the daemon
 * boundary so the protocol schema stays HTTP-agnostic (re-usable on the
 * client side where JSON-RPC payloads already carry typed numbers).
 *
 * `page_size` parses as a positive integer 1..100; anything else fails 40001.
 */
const sessionsListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    status: sessionStatusSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_id and after_id are mutually exclusive',
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

// --- Params -----------------------------------------------------------------

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

// --- Registration -----------------------------------------------------------

export function registerSessionsRoutes(
  app: SessionRouteHost,
  ix: IInstantiationService,
): void {
  // POST /v1/sessions ------------------------------------------------------
  app.post(
    '/v1/sessions',
    { preHandler: [validateBody(createSessionRequestSchema)] },
    async (req, reply) => {
      try {
        const body = req.body as SessionCreate;
        const session = await ix.invokeFunction((a) => a.get(ISessionService).create(body));
        reply.send(okEnvelope(session, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // GET /v1/sessions -------------------------------------------------------
  app.get(
    '/v1/sessions',
    { preHandler: [validateQuery(sessionsListQueryCoercion)] },
    async (req, reply) => {
      try {
        const query = req.query as SessionListQuery;
        const page = await ix.invokeFunction((a) => a.get(ISessionService).list(query));
        reply.send(okEnvelope(page, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // GET /v1/sessions/{session_id} ------------------------------------------
  app.get(
    '/v1/sessions/:session_id',
    { preHandler: [validateParams(sessionIdParamSchema)] },
    async (req, reply) => {
      try {
        const { session_id } = req.params as { session_id: string };
        const session = await ix.invokeFunction((a) => a.get(ISessionService).get(session_id));
        reply.send(okEnvelope(session, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // PATCH /v1/sessions/{session_id} ----------------------------------------
  app.patch(
    '/v1/sessions/:session_id',
    {
      preHandler: [
        validateParams(sessionIdParamSchema),
        validateBody(updateSessionRequestSchema),
      ],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params as { session_id: string };
        const body = req.body as SessionUpdate;
        const session = await ix.invokeFunction((a) =>
          a.get(ISessionService).update(session_id, body),
        );
        reply.send(okEnvelope(session, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // DELETE /v1/sessions/{session_id} ---------------------------------------
  app.delete(
    '/v1/sessions/:session_id',
    { preHandler: [validateParams(sessionIdParamSchema)] },
    async (req, reply) => {
      try {
        const { session_id } = req.params as { session_id: string };
        const result = await ix.invokeFunction((a) => a.get(ISessionService).delete(session_id));
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
}

/**
 * Map a thrown error to the right envelope:
 *   - `SessionNotFoundError` → `code: 40401`
 *   - Anything else → re-throw so the W4 `installErrorHandler` catches it
 *     and emits `50001`.
 *
 * We don't catch generic `Error` here because the global hook is the single
 * place stack traces reach the operator log (`error-handler.ts:42-43`).
 */
function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof SessionNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
    return;
  }
  // Re-throw so Fastify's error hook handles it.
  throw err;
}
