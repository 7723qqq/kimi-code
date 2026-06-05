/**
 * `/sessions/{sid}/questions/{qid}*` REST routes (Chain 6 / P1.6, W8.2).
 *
 * 2 endpoints (REST.md §3.6), both serviced by a SINGLE Fastify route handler
 * because Fastify cannot disambiguate `:question_id` vs `:question_id:dismiss`
 * on the same path prefix (the W7 prompts `:abort` worked because it was the
 * sole tail; questions has both a bare resolve and a `:dismiss` so we MUST
 * use the tail-parser for both):
 *
 *   POST   /sessions/{sid}/questions/{qid}             (resolve)
 *     body: QuestionResponse (5-kind answers map + method?+ note?)
 *     data: { resolved: true, resolved_at }
 *
 *   POST   /sessions/{sid}/questions/{qid}:dismiss     (first-class
 *     body: empty                                          dismiss)
 *     envelope: code: 40909, data: { dismissed: true, dismissed_at }
 *
 * **Fastify `:dismiss` action-suffix workaround** (W7 `:abort` precedent):
 * we capture the tail segment as `:tail` and parse via `lastIndexOf(':')`.
 * The pattern is now in use by 3 callers (prompts:abort + questions:resolve +
 * questions:dismiss); W9 may want to extract a helper.
 *
 * Error mapping (REST.md §3.6):
 *   - 40404 (question.not_found)
 *   - 40902 (question.already_resolved) — custom envelope w/ data:{resolved:false}
 *   - 40001 (validation.failed)         — bad body via Zod
 *   - 40909 (question.dismissed)        — successful dismiss envelope
 *
 * **Anti-corruption**: route resolves `IQuestionBroker` via the accessor;
 * no SDK imports.
 */

import {
  ErrorCode,
  questionResolveRequestSchema,
  questionResolveResultSchema,
  type QuestionResolveRequest,
  type QuestionResolveResult,
} from '@moonshot-ai/protocol';
import {
  IQuestionBroker,
  questionToAgentCoreResponse,
} from '@moonshot-ai/services';
import { z } from 'zod';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope.js';
import { buildRouteSchema } from '../middleware/schema.js';
import { validateParams } from '../middleware/validate.js';
import { parseActionSuffix } from './action-suffix.js';
import { DaemonQuestionBroker } from '../services/question-broker.js';

interface QuestionRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const tailParamsSchema = z.object({
  session_id: z.string().min(1),
  tail: z.string().min(1),
});

export function registerQuestionsRoutes(
  app: QuestionRouteHost,
  ix: IInstantiationService,
): void {
  // Single route capturing both the resolve and dismiss paths via `:tail`.
  app.post(
    '/sessions/:session_id/questions/:tail',
    {
      preHandler: [validateParams(tailParamsSchema)],
      schema: buildRouteSchema({
        description: 'Resolve or dismiss a question',
        tags: ['questions'],
        operationId: 'resolveOrDismissQuestion',
        params: tailParamsSchema,
        body: questionResolveRequestSchema,
        response: { 200: questionResolveResultSchema },
      }),
    },
    async (req, reply) => {
      const { tail } = req.params as { session_id: string; tail: string };
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['dismiss'] as const,
        defaultAction: 'resolve',
        resourceLabel: 'question',
      });
      if (parsed.kind === 'invalid') {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id),
        );
        return;
      }
      const questionId = parsed.id;
      const action: 'resolve' | 'dismiss' =
        parsed.kind === 'bare' ? 'resolve' : parsed.action;

      if (!questionId) {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            'invalid question_id in path',
            req.id,
          ),
        );
        return;
      }

      const broker = ix.invokeFunction((a) =>
        a.get(IQuestionBroker) as DaemonQuestionBroker,
      );

      if (!broker.isPending(questionId)) {
        if (broker.isRecentlyResolved(questionId)) {
          reply.send({
            code: ErrorCode.APPROVAL_ALREADY_RESOLVED, // 40902 — shared "already_resolved"
            msg: `question ${questionId} already resolved`,
            data: { resolved: false },
            request_id: req.id,
          });
          return;
        }
        reply.send(
          errEnvelope(
            ErrorCode.QUESTION_NOT_FOUND,
            `question ${questionId} not found`,
            req.id,
          ),
        );
        return;
      }

      if (action === 'dismiss') {
        broker.dismiss(questionId);
        reply.send({
          code: ErrorCode.QUESTION_DISMISSED, // 40909
          msg: `question ${questionId} dismissed`,
          data: { dismissed: true, dismissed_at: new Date().toISOString() },
          request_id: req.id,
        });
        return;
      }

      // action === 'resolve' — validate body manually (we can't use the Zod
      // preHandler here because the route shape is generic over `:tail` and
      // the dismiss path uses an empty body).
      const bodyParse = questionResolveRequestSchema.safeParse(req.body);
      if (!bodyParse.success) {
        const details = bodyParse.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        }));
        const first = details[0];
        const msg = first === undefined
          ? 'validation failed'
          : first.path === ''
            ? first.message
            : `${first.path}: ${first.message}`;
        reply.send({
          code: ErrorCode.VALIDATION_FAILED,
          msg,
          data: null,
          request_id: req.id,
          details,
        });
        return;
      }

      const body = bodyParse.data as QuestionResolveRequest;
      const inProc = questionToAgentCoreResponse(body);
      broker.resolve(questionId, inProc);
      broker.markResolved(questionId);

      const result: QuestionResolveResult = {
        resolved: true,
        resolved_at: new Date().toISOString(),
      };
      reply.send(okEnvelope(result, req.id));
    },
  );
}
