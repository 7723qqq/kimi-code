/**
 * `/sessions` route handlers — server-v2 port.
 *
 * Implements the v1 `/api/v1/sessions` wire contract on top of
 * `agent-core-v2` services. Only the endpoints v2 can back today are
 * registered:
 *   POST   /sessions                  create
 *   GET    /sessions                  list
 *   GET    /sessions/{session_id}     get
 *   GET    /sessions/{session_id}/profile
 *   POST   /sessions/{session_id}/profile      update title (partial)
 *   POST   /sessions/{tail}                    ::archive action
 *   GET    /sessions/{session_id}/status       best-effort
 *
 * The remaining v1 actions (fork / compact / undo / abort / btw / children /
 * warnings) are not registered because `agent-core-v2` does not yet expose
 * the backing capabilities — see the server-v2 sessions gap list (G1–G10).
 *
 * **Wire fidelity**: mirrors v1's `toProtocolSession`
 * (`packages/agent-core/src/services/session/session.ts`), which populates
 * only the index/metadata fields and returns placeholders for the heavy ones
 * (`agent_config:{model:''}`, `usage:zeros`, `permission_rules:[]`,
 * `message_count:0`, `last_seq:0`, hardcoded `status:'idle'`). v2 produces the
 * same placeholder shape from `ISessionIndex` + `IWorkspaceRegistry`.
 *
 * **cwd resolution (gap G3)**: v2 does not store the original work dir on the
 * session; we recover `metadata.cwd` from `IWorkspaceRegistry`
 * (`workspaceId → root`). Sessions whose workspace is not registered cannot be
 * represented and are filtered from list / 404 on get.
 */

import {
  ISessionActivity,
  ISessionContext,
  ISessionIndex,
  ISessionLifecycleService,
  ISessionMetadata,
  IWorkspaceRegistry,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  ErrorCode,
  archiveSessionResponseSchema,
  createSessionRequestSchema,
  emptySessionUsage,
  pageResponseSchema,
  sessionSchema,
  sessionStatusResponseSchema,
  sessionStatusSchema,
  updateSessionProfileRequestSchema,
} from '@moonshot-ai/protocol';
import type { Session } from '@moonshot-ai/protocol';
import { ulid } from 'ulid';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';

interface SessionRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown; headers: Record<string, unknown> },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const booleanQueryParam = z.preprocess((value) => {
  if (value === 'true' || value === '1' || value === 1 || value === true) return true;
  if (value === 'false' || value === '0' || value === 0 || value === false) return false;
  return value;
}, z.boolean().optional());

// NOTE: `status` filtering and the `before_id`/`after_id` id-cursors are
// accepted for wire compatibility but not applied — `ISessionIndex` does not
// support them (gap G5). `page_size` maps to `limit`; `include_archive` maps
// to `includeArchived`; `workspace_id` maps to `workspaceId`.
const sessionsListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    status: sessionStatusSchema.optional(),
    include_archive: booleanQueryParam,
    workspace_id: z.string().min(1).optional(),
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

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const sessionActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerSessionsRoutes(app: SessionRouteHost, core: Scope): void {
  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions',
      body: createSessionRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'Create a new session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const body = req.body;
      const callerCwd = typeof body.metadata?.cwd === 'string' ? body.metadata.cwd : undefined;
      const workspaceId = body.workspace_id;
      if (workspaceId === undefined && callerCwd === undefined) {
        reply.send(
          buildValidationEnvelope(
            [{ path: 'metadata.cwd', message: 'either workspace_id or metadata.cwd is required' }],
            req.id,
          ),
        );
        return;
      }

      const registry = core.accessor.get(IWorkspaceRegistry);
      let workDir: string;
      if (workspaceId !== undefined) {
        const workspace = await registry.get(workspaceId);
        if (workspace === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.WORKSPACE_NOT_FOUND,
              `workspace ${workspaceId} does not exist`,
              req.id,
            ),
          );
          return;
        }
        if (callerCwd !== undefined && callerCwd !== workspace.root) {
          reply.send(
            buildValidationEnvelope(
              [
                {
                  path: 'metadata.cwd',
                  message: `metadata.cwd (${callerCwd}) must equal workspace root (${workspace.root})`,
                },
              ],
              req.id,
            ),
          );
          return;
        }
        workDir = workspace.root;
      } else {
        workDir = callerCwd as string;
      }

      // Ensure the workspace is registered so `metadata.cwd` is resolvable on
      // read (gap G3 — v2 does not store workDir on the session).
      const touched = await registry.createOrTouch(workDir);

      const handle = await core.accessor.get(ISessionLifecycleService).create({
        sessionId: ulid(),
        workDir,
      });
      if (typeof body.title === 'string') {
        await handle.accessor.get(ISessionMetadata).setTitle(body.title);
      }
      const meta = await handle.accessor.get(ISessionMetadata).read();
      reply.send(
        okEnvelope(toWireSession({ ...meta, workspaceId: touched.id }, touched.root), req.id),
      );
    },
  );
  app.post(
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions',
      querystring: sessionsListQueryCoercion,
      success: { data: pageResponseSchema(sessionSchema) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
      },
      description: 'List sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const raw = req.query;
      const limit = raw.page_size;
      const page = await core.accessor.get(ISessionIndex).list({
        workspaceId: raw.workspace_id,
        includeArchived: raw.include_archive,
        // Fetch one extra to detect `has_more` (FileSessionIndex does not
        // expose a cursor today).
        limit: limit !== undefined ? limit + 1 : undefined,
      });

      let hasMore = false;
      let summaries = page.items;
      if (limit !== undefined && summaries.length > limit) {
        summaries = summaries.slice(0, limit);
        hasMore = true;
      }

      const workspaces = await core.accessor.get(IWorkspaceRegistry).list();
      const roots = new Map(workspaces.map((w) => [w.id, w.root]));
      const items: Session[] = [];
      for (const summary of summaries) {
        const cwd = roots.get(summary.workspaceId);
        if (cwd === undefined) continue; // gap G3: cannot represent cwd
        items.push(toWireSession(summary, cwd));
      }
      reply.send(okEnvelope({ items, has_more: hasMore }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}',
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get a session by ID',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const summary = await core.accessor.get(ISessionIndex).get(session_id);
      if (summary === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const workspace = await core.accessor.get(IWorkspaceRegistry).get(summary.workspaceId);
      if (workspace === undefined) {
        // gap G3: persisted session whose workspace is not registered → cwd
        // cannot be recovered.
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} workspace missing`,
            req.id,
          ),
        );
        return;
      }
      reply.send(okEnvelope(toWireSession(summary, workspace.root), req.id));
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const getProfileRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/profile',
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get session profile',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const summary = await core.accessor.get(ISessionIndex).get(session_id);
      if (summary === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const workspace = await core.accessor.get(IWorkspaceRegistry).get(summary.workspaceId);
      if (workspace === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} workspace missing`,
            req.id,
          ),
        );
        return;
      }
      reply.send(okEnvelope(toWireSession(summary, workspace.root), req.id));
    },
  );
  app.get(
    getProfileRoute.path,
    getProfileRoute.options,
    getProfileRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const updateProfileRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/profile',
      params: sessionIdParamSchema,
      body: updateSessionProfileRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Update session profile (title only in this slice)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const handle = core.accessor.get(ISessionLifecycleService).get(session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const title = req.body.title;
      if (typeof title === 'string') {
        await handle.accessor.get(ISessionMetadata).setTitle(title);
      }
      const meta = await handle.accessor.get(ISessionMetadata).read();
      const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
      const workspace = await core.accessor.get(IWorkspaceRegistry).get(workspaceId);
      if (workspace === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} workspace missing`,
            req.id,
          ),
        );
        return;
      }
      reply.send(okEnvelope(toWireSession({ ...meta, workspaceId }, workspace.root), req.id));
    },
  );
  app.post(
    updateProfileRoute.path,
    updateProfileRoute.options,
    updateProfileRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const sessionActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{tail}',
      params: sessionActionTailParamSchema,
      success: { data: archiveSessionResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Run a session action (only ::archive is supported in this slice)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { tail } = req.params;
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['archive'] as const,
        resourceLabel: 'session',
      });
      if (parsed.kind !== 'action') {
        const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
        reply.send(buildValidationEnvelope([{ path: 'session_id', message }], req.id));
        return;
      }
      const handle = core.accessor.get(ISessionLifecycleService).get(parsed.id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`, req.id),
        );
        return;
      }
      await core.accessor.get(ISessionLifecycleService).archive(parsed.id);
      reply.send(okEnvelope({ archived: true as const }, req.id));
    },
  );
  app.post(
    sessionActionRoute.path,
    sessionActionRoute.options,
    sessionActionRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const statusRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/status',
      params: sessionIdParamSchema,
      success: { data: sessionStatusResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get realtime session status (best-effort in this slice)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const handle = core.accessor.get(ISessionLifecycleService).get(session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const status = handle.accessor.get(ISessionActivity).status();
      // Rich fields (model / thinking_level / permission / plan_mode /
      // swarm_mode / context_*) require the main agent's scope; not wired yet
      // (gap G10). Return safe defaults for the first slice.
      reply.send(
        okEnvelope(
          {
            status,
            thinking_level: '',
            permission: '',
            plan_mode: false,
            swarm_mode: false,
            context_tokens: 0,
            max_context_tokens: 0,
            context_usage: 0,
          },
          req.id,
        ),
      );
    },
  );
  app.get(
    statusRoute.path,
    statusRoute.options,
    statusRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );
}

// ---------------------------------------------------------------------------
// API body wrapper — pure field projection from a service return value to the
// wire `Session` shape. No service calls, no control flow: handlers pull data
// through `ServiceAccessor.get` and pass it straight here.
// ---------------------------------------------------------------------------

interface SessionWireFields {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
}

function toWireSession(fields: SessionWireFields, cwd: string): Session {
  return {
    id: fields.id,
    workspace_id: fields.workspaceId,
    title: fields.title ?? '',
    created_at: new Date(fields.createdAt).toISOString(),
    updated_at: new Date(fields.updatedAt).toISOString(),
    status: 'idle',
    archived: fields.archived,
    metadata: { cwd },
    agent_config: { model: '' },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

function buildValidationEnvelope(
  details: { path: string; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const first = details[0];
  const msg =
    first === undefined
      ? 'validation failed'
      : first.path === ''
        ? first.message
        : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}
