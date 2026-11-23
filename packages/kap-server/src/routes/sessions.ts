import {
  ErrorCodes,
  IAgentChangeNotifierService,
  IAgentProfileService,
  IAgentFullCompactionService,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPluginService,
  IAgentTaskService,
  IAtomicDocumentStore,
  IAuthSummaryService,
  IBootstrapService,
  IConfigService,
  IPluginService,
  ISessionAgentProfileCatalog,
  ISessionActivityView,
  ISessionBtwService,
  ISessionContext,
  ISessionIndex,
  ISessionMetadata,
  ISessionLegacyService,
  ISessionPromptOptimizerService,
  ISessionTitleService,
  IEventService,
  SessionCreated,
  IWorkspaceAliases,
  ISessionManager,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  closeSessionById,
  followSessionLifecycles,
  getLiveSessionById,
  interactions,
  programForSession,
  resolveSubagentModelPool,
  reloadOnStale,
  resumeSessionById,
  setSessionArchived,
  toDisposable,
  Error2,
  legacySessionMetaScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
  type IAgentScopeHandle,
  type IDisposable,
  type ISessionScopeHandle,
  type Scope,
  type SessionMeta,
  type SessionSummary,
  type SubagentModelPoolSnapshot,
} from '@moonshot-ai/agent-core-v2';
import { ISessionLockService } from '@moonshot-ai/agent-core-v2';
import { SessionMetaUpdated } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { t } from '../i18n';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { detailsSchema, sessionIdParamSchema } from '../protocol/common';
import { ErrorCode } from '../protocol/error-codes';
import { projectGoalStatus } from '../protocol/goal';
import { pageResponseSchema } from '../protocol/pagination';
import { booleanQueryParam } from '../protocol/query-params';
import { type PendingInteraction } from '../protocol/interaction';
import { listPendingInteractions } from '../protocol/interaction-wire';
import {
  archiveSessionResponseSchema,
  cancelSessionRequestSchema,
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  DEFAULT_SESSION_WAIT_TIMEOUT_MS,
  MAX_SESSION_WAIT_TIMEOUT_MS,
  createSessionChildRequestSchema,
  createSessionRequestSchema,
  deleteSessionResponseSchema,
  editSessionGoalRequestSchema,
  editSessionGoalResponseSchema,
  forkSessionRequestSchema,
  getSessionGoalResponseSchema,
  listSessionChildrenResponseSchema,
  optimizePromptSessionRequestSchema,
  optimizePromptSessionResponseSchema,
  sessionAbortResponseSchema,
  sessionCancelResponseSchema,
  sessionWarningsResponseSchema,
  startBtwSessionResponseSchema,
  takeoverSessionResponseSchema,
  undoSessionRequestSchema,
  undoSessionResponseSchema,
  updateSessionProfileRequestSchema,
  waitSessionRequestSchema,
  waitSessionResponseSchema,
} from '../protocol/rest-session';
import {
  emptySessionUsage,
  sessionSchema,
  type Session,
  type SessionPendingInteraction,
} from '../protocol/session';
import { workspaceIdSchema } from '../protocol/workspace';
import type { ConversationService } from '../services/conversation/conversationService';
import { readLegacyStatus } from '../services/legacyStatus/legacyStatus';
import { loadWorkspaceVisibility } from '../services/workspaceVisibility';
import { ensureMainAgent, MAIN_AGENT_ID } from '../transport/mainAgent';
import { type ActionTable, dispatchAction } from './action-dispatch';
import { sendEnvironmentError } from './environment';
import {
  agentConfigErrors,
  applyAgentConfigToSession,
  applySessionAgentConfig,
  creationMainAgentBinding,
} from './sessionAgentConfig';
import { sendMappedError as sendSessionMappedError, sessionConflictErrors } from './sessionErrors';
import { customSessionMetadata, updateSessionProfile } from './sessionProfile';

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
  patch(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown; headers: Record<string, unknown> },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const DEFAULT_SESSION_LIST_PAGE_SIZE = 20;

const sessionsListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    busy: booleanQueryParam,
    include_archive: booleanQueryParam,
    exclude_empty: booleanQueryParam,
    archived_only: booleanQueryParam,
    workspace_id: workspaceIdSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: t('serverErrors.paginationMutuallyExclusive'),
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
    if (value.archived_only === true && value.include_archive === true) {
      ctx.addIssue({
        code: 'custom',
        message: 'archived_only and include_archive are mutually exclusive',
        path: ['archived_only'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  })
  .strict();

const sessionChildrenListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    busy: booleanQueryParam,
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: t('serverErrors.paginationMutuallyExclusive'),
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  })
  .strict();

const sessionActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

const sessionActionRequestSchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z
    .object({
      title: z.string().min(1).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
      turn_index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      instruction: z.string().optional(),
      turn_id: z.string().min(1).optional(),
      agent_id: z.string().min(1).optional(),
      include_background: z.boolean().optional(),
      timeout_ms: z.number().int().min(0).max(MAX_SESSION_WAIT_TIMEOUT_MS).optional(),
      count: z.number().int().positive().optional(),
      page_size: z.number().int().min(1).max(100).optional(),
      text: z.string().optional(),
      recent_turns: z.array(z.string()).optional(),
    })
    .strict(),
);

export function registerSessionsRoutes(
  app: SessionRouteHost,
  core: Scope,
  conversations: ConversationService,
): void {
  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions',
      body: createSessionRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
        ...agentConfigErrors,
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

      const registry = core.accessor.get(IWorkspaceService);
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

      try {
        const touched =
          workspaceId === undefined
            ? await registry.createOrTouch(workDir)
            : await registry.touch(workspaceId);
        if (touched === undefined) {
          throw new Error2(
            ErrorCodes.WORKSPACE_NOT_FOUND,
            `workspace ${workspaceId} does not exist`,
          );
        }
        const custom = customSessionMetadata(body.metadata);
        const agentConfig = body.agent_config ?? {};
        const mainAgentBinding = await creationMainAgentBinding(core, agentConfig);
        const { profile: _profile, model: _model, thinking: _thinking, ...settings } = agentConfig;
        const appliesSettings = Object.keys(settings).some((key) => key !== 'tower_base');
        const handle = await core.accessor.get(ISessionManager).create({
          workspaceId: touched.id,
          workDir,
          environmentId: body.environment_id,
          environmentCwd: body.environment_cwd,
          mainAgentBinding,
          ensureMainAgent: body.environment_id !== undefined && body.environment_id !== 'local',
          prepare: async (session) => {
            if (Object.keys(custom).length > 0) {
              await session.accessor.get(ISessionMetadata).update({ custom });
            }
            if (appliesSettings) await applyAgentConfigToSession(session, settings);
          },
        });
        const metadata = handle.accessor.get(ISessionMetadata);
        if (typeof body.title === 'string') await metadata.setTitle(body.title);
        const meta = await metadata.read();
        const sessionId = meta.id;
        const session = toWireSession(
          { ...meta, workspaceId: touched.id },
          touched.root,
          resolveSessionFacts(core, sessionId),
        );
        core.accessor
          .get(IEventService)
          .publish(
            new SessionCreated({ payload: { agentId: 'main', sessionId: session.id, session } }),
          );
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
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
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.PAGE_TOKEN_MISMATCH]: {},
      },
      description: 'List sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const raw = req.query;
      const archivedOnly = raw.archived_only === true;

      const { roots, visibleWorkspaceIds } = await loadWorkspaceVisibility(core);

      if (raw.workspace_id !== undefined && !roots.has(raw.workspace_id)) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${raw.workspace_id} does not exist`,
            req.id,
          ),
        );
        return;
      }

      const workspaceIds =
        raw.workspace_id === undefined
          ? undefined
          : await core.accessor.get(IWorkspaceAliases).resolveAliasIds(raw.workspace_id);
      const index = core.accessor.get(ISessionIndex);
      const includeArchived = archivedOnly ? true : raw.include_archive;

      if (raw.after_id !== undefined && (await index.get(raw.after_id)) === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.PAGE_TOKEN_MISMATCH,
            t('serverErrors.invalidCursorId', { id: raw.after_id }),
            req.id,
          ),
        );
        return;
      }

      interface Eligible {
        readonly summary: SessionSummary;
        readonly cwd: string;
        readonly facts?: SessionFacts;
      }

      const collect = async (
        pageSize: number,
      ): Promise<{ visible: Eligible[]; hasMore: boolean }> => {
        const wanted = pageSize + 1;
        const collected: Eligible[] = [];
        let before = raw.before_id;
        const after = raw.after_id;
        const afterCursor = after !== undefined ? await index.get(after) : undefined;
        const newerThanCursor = (summary: SessionSummary): boolean =>
          afterCursor === undefined ||
          summary.updatedAt > afterCursor.updatedAt ||
          (summary.updatedAt === afterCursor.updatedAt && summary.id > afterCursor.id);
        while (collected.length < wanted) {
          const page = await index.listRecent({
            workspaceIds,
            includeArchived,
            limit: wanted - collected.length,
            before,
            after: before === undefined ? after : undefined,
          });
          if (page.items.length === 0) break;
          let exhausted = false;
          for (const summary of page.items) {
            if (!visibleWorkspaceIds.has(summary.workspaceId)) continue;
            if (!newerThanCursor(summary)) {
              exhausted = true;
              break;
            }
            const cwd = summary.cwd ?? roots.get(summary.workspaceId);
            if (cwd === undefined) continue;
            if (raw.exclude_empty === true && (summary.lastPrompt ?? '').length === 0) continue;
            if (archivedOnly && !summary.archived) continue;
            const facts = resolveSessionFacts(core, summary.id);
            if (raw.busy !== undefined && facts.busy !== raw.busy) continue;
            collected.push({ summary, cwd, facts });
          }
          if (exhausted || page.nextCursor === undefined) break;
          before = page.nextCursor;
        }
        return { visible: collected.slice(0, pageSize), hasMore: collected.length > pageSize };
      };

      if (!archivedOnly && raw.page_size === undefined) {
        const page = await index.listRecent({
          workspaceIds,
          includeArchived,
          before: raw.before_id,
          after: raw.after_id,
        });
        const eligible: Eligible[] = [];
        for (const summary of page.items) {
          if (!visibleWorkspaceIds.has(summary.workspaceId)) continue;
          const cwd = summary.cwd ?? roots.get(summary.workspaceId);
          if (cwd === undefined) continue;
          if (raw.exclude_empty === true && (summary.lastPrompt ?? '').length === 0) continue;
          eligible.push({ summary, cwd });
        }
        const projected = eligible.map(({ summary, cwd }) =>
          toWireSession(summary, cwd, resolveSessionFacts(core, summary.id)),
        );
        const items =
          raw.busy !== undefined
            ? projected.filter((session) => session.busy === raw.busy)
            : projected;
        reply.send(okEnvelope({ items, has_more: false }, req.id));
        return;
      }

      const pageSize = raw.page_size ?? DEFAULT_SESSION_LIST_PAGE_SIZE;
      const { visible, hasMore } = await collect(pageSize);
      const items = visible.map(({ summary, cwd, facts }) =>
        toWireSession(summary, cwd, facts ?? resolveSessionFacts(core, summary.id)),
      );
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
        [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
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
      const cwd =
        summary.cwd ?? (await core.accessor.get(IWorkspaceService).get(summary.workspaceId))?.root;
      if (cwd === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} has no recoverable cwd`,
            req.id,
          ),
        );
        return;
      }
      reply.send(
        okEnvelope(toWireSession(summary, cwd, resolveSessionFacts(core, session_id)), req.id),
      );
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
      const cwd =
        summary.cwd ?? (await core.accessor.get(IWorkspaceService).get(summary.workspaceId))?.root;
      if (cwd === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} has no recoverable cwd`,
            req.id,
          ),
        );
        return;
      }
      reply.send(
        okEnvelope(toWireSession(summary, cwd, resolveSessionFacts(core, session_id)), req.id),
      );
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
        [ErrorCode.TOWER_MODE_INVALID]: {},
        ...agentConfigErrors,
        ...sessionConflictErrors,
      },
      description: 'Update session profile (title, metadata, agent_config)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const { agent_config, ...profileBody } = req.body;
        const fields = await updateSessionProfile(core, session_id, profileBody);
        if (agent_config !== undefined) {
          await applySessionAgentConfig(core, session_id, agent_config);
        }
        const session = toWireSession(fields, fields.root, resolveSessionFacts(core, fields.id));
        if (typeof req.body.title === 'string' && req.body.title.trim().length > 0) {
          core.accessor.get(IEventService).publish(
            new SessionMetaUpdated({
              payload: {
                agentId: 'main',
                sessionId: session_id,
                title: session.title,
                patch: { title: session.title, isCustomTitle: true },
              },
            }),
          );
        }
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    updateProfileRoute.path,
    updateProfileRoute.options,
    updateProfileRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const generateTitleRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/title/generate',
      params: sessionIdParamSchema,
      body: z.preprocess(
        (value) => (value === undefined ? {} : value),
        z.strictObject({
          force: z.boolean().optional(),
          source: z.enum(['user_prompts', 'first_turn', 'digest']).optional(),
        }),
      ),
      success: { data: z.object({ title: z.string() }) },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_TITLE_UNAVAILABLE]: {},
        ...sessionConflictErrors,
      },
      description: 'Generate the session title via the managed chat_title tool',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const handle = await resumeSessionById(core.accessor, session_id);
        if (handle === undefined) {
          reply.send(
            errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} not found`, req.id),
          );
          return;
        }
        const title = await handle.accessor
          .get(ISessionTitleService)
          .generateTitle({ force: req.body.force === true, source: req.body.source });
        if (title === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.SESSION_TITLE_UNAVAILABLE,
              'session title generation is unavailable (no managed OAuth login, no prompt yet, or the backend request failed)',
              req.id,
            ),
          );
          return;
        }
        reply.send(okEnvelope({ title }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    generateTitleRoute.path,
    generateTitleRoute.options,
    generateTitleRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const sessionActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{tail}',
      params: sessionActionTailParamSchema,
      body: sessionActionRequestSchema,
      success: {
        data: z.union([
          sessionSchema,
          compactSessionResponseSchema,
          undoSessionResponseSchema,
          sessionAbortResponseSchema,
          sessionCancelResponseSchema,
          startBtwSessionResponseSchema,
          optimizePromptSessionResponseSchema,
          archiveSessionResponseSchema,
          deleteSessionResponseSchema,
          takeoverSessionResponseSchema,
          waitSessionResponseSchema,
        ]),
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        ...sessionConflictErrors,
        [ErrorCode.COMPACTION_UNABLE]: {},
        [ErrorCode.SESSION_UNDO_UNAVAILABLE]: {},
        [ErrorCode.TURN_NOT_FOUND]: {},
        [ErrorCode.PROMPT_OPTIMIZER_BUSY]: {},
        [ErrorCode.PROMPT_OPTIMIZER_DISABLED]: {},
        [ErrorCode.PROMPT_OPTIMIZER_EMPTY_DRAFT]: {},
        [ErrorCode.PROMPT_OPTIMIZER_INPUT_TOO_LONG]: {},
        [ErrorCode.PROMPT_OPTIMIZER_NO_OUTPUT]: {},
        [ErrorCode.PROMPT_OPTIMIZER_OUTPUT_TOO_LONG]: {},
        [ErrorCode.PROMPT_OPTIMIZER_TIMEOUT]: {},
      },
      description: 'Run a session action',
      tags: ['sessions'],
      operationId: 'runSessionAction',
    },
    async (req, reply) => {
      try {
        await dispatchAction({
          tail: req.params.tail,
          actions: sessionActions,
          resourceLabel: 'session',
          extra: { core, conversations, req, reply },
          body: req.body,
          onUnsupported: (message) => {
            reply.send(buildValidationEnvelope([{ path: 'session_id', message }], req.id));
          },
        });
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    sessionActionRoute.path,
    sessionActionRoute.options,
    sessionActionRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const listChildrenRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/children',
      params: sessionIdParamSchema,
      querystring: sessionChildrenListQueryCoercion,
      success: { data: listSessionChildrenResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List child sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const exists =
          getLiveSessionById(core.accessor, session_id) !== undefined ||
          (await core.accessor.get(ISessionIndex).get(session_id)) !== undefined;
        if (!exists) {
          throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} does not exist`);
        }

        const pageSize = req.query.page_size ?? 100;
        const wanted = pageSize + 1;
        const matched: SessionSummary[] = [];
        let before = req.query.before_id;
        while (matched.length < wanted) {
          const page = await core.accessor.get(ISessionIndex).listRecent({
            childOf: session_id,
            before,
            after: before === undefined ? req.query.after_id : undefined,
            limit: wanted - matched.length,
          });
          if (page.items.length === 0) break;
          for (const summary of page.items) {
            const { busy } = resolveSessionFacts(core, summary.id);
            if (req.query.busy !== undefined && busy !== req.query.busy) continue;
            matched.push(summary);
          }
          if (page.nextCursor === undefined) break;
          before = page.nextCursor;
        }

        const roots = new Map(
          (await core.accessor.get(IWorkspaceService).list()).map((w) => [w.id, w.root]),
        );
        const items = matched
          .slice(0, pageSize)
          .map((summary) =>
            toWireSession(
              summary,
              summary.cwd ?? roots.get(summary.workspaceId) ?? '',
              resolveSessionFacts(core, summary.id),
            ),
          );
        reply.send(okEnvelope({ items, has_more: matched.length > pageSize }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    listChildrenRoute.path,
    listChildrenRoute.options,
    listChildrenRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const createChildRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/children',
      params: sessionIdParamSchema,
      body: createSessionChildRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        ...sessionConflictErrors,
      },
      description: 'Create a child session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const lease = await programForSession(core.accessor, session_id);
        if (lease === undefined) {
          throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} does not exist`);
        }
        try {
          const meta = await core.accessor.get(ISessionManager).createChild({
            sourceSessionId: session_id,
            title: req.body.title,
            metadata: req.body.metadata,
          });
          const session = toWireSession(
            { ...meta, workspaceId: lease.instance.program.workspaceId },
            meta.cwd ?? '',
            resolveSessionFacts(core, meta.id),
          );
          core.accessor
            .get(IEventService)
            .publish(
              new SessionCreated({ payload: { agentId: 'main', sessionId: session.id, session } }),
            );
          reply.send(okEnvelope(session, req.id));
        } finally {
          lease.dispose();
        }
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.post(
    createChildRoute.path,
    createChildRoute.options,
    createChildRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const goalRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/goal',
      params: sessionIdParamSchema,
      success: { data: getSessionGoalResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get the current session goal (null when none is active)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const goal = await core.accessor.get(ISessionLegacyService).goal(session_id);
        reply.send(
          okEnvelope(
            goal === null ? null : { ...goal, status: projectGoalStatus(goal.status) },
            req.id,
          ),
        );
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    goalRoute.path,
    goalRoute.options,
    goalRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const editGoalRoute = defineRoute(
    {
      method: 'PATCH',
      path: '/sessions/{session_id}/goal',
      params: sessionIdParamSchema,
      body: editSessionGoalRequestSchema,
      success: { data: editSessionGoalResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.GOAL_NOT_FOUND]: {},
        [ErrorCode.GOAL_STATUS_INVALID]: {},
        [ErrorCode.GOAL_OBJECTIVE_EMPTY]: {},
        [ErrorCode.GOAL_OBJECTIVE_TOO_LONG]: {},
      },
      description: 'Edit the objective of the current session goal in place',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const session = await resumeSessionById(core.accessor, session_id);
        if (session === undefined) {
          throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} does not exist`);
        }
        const agent = await ensureMainAgent(session);
        const goal = await agent.accessor
          .get(IAgentGoalService)
          .editGoalObjective({ objective: req.body.objective });
        reply.send(
          okEnvelope(
            goal === null ? null : { ...goal, status: projectGoalStatus(goal.status) },
            req.id,
          ),
        );
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.patch(
    editGoalRoute.path,
    editGoalRoute.options,
    editGoalRoute.handler as Parameters<SessionRouteHost['patch']>[2],
  );

  const sessionWarningsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/warnings',
      params: sessionIdParamSchema,
      success: { data: sessionWarningsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get session-level warnings (e.g. oversized AGENTS.md)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const session = await resumeSessionById(core.accessor, session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      try {
        const agent = await ensureMainAgent(session);
        const agentsMdWarning = agent.accessor.get(IAgentProfileService).getAgentsMdWarning();
        const warnings =
          agentsMdWarning === undefined
            ? []
            : [
                {
                  code: 'agents-md-oversized',
                  message: agentsMdWarning,
                  severity: 'warning' as const,
                },
              ];
        reply.send(okEnvelope({ warnings }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    sessionWarningsRoute.path,
    sessionWarningsRoute.options,
    sessionWarningsRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );
}

type SessionAction =
  | 'fork'
  | 'compact'
  | 'undo'
  | 'abort'
  | 'cancel'
  | 'wait'
  | 'btw'
  | 'optimize'
  | 'restore'
  | 'archive'
  | 'delete'
  | 'reload'
  | 'takeover';

interface SessionActionExtra {
  readonly core: Scope;
  readonly conversations: ConversationService;
  readonly req: { readonly id: string };
  readonly reply: { readonly send: (payload: unknown) => unknown };
}

interface DisconnectObservableReply {
  readonly raw?: {
    readonly writableFinished?: boolean;
    readonly destroyed?: boolean;
    once(event: 'close', listener: () => void): unknown;
    off(event: 'close', listener: () => void): unknown;
  };
}

type SessionActionCtx<TBody = unknown> = SessionActionExtra & {
  readonly id: string;
  readonly body: TBody;
};

const sessionActions: ActionTable<SessionAction, SessionActionExtra> = {
  fork: { body: forkSessionRequestSchema, handle: forkSessionAction },
  compact: { body: compactSessionRequestSchema, handle: compactSessionAction },
  undo: { body: undoSessionRequestSchema, handle: undoSessionAction },
  abort: { handle: abortSessionAction },
  cancel: { body: cancelSessionRequestSchema, handle: cancelSessionAction },
  wait: { body: waitSessionRequestSchema, handle: waitSessionAction },
  btw: { handle: btwSessionAction },
  optimize: { body: optimizePromptSessionRequestSchema, handle: optimizePromptSessionAction },
  restore: { handle: restoreSessionAction },
  archive: { handle: archiveSessionAction },
  delete: { handle: deleteSessionAction },
  reload: { handle: reloadSessionAction },
  takeover: { handle: takeoverSessionAction },
};

async function forkSessionAction(
  ctx: SessionActionCtx<z.infer<typeof forkSessionRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body } = ctx;
  const lease = await programForSession(core.accessor, id);
  if (lease === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  try {
    const meta = await core.accessor.get(ISessionManager).fork({
      sourceSessionId: id,
      title: body.title,
      metadata: body.metadata,
      turnIndex: body.turn_index,
    });
    const session = toWireSession(
      { ...meta, workspaceId: lease.instance.program.workspaceId },
      meta.cwd ?? '',
      resolveSessionFacts(core, meta.id),
    );
    core.accessor
      .get(IEventService)
      .publish(
        new SessionCreated({ payload: { agentId: 'main', sessionId: session.id, session } }),
      );
    requestLog(req)?.info(
      { session_id: id, action: 'fork', new_session_id: session.id },
      'session action completed',
    );
    reply.send(okEnvelope(session, req.id));
  } finally {
    lease.dispose();
  }
}

async function compactSessionAction(
  ctx: SessionActionCtx<z.infer<typeof compactSessionRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body } = ctx;
  await reloadOnStale(core.accessor, id, async () => {
    const agent = await resolveMainAgent(core, id);
    const started = agent.accessor
      .get(IAgentFullCompactionService)
      .begin({ source: 'manual', instruction: normalizeOptional(body.instruction) });
    if (!started) {
      throw new Error2(
        ErrorCodes.COMPACTION_UNABLE,
        'A compaction is already running. Wait for it to finish, then retry.',
      );
    }
  });
  requestLog(req)?.info({ session_id: id, action: 'compact' }, 'session action completed');
  reply.send(okEnvelope({}, req.id));
}

async function undoSessionAction(
  ctx: SessionActionCtx<z.infer<typeof undoSessionRequestSchema>>,
): Promise<void> {
  const { core, conversations, req, reply, id, body } = ctx;
  const removed = await reloadOnStale(
    core.accessor,
    id,
    async () => (await conversations.feed(id, body.agent_id ?? MAIN_AGENT_ID)).undo(body.turn_id),
    { retry: false },
  );
  requestLog(req)?.info({ session_id: id, action: 'undo' }, 'session action completed');
  reply.send(okEnvelope({ removed_turn_ids: removed }, req.id));
}

async function abortSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  const agent = await resolveMainAgent(core, id);
  agent.accessor.get(IAgentLoopService).cancel();
  requestLog(req)?.info({ session_id: id, action: 'abort' }, 'session action completed');
  reply.send(okEnvelope({ aborted: true }, req.id));
}

async function cancelSessionAction(
  ctx: SessionActionCtx<z.infer<typeof cancelSessionRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body } = ctx;
  const targetAgentId = body.agent_id ?? MAIN_AGENT_ID;
  let live = getLiveSessionById(core.accessor, id);
  if (live === undefined) {
    try {
      await core.accessor.get(ISessionManager).whenResumeSettled(id);
    } catch {}
    live = getLiveSessionById(core.accessor, id);
  }
  if (live === undefined) {
    const summary = await core.accessor.get(ISessionIndex).get(id);
    if (summary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
    }
    if (targetAgentId !== MAIN_AGENT_ID) {
      const docs = core.accessor.get(IAtomicDocumentStore);
      const metaScope = sessionScopeOf(
        workspacePersistenceScope(
          core.accessor.get(IBootstrapService).scope('sessions'),
          summary.workspaceId,
        ),
        id,
      );
      const raw =
        (await docs.get<SessionMeta>(metaScope, 'state.json')) ??
        (await docs.get<SessionMeta>(legacySessionMetaScopeOf(metaScope), 'state.json'));
      if (raw?.agents?.[targetAgentId] === undefined) {
        throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `agent ${targetAgentId} does not exist`);
      }
    }
    requestLog(req)?.info(
      { session_id: id, action: 'cancel', cancelled: false },
      'session action completed',
    );
    reply.send(okEnvelope({ cancelled: false }, req.id));
    return;
  }

  const lifecycle = live.accessor.get(IAgentLifecycleService);
  const agent = lifecycle.handleOf(targetAgentId);
  if (targetAgentId !== MAIN_AGENT_ID && agent === undefined) {
    const persisted = (await live.accessor.get(ISessionMetadata).read()).agents?.[targetAgentId];
    if (persisted === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `agent ${targetAgentId} does not exist`);
    }
    requestLog(req)?.info(
      {
        session_id: id,
        action: 'cancel',
        agent_id: targetAgentId,
        include_background: body.include_background === true,
        cancelled: false,
      },
      'session action completed',
    );
    reply.send(okEnvelope({ cancelled: false }, req.id));
    return;
  }

  let cancelled = agent !== undefined ? agent.accessor.get(IAgentLoopService).cancel() : false;
  if (body.include_background === true) {
    const handles: IAgentScopeHandle[] = [];
    if (body.agent_id !== undefined) {
      if (agent !== undefined) handles.push(agent);
    } else {
      for (const context of lifecycle.list()) {
        const handle = lifecycle.handleOf(context.agentId);
        if (handle !== undefined) handles.push(handle);
      }
    }
    for (const handle of handles) {
      const taskService = handle.accessor.get(IAgentTaskService);
      for (const task of taskService.list(true)) {
        if (task.detached) {
          await taskService.stopByUser(task.taskId);
          cancelled = true;
        }
      }
    }
  }

  requestLog(req)?.info(
    {
      session_id: id,
      action: 'cancel',
      agent_id: targetAgentId,
      include_background: body.include_background === true,
      cancelled,
    },
    'session action completed',
  );
  reply.send(okEnvelope({ cancelled }, req.id));
}

async function readWaitSnapshot(
  core: Scope,
  id: string,
): Promise<{
  session: Session;
  pendingInteractions: PendingInteraction[];
  settled: boolean;
  live: ISessionScopeHandle | undefined;
}> {
  const live = getLiveSessionById(core.accessor, id);
  const pendingInteractions = listPendingInteractions(id);
  let baseSession: Session;
  if (live !== undefined) {
    const meta = await live.accessor.get(ISessionMetadata).read();
    const context = live.accessor.get(ISessionContext);
    baseSession = toWireSession(
      { ...meta, workspaceId: context.workspaceId },
      context.cwd,
      resolveSessionFacts(core, id),
    );
  } else {
    const summary = await core.accessor.get(ISessionIndex).get(id);
    if (summary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
    }
    const cwd =
      summary.cwd ?? (await core.accessor.get(IWorkspaceService).get(summary.workspaceId))?.root;
    if (cwd === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} has no recoverable cwd`);
    }
    baseSession = toWireSession(summary, cwd, resolveSessionFacts(core, id));
  }
  const session =
    pendingInteractions.length > 0 && baseSession.pending_interaction === 'none'
      ? { ...baseSession, pending_interaction: pendingInteractions[0]!.kind }
      : baseSession;
  const settled =
    session.activity !== 'turn' ||
    session.pending_interaction !== 'none' ||
    pendingInteractions.length > 0;
  return { session, pendingInteractions, settled, live };
}

async function waitSessionAction(
  ctx: SessionActionCtx<z.infer<typeof waitSessionRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body } = ctx;
  const timeoutMs = body.timeout_ms ?? DEFAULT_SESSION_WAIT_TIMEOUT_MS;
  const initial = await readWaitSnapshot(core, id);
  if (initial.settled) {
    reply.send(
      okEnvelope(
        {
          session: initial.session,
          pending_interactions: initial.pendingInteractions,
          timed_out: false,
        },
        req.id,
      ),
    );
    return;
  }
  if (timeoutMs === 0 || initial.live === undefined) {
    reply.send(
      okEnvelope(
        {
          session: initial.session,
          pending_interactions: initial.pendingInteractions,
          timed_out: initial.live !== undefined,
        },
        req.id,
      ),
    );
    return;
  }

  const liveHandle = initial.live;
  const raw = (reply as unknown as DisconnectObservableReply).raw;
  const outcome = await new Promise<'settled' | 'timeout' | 'aborted'>((resolve) => {
    let done = false;
    const disposables: IDisposable[] = [];
    const onClose = (): void => {
      if (raw?.writableFinished === true) return;
      finish('aborted');
    };
    const finish = (result: 'settled' | 'timeout' | 'aborted'): void => {
      if (done) return;
      done = true;
      raw?.off('close', onClose);
      for (const disposable of disposables.splice(0)) disposable.dispose();
      resolve(result);
    };

    raw?.once('close', onClose);
    if (raw?.destroyed === true && !raw.writableFinished) {
      finish('aborted');
      return;
    }

    try {
      disposables.push(
        liveHandle.accessor.get(ISessionActivityView).onDidChange(({ state }) => {
          if (!state.mainTurnActive || state.pendingInteraction !== 'none') {
            finish('settled');
          }
        }),
      );
    } catch {
      finish('settled');
      return;
    }

    disposables.push(
      toDisposable(
        interactions.onDidChangePending(() => {
          if (listPendingInteractions(id).length > 0) {
            finish('settled');
          }
        }),
      ),
      followSessionLifecycles(core.accessor, (service) => {
        const closeSub = service.onDidCloseSession((event) => {
          if (event.sessionId === id) finish('settled');
        });
        const archiveSub = service.onDidArchiveSession((event) => {
          if (event.sessionId === id) finish('settled');
        });
        return {
          dispose: () => {
            closeSub.dispose();
            archiveSub.dispose();
          },
        };
      }),
    );
    const deleteSub = core.accessor.get(ISessionManager).onWillDeleteSession?.((event) => {
      if (event.sessionId === id) finish('settled');
    });
    if (deleteSub !== undefined) disposables.push(deleteSub);

    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    disposables.push(toDisposable(() => clearTimeout(timer)));

    const recheck = resolveSessionFacts(core, id);
    if (
      !recheck.mainTurnActive ||
      recheck.pendingInteraction !== 'none' ||
      listPendingInteractions(id).length > 0
    ) {
      finish('settled');
    }
  });

  if (outcome === 'aborted') {
    return;
  }

  const after = await readWaitSnapshot(core, id);
  reply.send(
    okEnvelope(
      {
        session: after.session,
        pending_interactions: after.pendingInteractions,
        timed_out: outcome === 'timeout' && !after.settled,
      },
      req.id,
    ),
  );
}

async function btwSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  const session = await resumeSessionById(core.accessor, id);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  const agent = await ensureMainAgent(session);
  const sessionModel = agent.accessor.get(IAgentProfileService).getModel();
  await core.accessor.get(IAuthSummaryService).ensureReady(sessionModel || undefined);
  const agentId = await session.accessor.get(ISessionBtwService).start();
  reply.send(okEnvelope({ agent_id: agentId }, req.id));
}

async function optimizePromptSessionAction(
  ctx: SessionActionCtx<z.infer<typeof optimizePromptSessionRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body } = ctx;
  const session = await resumeSessionById(core.accessor, id);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  await ensureMainAgent(session);
  const abort = new AbortController();
  const raw = (reply as unknown as DisconnectObservableReply).raw;
  const onClose = (): void => {
    if (raw?.writableFinished === true) return;
    abort.abort();
  };
  raw?.once('close', onClose);
  try {
    const prompt = await session.accessor.get(ISessionPromptOptimizerService).optimize(
      body.text,
      {
        cwd: session.accessor.get(ISessionContext).cwd,
        recentTurns: body.recent_turns,
        sessionKey: id,
        timeoutMs: body.timeout_ms,
        thinking: body.thinking,
      },
      abort.signal,
    );
    requestLog(req)?.info({ session_id: id, action: 'optimize' }, 'session action completed');
    reply.send(okEnvelope({ prompt }, req.id));
  } finally {
    raw?.off('close', onClose);
  }
}

async function restoreSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  const restored = await core.accessor.get(ISessionManager).restore(id);
  if (restored === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  const meta = await restored.accessor.get(ISessionMetadata).read();
  const sessionCtx = restored.accessor.get(ISessionContext);
  const session = toWireSession(
    { ...meta, workspaceId: sessionCtx.workspaceId },
    sessionCtx.cwd,
    resolveSessionFacts(core, meta.id),
  );
  requestLog(req)?.info({ session_id: id, action: 'restore' }, 'session action completed');
  reply.send(okEnvelope(session, req.id));
}

async function archiveSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  const summary = await core.accessor.get(ISessionManager).status(id);
  if (summary === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  await setSessionArchived(core.accessor, id, true);
  requestLog(req)?.info({ session_id: id, action: 'archive' }, 'session action completed');
  reply.send(okEnvelope({ archived: true }, req.id));
}

async function takeoverSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  const summary = await core.accessor.get(ISessionManager).status(id);
  if (summary === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  core.accessor.get(ISessionLockService).takeover(id);
  requestLog(req)?.info({ session_id: id, action: 'takeover' }, 'session action completed');
  reply.send(okEnvelope({ taken_over: true }, req.id));
}

async function deleteSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  await core.accessor.get(ISessionManager).delete(id);
  requestLog(req)?.info({ session_id: id, action: 'delete' }, 'session action completed');
  reply.send(okEnvelope({ deleted: true }, req.id));
}

async function reloadSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, req, reply, id } = ctx;
  const live = getLiveSessionById(core.accessor, id);
  const indexEntry =
    live === undefined ? await core.accessor.get(ISessionIndex).get(id) : undefined;
  if (live !== undefined) {
    const agentLifecycle = live.accessor.get(IAgentLifecycleService);
    for (const agent of agentLifecycle.list()) {
      const agentHandle = agentLifecycle.handleOf(agent.agentId);
      if (agentHandle === undefined) continue;
      if (agentHandle.accessor.get(IAgentLoopService).snapshot().state === 'running') {
        throw new Error2(
          ErrorCodes.SESSION_BUSY,
          `Session "${id}" cannot be reloaded while a turn is running`,
          { details: { sessionId: id } },
        );
      }
      if (agentHandle.accessor.get(IAgentFullCompactionService).compacting !== null) {
        throw new Error2(
          ErrorCodes.SESSION_BUSY,
          `Session "${id}" cannot be reloaded while compaction is running`,
          { details: { sessionId: id } },
        );
      }
    }
  } else if (indexEntry === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  const workspaceId = live?.accessor.get(ISessionContext).workspaceId ?? indexEntry?.workspaceId;
  let previousSubagentNames: readonly string[] | undefined;
  let previousModelPool: SubagentModelPoolSnapshot | null | undefined;
  let staleNotifier: IAgentChangeNotifierService | undefined;
  if (live !== undefined) {
    const main = live.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
    if (main !== undefined) {
      previousSubagentNames = main.accessor
        .get(ISessionAgentProfileCatalog)
        .list()
        .map((profile) => profile.name);
      const pool = resolveSubagentModelPool(main.accessor.get(IConfigService));
      previousModelPool =
        pool === undefined ? null : { defaultModel: pool.defaultModel, models: { ...pool.models } };
      staleNotifier = main.accessor.get(IAgentChangeNotifierService);
      staleNotifier.mute();
    }
  }
  try {
    await core.accessor.get(IConfigService).reload();
    await core.accessor.get(IPluginService).reloadPlugins();
    await refreshWorkspaceCatalogs(core, workspaceId, id);
  } catch (error) {
    if (staleNotifier !== undefined) {
      staleNotifier.unmute();
      await Promise.all([
        staleNotifier.notifyAgentsMdChanges(),
        staleNotifier.notifySkillChanges(),
        staleNotifier.notifySubagentChanges({}),
        staleNotifier.notifyWorkspaceDirsChanges(),
      ]).catch(() => undefined);
    }
    throw error;
  }
  if (live !== undefined) {
    await closeSessionById(core.accessor, id);
  }
  const handle = await resumeSessionById(core.accessor, id);
  if (handle === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  const main = handle.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
  await main?.accessor.get(IAgentPluginService).refreshSessionStart();
  if (main !== undefined) {
    const notifier = main.accessor.get(IAgentChangeNotifierService);
    await notifier.notifyAgentsMdChanges();
    await notifier.notifySkillChanges();
    await notifier.notifySubagentChanges({ previousSubagentNames, previousModelPool });
    await notifier.notifyWorkspaceDirsChanges();
  }
  const meta = await handle.accessor.get(ISessionMetadata).read();
  const sessionCtx = handle.accessor.get(ISessionContext);
  const session = toWireSession(
    { ...meta, workspaceId: sessionCtx.workspaceId },
    sessionCtx.cwd,
    resolveSessionFacts(core, meta.id),
  );
  requestLog(req)?.info({ session_id: id, action: 'reload' }, 'session action completed');
  reply.send(okEnvelope(session, req.id));
}

async function refreshWorkspaceCatalogs(
  core: Scope,
  workspaceId: string | undefined,
  excludedSessionId: string,
): Promise<void> {
  if (workspaceId !== undefined) {
    const target = core.accessor.get(IWorkspaceInstanceManager).get(workspaceId);
    if (target !== undefined) {
      await target.program.reload();
    }
  }
  const sessions = core.accessor.get(ISessionManager).list();
  await Promise.all(
    sessions.map(async (session) => {
      if (session.id === excludedSessionId) return;
      const main = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
      if (main === undefined) return;
      await main.accessor.get(IAgentPluginService).refreshSessionStart();
    }),
  );
}

export interface SessionWireFields {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly archivedAt?: number;
  readonly custom?: Record<string, unknown>;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export function toWireSession(
  fields: SessionWireFields,
  cwd: string,
  facts: SessionFacts,
  _git?: unknown,
): Session {
  const lastTurnReason =
    facts.lastTurnReason ?? (facts.live === false ? fields.lastTurnReason : undefined);
  return {
    id: fields.id,
    workspace_id: fields.workspaceId,
    title: fields.title ?? '',
    created_at: new Date(fields.createdAt).toISOString(),
    updated_at: new Date(fields.updatedAt).toISOString(),
    archived_at:
      fields.archivedAt === undefined ? undefined : new Date(fields.archivedAt).toISOString(),
    busy: facts.busy,
    activity: facts.mainTurnActive ? 'turn' : facts.busy ? 'background' : 'idle',
    main_turn_active: facts.mainTurnActive,
    pending_interaction: facts.pendingInteraction,
    last_turn_reason: lastTurnReason,
    last_turn_outcome:
      lastTurnReason === 'cancelled' ? 'interrupted' : lastTurnReason,
    archived: fields.archived,
    last_prompt: fields.lastPrompt,
    metadata: buildWireMetadata(fields.custom, cwd),
    agent_config: { model: facts.model ?? '' },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
  };
}

export interface SessionFacts {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
  readonly live?: boolean;
  readonly model?: string;
}

export function resolveSessionFacts(core: Scope, sessionId: string): SessionFacts {
  const handle = getLiveSessionById(core.accessor, sessionId);
  if (handle === undefined) {
    return {
      busy: false,
      mainTurnActive: false,
      pendingInteraction: 'none',
      live: false,
    };
  }
  return {
    ...handle.accessor.get(ISessionActivityView).state(),
    live: true,
    model: readLiveSessionModel(handle),
  };
}

function readLiveSessionModel(session: ISessionScopeHandle): string | undefined {
  const main = session.accessor.get(IAgentLifecycleService).handleOf(MAIN_AGENT_ID);
  if (main === undefined) return undefined;
  return readLegacyStatus(main)?.model;
}

async function resolveMainAgent(core: Scope, sessionId: string): Promise<IAgentScopeHandle> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  return ensureMainAgent(session);
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function buildWireMetadata(
  custom: Record<string, unknown> | undefined,
  cwd: string,
): { cwd: string; [key: string]: unknown } {
  if (custom === undefined) return { cwd };
  const { goal: _drop, ...rest } = custom as { goal?: unknown; [key: string]: unknown };
  return { ...rest, cwd };
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

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  req: { id: string },
  error: unknown,
): void {
  if (sendEnvironmentError(reply, req.id, error)) return;
  sendSessionMappedError(reply, req, error);
}
