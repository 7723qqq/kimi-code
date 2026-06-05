/**
 * `/sessions/{sid}/tasks*` REST routes (Chain 8 / P1.8, W9.2).
 *
 * 3 endpoints (REST.md §3.7):
 *
 *   GET  /sessions/{sid}/tasks                    query: {status?}        data: {items[]}
 *   GET  /sessions/{sid}/tasks/{tid}              query: {with_output?,
 *                                                            output_bytes?} data: BackgroundTask
 *   POST /sessions/{sid}/tasks/{tid}:cancel       body: empty             data: {cancelled:true}
 *
 * **Error mapping**:
 *   - `SessionNotFoundError`     → envelope `code: 40401`
 *   - `TaskNotFoundError`        → envelope `code: 40406`
 *   - `TaskAlreadyFinishedError` → envelope `code: 40904` with custom
 *     `data:{cancelled:false}` (mirrors W7's 40903/W8's 40902 precedent).
 *   - Other errors → 50001 via W4 `installErrorHandler`.
 *
 * **Action suffix**: `:cancel` uses the shared `parseActionSuffix` helper
 * (5th call site after prompts:abort, questions:resolve|dismiss, mcp:restart).
 *
 * **Anti-corruption**: route resolves `ITaskService` via the accessor; no
 * SDK imports.
 */

import {
  ErrorCode,
  cancelTaskResultSchema,
  getTaskQuerySchema,
  getTaskResponseSchema,
  listTasksQuerySchema,
  listTasksResponseSchema,
  type ListTasksQuery,
} from '@moonshot-ai/protocol';
import {
  ITaskService,
  SessionNotFoundError,
  TaskAlreadyFinishedError,
  TaskNotFoundError,
} from '@moonshot-ai/services';
import { z } from 'zod';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope.js';
import { buildRouteSchema } from '../middleware/schema.js';
import { validateParams, validateQuery } from '../middleware/validate.js';
import { parseActionSuffix } from './action-suffix.js';

interface TasksRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const sessionAndTaskIdParamSchema = z.object({
  session_id: z.string().min(1),
  task_id: z.string().min(1),
});

export function registerTasksRoutes(
  app: TasksRouteHost,
  ix: IInstantiationService,
): void {
  // GET /sessions/{session_id}/tasks ------------------------------------
  app.get(
    '/sessions/:session_id/tasks',
    {
      preHandler: [
        validateParams(sessionIdParamSchema),
        validateQuery(listTasksQuerySchema),
      ],
      schema: buildRouteSchema({
        description: 'List background tasks for a session',
        tags: ['tasks'],
        params: sessionIdParamSchema,
        querystring: listTasksQuerySchema,
        response: { 200: listTasksResponseSchema },
      }),
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params as { session_id: string };
        const query = req.query as ListTasksQuery;
        const items = await ix.invokeFunction((a) =>
          a.get(ITaskService).list(session_id, query),
        );
        reply.send(okEnvelope({ items }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // GET /sessions/{session_id}/tasks/{task_id} --------------------------
  app.get(
    '/sessions/:session_id/tasks/:task_id',
    {
      preHandler: [
        validateParams(sessionAndTaskIdParamSchema),
        validateQuery(getTaskQuerySchema),
      ],
      schema: buildRouteSchema({
        description: 'Get a background task by ID',
        tags: ['tasks'],
        params: sessionAndTaskIdParamSchema,
        querystring: getTaskQuerySchema,
        response: { 200: getTaskResponseSchema },
      }),
    },
    async (req, reply) => {
      try {
        const { session_id, task_id } = req.params as {
          session_id: string;
          task_id: string;
        };
        const task = await ix.invokeFunction((a) =>
          a.get(ITaskService).get(session_id, task_id),
        );
        reply.send(okEnvelope(task, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  // POST /sessions/{session_id}/tasks/{task_id}:cancel ------------------
  //
  // Fastify routes the GET `/:task_id` and the POST `/:tail` against the
  // same Trie prefix. Using `/:task_id:cancel`-style would collide; we
  // capture `:tail` and demand the `:cancel` suffix via the shared parser.
  app.post(
    '/sessions/:session_id/tasks/:tail',
    {
      preHandler: [],
      schema: buildRouteSchema({
        description: 'Cancel a background task',
        tags: ['tasks'],
        operationId: 'cancelTask',
        response: { 200: cancelTaskResultSchema },
      }),
    },
    async (req, reply) => {
      try {
        const { session_id, tail } = req.params as {
          session_id: string;
          tail: string;
        };
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['cancel'] as const,
          resourceLabel: 'task',
        });
        if (parsed.kind === 'invalid') {
          reply.send(
            errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id),
          );
          return;
        }
        if (parsed.kind === 'bare') {
          // POST without `:cancel` is not a defined action; the bare GET
          // form serves `/.../tasks/{tid}`.
          reply.send(
            errEnvelope(
              ErrorCode.VALIDATION_FAILED,
              `unsupported action: ${tail}`,
              req.id,
            ),
          );
          return;
        }
        const task_id = parsed.id;
        if (!session_id || !task_id) {
          reply.send(
            errEnvelope(ErrorCode.VALIDATION_FAILED, 'invalid path params', req.id),
          );
          return;
        }
        const result = await ix.invokeFunction((a) =>
          a.get(ITaskService).cancel(session_id, task_id),
        );
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
}

/**
 * Map a thrown error to the right envelope. See module header for the table.
 *
 * `TaskAlreadyFinishedError` is a SPECIAL case — REST.md §3.7 mandates
 * envelope `code: 40904` + `data: {cancelled: false}`. Mirrors the W7 40903
 * + W8 40902 idempotent shape.
 */
function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof TaskAlreadyFinishedError) {
    reply.send({
      code: ErrorCode.TASK_ALREADY_FINISHED,
      msg: err.message,
      data: { cancelled: false },
      request_id: requestId,
      details: { current_status: err.currentStatus },
    });
    return;
  }
  if (err instanceof TaskNotFoundError) {
    reply.send(errEnvelope(ErrorCode.TASK_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof SessionNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
    return;
  }
  throw err;
}
