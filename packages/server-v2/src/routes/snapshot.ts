/**
 * `GET /sessions/{session_id}/snapshot` — atomic-at-a-watermark session
 * snapshot for client rebuild / reconnect resync.
 *
 * Assembles `{ as_of_seq, epoch, session, messages, in_flight_turn,
 * pending_approvals, pending_questions }` from v2 domain services and the
 * `SessionEventBroadcaster` (which owns the durable watermark and the in-flight
 * turn accumulator).
 *
 * Watermark stability: the broadcaster's `getSnapshotState` drains the
 * per-session dispatch queue before reading `{seq, epoch}`, so the returned
 * watermark is consistent with the session/message state read in the same
 * handler.
 */

import {
  IAgentLifecycleService,
  IContextMemory,
  IInteractionService,
  ISessionContext,
  ISessionLifecycleService,
  ISessionMetadata,
  IWorkspaceRegistry,
  toProtocolMessage,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode, sessionSnapshotResponseSchema, type Message } from '@moonshot-ai/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { type SessionEventBroadcaster } from '../transport/ws/v1/sessionEventBroadcaster';
import { toWireApproval } from './approvals';
import { toWireQuestion } from './questions';
import { toWireSession } from './sessions';

/** Most-recent messages included in the snapshot page. */
const SNAPSHOT_MESSAGE_PAGE_SIZE = 100;

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

interface SnapshotRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; params: { session_id: string } },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface SnapshotRouteDeps {
  readonly core: Scope;
  readonly broadcaster: SessionEventBroadcaster;
}

export function registerSnapshotRoutes(app: SnapshotRouteHost, deps: SnapshotRouteDeps): void {
  const { core, broadcaster } = deps;

  const route = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/snapshot',
      params: sessionIdParamSchema,
      success: { data: sessionSnapshotResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description:
        'Atomic session snapshot for client rebuild: state + as_of_seq watermark + epoch',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;

      const handle = core.accessor.get(ISessionLifecycleService).get(session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} not found`, req.id),
        );
        return;
      }

      // Watermark + in-flight turn (drains the dispatch queue for consistency).
      const snapState = await broadcaster.getSnapshotState(session_id);

      // Session wire shape (needs the workspace root for `metadata.cwd`).
      const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
      const workspace = await core.accessor.get(IWorkspaceRegistry).get(workspaceId);
      const cwd = workspace?.root ?? '';
      const meta = await handle.accessor.get(ISessionMetadata).read();
      const session = toWireSession({ ...meta, workspaceId }, cwd);

      // Messages — most recent page of the main agent's live history.
      const main = handle.accessor.get(IAgentLifecycleService).getHandle('main');
      let items: Message[] = [];
      let hasMore = false;
      if (main !== undefined) {
        const history = main.accessor.get(IContextMemory).get();
        hasMore = history.length > SNAPSHOT_MESSAGE_PAGE_SIZE;
        const page = history.slice(-SNAPSHOT_MESSAGE_PAGE_SIZE);
        const offset = history.length - page.length;
        items = page.map((msg, i) => toProtocolMessage(session_id, offset + i, msg, meta.createdAt));
      }

      // Pending approvals / questions.
      const interaction = handle.accessor.get(IInteractionService);
      const pendingApprovals = interaction
        .listPending('approval')
        .map((i) => toWireApproval(i, session_id));
      const pendingQuestions = interaction
        .listPending('question')
        .map((i) => toWireQuestion(i, session_id));

      reply.send(
        okEnvelope(
          {
            as_of_seq: snapState.seq,
            epoch: snapState.epoch,
            session,
            messages: { items, has_more: hasMore },
            in_flight_turn: snapState.inFlightTurn,
            pending_approvals: pendingApprovals,
            pending_questions: pendingQuestions,
          },
          req.id,
        ),
      );
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<SnapshotRouteHost['get']>[2]);
}
