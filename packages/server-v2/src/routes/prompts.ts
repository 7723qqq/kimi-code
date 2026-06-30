/**
 * `/api/v1` prompt routes — v1-compatible prompt surface backed by
 * `IPromptLegacyService` (the per-agent v1 scheduler). Paths and wire shapes
 * mirror `packages/server/src/routes/prompts.ts` so existing clients keep
 * working against server-v2.
 */

import {
  IPromptLegacyService,
  ISessionLifecycleService,
  isKimiError,
  KimiError,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  ErrorCode,
  promptAbortResponseSchema,
  promptListResponseSchema,
  promptSteerRequestSchema,
  promptSteerResultSchema,
  promptSubmissionSchema,
  promptSubmitResultSchema,
} from '@moonshot-ai/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
import { parseActionSuffix } from './action-suffix';

interface PromptRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
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

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

async function resolveLegacy(core: Scope, sessionId: string): Promise<IPromptLegacyService> {
  const session = core.accessor.get(ISessionLifecycleService).get(sessionId);
  if (session === undefined) {
    throw new KimiError('session.not_found', `session ${sessionId} does not exist`);
  }
  const agent = await ensureMainAgent(session);
  return agent.accessor.get(IPromptLegacyService);
}

export function registerPromptsRoutes(app: PromptRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/prompts',
      params: sessionIdParamSchema,
      success: { data: promptListResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: 'List the active prompt and queued prompts for a session',
      tags: ['prompts'],
      operationId: 'listPrompts',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const result = (await resolveLegacy(core, session_id)).list();
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<PromptRouteHost['get']>[2]);

  const submitRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts',
      body: promptSubmissionSchema,
      params: sessionIdParamSchema,
      success: { data: promptSubmitResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Submit a prompt to a session',
      tags: ['prompts'],
      operationId: 'submitPrompt',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const legacy = await resolveLegacy(core, session_id);
        const result = await legacy.submit(req.body);
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(submitRoute.path, submitRoute.options, submitRoute.handler as Parameters<PromptRouteHost['post']>[2]);

  const steerManyRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts::steer',
      body: promptSteerRequestSchema,
      params: sessionIdParamSchema,
      success: { data: promptSteerResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
      },
      description: 'Steer queued prompts into the active turn',
      tags: ['prompts'],
      operationId: 'steerPrompts',
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const legacy = await resolveLegacy(core, session_id);
        const result = await legacy.steer(req.body.prompt_ids);
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(steerManyRoute.path, steerManyRoute.options, steerManyRoute.handler as Parameters<PromptRouteHost['post']>[2]);

  const actionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/prompts/{tail}',
      success: { data: z.union([promptAbortResponseSchema, promptSteerResultSchema]) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PROMPT_NOT_FOUND]: {},
        [ErrorCode.PROMPT_ALREADY_COMPLETED]: { dataSchema: z.object({ aborted: z.literal(false) }) },
      },
      description: 'Abort a running prompt or steer a queued prompt',
      tags: ['prompts'],
      operationId: 'promptAction',
    },
    async (req, reply) => {
      try {
        const { session_id, tail } = req.params as { session_id: string; tail: string };
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['abort', 'steer'] as const,
          resourceLabel: 'prompt',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
          return;
        }
        const legacy = await resolveLegacy(core, session_id);
        const result =
          parsed.action === 'abort'
            ? await legacy.abort(parsed.id)
            : await legacy.steer([parsed.id]);
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(actionRoute.path, actionRoute.options, actionRoute.handler as Parameters<PromptRouteHost['post']>[2]);
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (isKimiError(err)) {
    switch (err.code) {
      case 'session.not_found':
      case 'agent.not_found':
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
        return;
      case 'prompt.not_found':
        reply.send(errEnvelope(ErrorCode.PROMPT_NOT_FOUND, err.message, requestId));
        return;
      case 'session.busy':
        reply.send(errEnvelope(ErrorCode.SESSION_BUSY, err.message, requestId));
        return;
      case 'prompt.already_completed':
        reply.send({
          code: ErrorCode.PROMPT_ALREADY_COMPLETED,
          msg: err.message,
          data: { aborted: false },
          request_id: requestId,
        });
        return;
      case 'request.invalid':
      case 'validation.failed':
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId));
        return;
    }
  }
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
    ),
  );
}
