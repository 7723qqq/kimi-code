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
  ISessionActivityView,
  ISessionBtwService,
  ISessionContext,
  ISessionIndex,
  ISessionMetadata,
  ISessionLegacyService,
  ISessionRunGate,
  ISessionPromptOptimizerService,
  ISessionPromptPredictionService,
  ISessionTitleService,
  IEventService,
  SessionCreated,
  ISessionManager,
  IProjectInstanceManager,
  IProjectService,
  LOCAL_ENVIRONMENT_ID,
  closeSessionById,
  followSessionLifecycles,
  getLiveSessionById,
  interactions,
  programForSession,
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
  wrapSystemReminder,
} from '@moonshot-ai/agent-core-v2';
import { ISessionLockService } from '@moonshot-ai/agent-core-v2';
import { historyEntryFromContext } from '@moonshot-ai/agent-core-v2/agent/loop/history';
import { SessionMetaUpdated } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { t } from '../i18n';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { detailsSchema, sessionIdParamSchema } from '../protocol/common';
import { ErrorCode } from '../protocol/error-codes';
import { projectGoalStatus } from '../protocol/goal';
import { booleanQueryParam } from '../protocol/query-params';
import { type PendingInteraction } from '../protocol/interaction';
import { listPendingInteractions } from '../protocol/interaction-wire';
import {
  archiveSessionResponseSchema,
  cancelPromptPredictionRequestSchema,
  cancelPromptPredictionResponseSchema,
  cancelSessionRequestSchema,
  compactSessionRequestSchema,
  sessionContinueResponseSchema,
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
  predictPromptRequestSchema,
  predictPromptResponseSchema,
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
  type SessionCreate,
  type SessionGit,
  type SessionPendingInteraction,
} from '../protocol/session';
import type { ConversationService } from '../services/conversation/conversationService';
import { readLegacyStatus } from '../services/legacyStatus/legacyStatus';
import { workspaceRootOf } from '../services/workspaceVisibility';
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
import { hostGet, HostSourceError, type HostSources } from '../services/hosts/hostFanout';

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
      prediction_id: z.string().min(1).optional(),
      expected_turn_id: z.number().int().nonnegative().optional(),
      reason: cancelPromptPredictionRequestSchema.shape.reason,
    })
    .strict(),
);

const getSessionQuerySchema = z
  .object({ hosts: z.literal('include').optional() })
  .strict();

async function loadSessionSummary(
  core: Scope,
  sessionId: string,
): Promise<SessionSummary | undefined> {
  const indexed = await core.accessor.get(ISessionIndex).get(sessionId);
  if (indexed !== undefined) return indexed;
  const handle =
    getLiveSessionById(core.accessor, sessionId) ??
    (await resumeSessionById(core.accessor, sessionId));
  if (handle === undefined) return undefined;
  const meta = await handle.accessor.get(ISessionMetadata).read();
  const context = handle.accessor.get(ISessionContext);
  return {
    id: meta.id,
    workspaceId: context.workspaceId,
    cwd: meta.cwd ?? context.cwd,
    environmentId: meta.environmentId,
    environmentCwd: meta.environmentCwd,
    title: meta.title,
    lastPrompt: meta.lastPrompt,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    archived: meta.archived,
    archivedAt: meta.archivedAt,
    custom: meta.custom,
    lastTurnReason: meta.lastTurnReason,
  };
}

export function registerSessionsRoutes(
  app: SessionRouteHost,
  core: Scope,
  conversations: ConversationService,
  hosts?: HostSources,
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
      const requestedRoots = requestedWorkspaceRoots(body);
      const requestedRoot = requestedRoots.at(-1);
      const conflictingRoot = requestedRoots.find((root) => root.value !== requestedRoot?.value);
      if (requestedRoot !== undefined && conflictingRoot !== undefined) {
        reply.send(
          buildValidationEnvelope(
            [
              {
                path: conflictingRoot.path,
                message: `${conflictingRoot.path} (${conflictingRoot.value}) must equal ${requestedRoot.path} (${requestedRoot.value})`,
              },
            ],
            req.id,
          ),
        );
        return;
      }
      const rootPath = requestedRoots[0]?.path ?? 'workspace_root';
      const workspaceId = body.workspace_id;

      const registry = core.accessor.get(IProjectService);
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
        if (requestedRoot !== undefined && requestedRoot.value !== workspace.root) {
          reply.send(
            buildValidationEnvelope(
              [
                {
                  path: rootPath,
                  message: `${rootPath} (${requestedRoot.value}) must equal workspace root (${workspace.root})`,
                },
              ],
              req.id,
            ),
          );
          return;
        }
        workDir = workspace.root;
      } else if (requestedRoot !== undefined) {
        workDir = requestedRoot.value;
      } else {
        reply.send(
          buildValidationEnvelope(
            [{ path: rootPath, message: 'either workspace_id or workspace_root is required' }],
            req.id,
          ),
        );
        return;
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
        if (typeof body.title === 'string') {
          await handle.accessor.get(ISessionMetadata).setTitle(body.title);
        }
        const session = await toLiveWireSession(core, handle);
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


  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}',
      params: sessionIdParamSchema,
      querystring: getSessionQuerySchema,
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
      const summary = await loadSessionSummary(core, session_id);
      if (summary === undefined) {
        if (
          (req.query as { readonly hosts?: string }).hosts === 'include' &&
          hosts !== undefined
        ) {
          let unavailable = false;
          for (const source of hosts.sources()) {
            const session = await source.getSession();
            if (session === undefined) {
              unavailable = true;
              continue;
            }
            try {
              const remote = await hostGet<Session>(
                session,
                `/api/v1/sessions/${encodeURIComponent(session_id)}`,
              );
              reply.send(okEnvelope({ ...remote, host_id: source.id }, req.id));
              return;
            } catch (error) {
              if (error instanceof HostSourceError && error.code === ErrorCode.SESSION_NOT_FOUND) {
                continue;
              }
              unavailable = true;
            }
          }
          if (unavailable) {
            reply.send(
              errEnvelope(
                ErrorCode.HOST_UNAVAILABLE,
                `session ${session_id} could not be found on every host`,
                req.id,
              ),
            );
            return;
          }
        }
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const cwd =
        summary.cwd ?? (await core.accessor.get(IProjectService).get(summary.workspaceId))?.root;
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
      const workspaceRoot = await workspaceRootOf(core, summary.workspaceId);
      reply.send(
        okEnvelope(
          toWireSession({ ...summary, workspaceRoot }, cwd, resolveSessionFacts(core, session_id)),
          req.id,
        ),
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
      const summary = await loadSessionSummary(core, session_id);
      if (summary === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const cwd =
        summary.cwd ?? (await core.accessor.get(IProjectService).get(summary.workspaceId))?.root;
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
          sessionContinueResponseSchema,
          startBtwSessionResponseSchema,
          optimizePromptSessionResponseSchema,
          predictPromptResponseSchema,
          cancelPromptPredictionResponseSchema,
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
        [ErrorCode.TURN_NOT_CONTINUABLE]: {},
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
          (await core.accessor.get(IProjectService).list()).map((w) => [w.id, w.root]),
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
  | 'continue'
  | 'btw'
  | 'optimize'
  | 'predict-prompt'
  | 'cancel-prompt-prediction'
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
  continue: { handle: continueSessionAction },
  btw: { handle: btwSessionAction },
  optimize: { body: optimizePromptSessionRequestSchema, handle: optimizePromptSessionAction },
  'predict-prompt': {
    body: predictPromptRequestSchema,
    handle: predictPromptAction,
  },
  'cancel-prompt-prediction': {
    body: cancelPromptPredictionRequestSchema,
    handle: cancelPromptPredictionAction,
  },
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
    const workspaceId = lease.instance.program.workspaceId;
    const session = toWireSession(
      { ...meta, workspaceId, workspaceRoot: await workspaceRootOf(core, workspaceId) },
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
    baseSession = await toLiveWireSession(core, live);
  } else {
    const summary = await core.accessor.get(ISessionIndex).get(id);
    if (summary === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
    }
    const cwd =
      summary.cwd ?? (await core.accessor.get(IProjectService).get(summary.workspaceId))?.root;
    if (cwd === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} has no recoverable cwd`);
    }
    baseSession = toWireSession(
      { ...summary, workspaceRoot: await workspaceRootOf(core, summary.workspaceId) },
      cwd,
      resolveSessionFacts(core, id),
    );
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

const CONTINUE_INTERRUPTED_REMINDER =
  'No new user message was sent. Continue the interrupted work from where it stopped; do not repeat steps that already completed.';

async function continueSessionAction(ctx: SessionActionCtx): Promise<void> {
  const { core, conversations, req, reply, id } = ctx;
  await reloadOnStale(core.accessor, id, async () => {
    const session = await resumeSessionById(core.accessor, id);
    if (session === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
    }
    const agent = await ensureMainAgent(session);
    const loop = agent.accessor.get(IAgentLoopService);
    await loop.start();

    const assertIdle = (): void => {
      const snap = loop.snapshot();
      const compacting = agent.accessor.get(IAgentFullCompactionService).compacting !== null;
      if (snap.state === 'running' || snap.paused || snap.hasPendingRequests || compacting) {
        throw new Error2(ErrorCodes.SESSION_BUSY, `session ${id} is currently busy`);
      }
    };

    assertIdle();
    session.accessor.get(ISessionRunGate).begin();
    const feed = await conversations.feed(id, MAIN_AGENT_ID);

    const resolveContinuableState = (): {
      continuable: boolean;
      ownerPromptId?: string;
    } => {
      if (feed.hasTrailingRejectedPrompt()) {
        return { continuable: false };
      }
      const turns = feed.turns();
      const latestTurn = turns.findLast((turn) => turn.kind === 'agent');
      if (latestTurn === undefined) {
        return { continuable: false };
      }
      let ownerPromptId = feed.latestPromptId();
      if (ownerPromptId === undefined) {
        const firstItem = latestTurn.items[0];
        if (firstItem?.type === 'notification') {
          ownerPromptId = firstItem.item_id;
        }
      }
      if (ownerPromptId === undefined) {
        for (let i = turns.length - 1; i >= 0; i -= 1) {
          for (let j = turns[i]!.items.length - 1; j >= 0; j -= 1) {
            const item = turns[i]!.items[j]!;
            if (item.type === 'user_message' && item.prompt_ids.length > 0) {
              ownerPromptId = item.prompt_ids.at(-1);
              break;
            }
          }
          if (ownerPromptId !== undefined) break;
        }
      }
      return {
        continuable:
          latestTurn.status === 'ended' &&
          (latestTurn.outcome === 'interrupted' ||
            (latestTurn.outcome === 'failed' && latestTurn.end_reason !== 'blocked')),
        ownerPromptId,
      };
    };

    if (!resolveContinuableState().continuable) {
      throw new Error2(
        ErrorCodes.TURN_NOT_CONTINUABLE,
        `session ${id} has no interrupted or failed turn to continue`,
      );
    }

    const sessionModel = loop.getModel();
    await core.accessor.get(IAuthSummaryService).ensureReady(sessionModel || undefined);

    assertIdle();
    session.accessor.get(ISessionRunGate).begin();
    const finalState = resolveContinuableState();
    if (!finalState.continuable) {
      throw new Error2(
        ErrorCodes.TURN_NOT_CONTINUABLE,
        `session ${id} has no interrupted or failed turn to continue`,
      );
    }

    loop.continueTurn([
      historyEntryFromContext({
        role: 'user',
        content: [{ type: 'text', text: wrapSystemReminder(CONTINUE_INTERRUPTED_REMINDER) }],
        toolCalls: [],
        origin: {
          kind: 'injection',
          variant: 'turn_continue',
          ownerPromptId: finalState.ownerPromptId,
        },
      }),
    ]);
    requestLog(req)?.info({ session_id: id, action: 'continue' }, 'session action completed');
    reply.send(okEnvelope({ continued: true }, req.id));
  });
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

async function resumePromptPredictionService(core: Scope, id: string): Promise<ISessionPromptPredictionService> {
  const session = await resumeSessionById(core.accessor, id);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${id} does not exist`);
  }
  return session.accessor.get(ISessionPromptPredictionService);
}

async function predictPromptAction(
  ctx: SessionActionCtx<z.infer<typeof predictPromptRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body } = ctx;
  const service = await resumePromptPredictionService(core, id);
  const raw = (reply as unknown as DisconnectObservableReply).raw;
  let disconnected = false;
  const onClose = (): void => {
    if (raw?.writableFinished === true) return;
    disconnected = true;
    service.cancel(body.prediction_id, 'disconnect');
  };
  raw?.once('close', onClose);
  try {
    if (disconnected || raw?.destroyed === true) return;
    const prediction = await service.predict({
      predictionId: body.prediction_id,
      expectedTurnId: body.expected_turn_id,
    });
    if (!disconnected) {
      reply.send(okEnvelope(predictPromptResponseSchema.parse({ prediction }), req.id));
    }
  } finally {
    raw?.off('close', onClose);
  }
}

async function cancelPromptPredictionAction(
  ctx: SessionActionCtx<z.infer<typeof cancelPromptPredictionRequestSchema>>,
): Promise<void> {
  const { core, req, reply, id, body } = ctx;
  const service = await resumePromptPredictionService(core, id);
  const cancelled = service.cancel(body.prediction_id, body.reason);
  reply.send(okEnvelope(cancelPromptPredictionResponseSchema.parse({ cancelled }), req.id));
}

async function optimizePromptSessionAction(
  ctx: SessionActionCtx<z.infer<typeof optimizePromptSessionRequestSchema>>,
): Promise<void> {  const { core, req, reply, id, body } = ctx;
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
  const session = await toLiveWireSession(core, restored);
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
  const reloadGuard = live
    ?.accessor.get(IAgentLifecycleService)
    .handleOf(MAIN_AGENT_ID)
    ?.accessor.get(IAgentChangeNotifierService)
    .prepareForReload();
  try {
    await core.accessor.get(IConfigService).reload();
    await core.accessor.get(IPluginService).reloadPlugins();
    await refreshWorkspaceCatalogs(core, workspaceId, id);
  } catch (error) {
    await reloadGuard?.restoreAfterFailure();
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
    await main
      .accessor.get(IAgentChangeNotifierService)
      .notifyAllChanges({ previousSubagentNames: reloadGuard?.previousSubagentNames });
    main.accessor.get(IAgentLoopService).flushReminders();
  }
  const session = await toLiveWireSession(core, handle);
  requestLog(req)?.info({ session_id: id, action: 'reload' }, 'session action completed');
  reply.send(okEnvelope(session, req.id));
}

async function refreshWorkspaceCatalogs(
  core: Scope,
  workspaceId: string | undefined,
  excludedSessionId: string,
): Promise<void> {
  if (workspaceId !== undefined) {
    const target = core.accessor.get(IProjectInstanceManager).get(workspaceId);
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

export interface SessionWireFields extends Omit<SessionSummary, 'cwd'> {
  readonly workspaceRoot?: string;
}

export function toWireSession(
  fields: SessionWireFields,
  cwd: string,
  facts: SessionFacts,
  git?: SessionGit,
): Session {
  const lastTurnReason =
    facts.lastTurnReason ?? (facts.live === false ? fields.lastTurnReason : undefined);
  return {
    id: fields.id,
    workspace_id: fields.workspaceId,
    workspace_root: fields.workspaceRoot,
    cwd,
    environment_id: fields.environmentId ?? LOCAL_ENVIRONMENT_ID,
    environment_cwd: fields.environmentCwd,
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
    ...(git === undefined ? {} : { git }),
    metadata: buildWireMetadata(fields.custom, cwd),
    agent_config: { model: facts.model ?? '' },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
  };
}

async function toLiveWireSession(core: Scope, session: ISessionScopeHandle): Promise<Session> {
  const meta = await session.accessor.get(ISessionMetadata).read();
  const ctx = session.accessor.get(ISessionContext);
  const workspaceRoot = await workspaceRootOf(core, ctx.workspaceId);
  return toWireSession(
    { ...meta, workspaceId: ctx.workspaceId, workspaceRoot },
    ctx.cwd,
    resolveSessionFacts(core, meta.id),
  );
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

interface RequestedWorkspaceRoot {
  readonly path: string;
  readonly value: string;
}

function requestedWorkspaceRoots(body: SessionCreate): RequestedWorkspaceRoot[] {
  const metadataCwd = body.metadata?.cwd;
  return [
    { path: 'metadata.cwd', value: typeof metadataCwd === 'string' ? metadataCwd : undefined },
    { path: 'workspace_root', value: body.workspace_root },
  ].filter((root): root is RequestedWorkspaceRoot => root.value !== undefined);
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




