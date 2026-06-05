/**
 * `/v1/sessions/{session_id}/messages*` REST routes (Chain 3 / P1.3, W7.1).
 *
 * 2 endpoints (REST.md §3.4):
 *
 *   GET    /v1/sessions/{sid}/messages         query: ListMessages   data: Page<Message>
 *   GET    /v1/sessions/{sid}/messages/{mid}   -                     data: Message
 *
 * Validation: query is coerced + checked by `messagesListQueryCoercion`
 * (`z.coerce.number()` for `page_size`, mutex re-asserted via superRefine,
 * unknown role values rejected). Params validated by `messageIdParamSchema`.
 *
 * **Error mapping**:
 *   - `SessionNotFoundError`   → 40401
 *   - `MessageNotFoundError`   → 40403
 *   - Other errors fall through to W4 `installErrorHandler` (→ 50001).
 *
 * **Wiring**: takes an `IInstantiationService` so each request resolves
 * `IMessageService` via the daemon's DI container. Same pattern as
 * `sessions.ts` — handlers don't capture the service directly.
 *
 * **Anti-corruption**: route file lives in `packages/daemon/src/` and goes
 * through `accessor.get(IMessageService)` whose impl lives in
 * `@moonshot-ai/services`. No SDK package imports.
 */

import {
  ErrorCode,
  messageRoleSchema,
  type ListMessagesQuery,
} from '@moonshot-ai/protocol';
import {
  IMessageService,
  MessageNotFoundError,
  SessionNotFoundError,
} from '@moonshot-ai/services';
import { z } from 'zod';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope.js';
import { validateParams, validateQuery } from '../middleware/validate.js';

/**
 * Per-request structural typing — keeps the route module decoupled from the
 * concrete FastifyRequest generic parameters.
 */
interface MessageRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[] } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

// --- Query coercion ---------------------------------------------------------

/**
 * HTTP query strings arrive as `Record<string, string>`. We coerce
 * `page_size` here so the protocol's `cursorQuerySchema` stays HTTP-agnostic
 * — mirrors `sessions.ts:sessionsListQueryCoercion`.
 */
const messagesListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    role: messageRoleSchema.optional(),
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

const messageIdParamSchema = z.object({
  session_id: z.string().min(1),
  message_id: z.string().min(1),
});

// --- Registration -----------------------------------------------------------

export function registerMessagesRoutes(
  app: MessageRouteHost,
  ix: IInstantiationService,
): void {
  // GET /v1/sessions/{session_id}/messages --------------------------------
  app.get(
    '/v1/sessions/:session_id/messages',
    {
      preHandler: [
        validateParams(sessionIdParamSchema),
        validateQuery(messagesListQueryCoercion),
      ],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params as { session_id: string };
        const query = req.query as ListMessagesQuery;
        const page = await ix.invokeFunction((a) =>
          a.get(IMessageService).list(session_id, query),
        );
        reply.send(okEnvelope(page, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // GET /v1/sessions/{session_id}/messages/{message_id} -------------------
  app.get(
    '/v1/sessions/:session_id/messages/:message_id',
    { preHandler: [validateParams(messageIdParamSchema)] },
    async (req, reply) => {
      try {
        const { session_id, message_id } = req.params as {
          session_id: string;
          message_id: string;
        };
        const message = await ix.invokeFunction((a) =>
          a.get(IMessageService).get(session_id, message_id),
        );
        reply.send(okEnvelope(message, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
}

/**
 * Map a thrown error to the right envelope:
 *   - `SessionNotFoundError`  → `code: 40401`
 *   - `MessageNotFoundError`  → `code: 40403`
 *   - Anything else → re-throw; W4 `installErrorHandler` → `50001`.
 */
function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof MessageNotFoundError) {
    reply.send(errEnvelope(ErrorCode.MESSAGE_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof SessionNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
    return;
  }
  throw err;
}
