/**
 * `/sessions/{sid}/approvals/{aid}` REST route (Chain 5 / P1.5, W8.1).
 *
 * 1 endpoint (REST.md §3.6):
 *
 *   POST   /sessions/{sid}/approvals/{aid}   body: ApprovalResponse
 *                                               data: { resolved: true, resolved_at }
 *
 * Error mapping (REST.md §3.6):
 *   - 40404 (approval.not_found)         — no pending approval matches {aid}
 *   - 40902 (approval.already_resolved)  — second resolve; custom envelope
 *                                          `{code:40902, data:{resolved:false}}`
 *                                          per W7's 40903-pattern
 *   - 40001 (validation.failed)          — bad body via the Zod preHandler
 *
 * **Mechanism**: idempotency is handled by the broker's `isPending()` gate
 * BEFORE calling `resolve()`. The broker drops the entry on resolve, so a
 * second call sees `!isPending` → we emit `40902`. (REST.md §3.6 says
 * `details.resolved_by` should carry the client_id; today we don't track
 * who answered first, so `details` stays absent — fully spec-compliant
 * but conservative.)
 *
 * **Anti-corruption**: route resolves `IApprovalBroker` via the accessor —
 * no SDK imports.
 */

import {
  approvalResolveRequestSchema,
  approvalResolveResultSchema,
  ErrorCode,
  type ApprovalResolveRequest,
  type ApprovalResolveResult,
} from '@moonshot-ai/protocol';
import {
  IApprovalBroker,
  approvalToAgentCoreResponse,
} from '@moonshot-ai/services';
import { z } from 'zod';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope.js';
import { buildRouteSchema } from '../middleware/schema.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  DaemonApprovalBroker,
} from '../services/approval-broker.js';

interface ApprovalRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const approvalParamsSchema = z.object({
  session_id: z.string().min(1),
  approval_id: z.string().min(1),
});

export function registerApprovalsRoutes(
  app: ApprovalRouteHost,
  ix: IInstantiationService,
): void {
  app.post(
    '/sessions/:session_id/approvals/:approval_id',
    {
      preHandler: [
        validateParams(approvalParamsSchema),
        validateBody(approvalResolveRequestSchema),
      ],
      schema: buildRouteSchema({
        description: 'Resolve an approval request',
        tags: ['approvals'],
        params: approvalParamsSchema,
        body: approvalResolveRequestSchema,
        response: { 200: approvalResolveResultSchema },
      }),
    },
    async (req, reply) => {
      try {
        const { approval_id } = req.params as { session_id: string; approval_id: string };
        const body = req.body as ApprovalResolveRequest;

        // Pre-check pending state. Two failure modes:
        //   - never-existed → 40404 (approval.not_found)
        //   - was-pending-and-resolved → 40902 (approval.already_resolved)
        // The broker doesn't distinguish — the route does, using
        // `isPending()`. We can't tell "never-existed" from "already-resolved"
        // without history, so we conservatively emit 40404 (more accurate
        // signal that the id is invalid; 40902 would be misleading for a
        // typo'd id). Production-grade tracking of resolved ids could move
        // the discrimination into the broker; out of W8 scope.
        const broker = ix.invokeFunction((a) =>
          a.get(IApprovalBroker) as DaemonApprovalBroker,
        );
        if (!broker.isPending(approval_id)) {
          // 40404 path covers BOTH "never-existed" and "already-resolved" in
          // this iteration. REST.md §3.6 lists 40902 for "已应答 + 抢答场景" —
          // for that we'd need a resolved-ids ledger; deferred until a real
          // multi-client client_id arrives in Phase 2. To still honor the
          // 40902 contract for re-POST cases, broker tracks recently-resolved
          // ids: see `isRecentlyResolved`.
          if (broker.isRecentlyResolved(approval_id)) {
            reply.send({
              code: ErrorCode.APPROVAL_ALREADY_RESOLVED,
              msg: `approval ${approval_id} already resolved`,
              data: { resolved: false },
              request_id: req.id,
            });
            return;
          }
          reply.send(
            errEnvelope(
              ErrorCode.APPROVAL_NOT_FOUND,
              `approval ${approval_id} not found`,
              req.id,
            ),
          );
          return;
        }

        // Adapt wire body → in-process SDK shape; settle the broker Promise.
        // The broker also broadcasts `event.approval.resolved` synchronously
        // before settling.
        const inProc = approvalToAgentCoreResponse(body);
        broker.resolve(approval_id, inProc);
        // Mark for short-window idempotency.
        broker.markResolved(approval_id);

        const result: ApprovalResolveResult = {
          resolved: true,
          resolved_at: new Date().toISOString(),
        };
        reply.send(okEnvelope(result, req.id));
      } catch (err) {
        // Unknown errors → 50001 via the global error handler.
        throw err;
      }
    },
  );
}
