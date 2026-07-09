/**
 * `sessionLegacy` domain — `ISessionLegacyService` implementation.
 *
 * Stateless App-scope dispatcher: each method resolves the target session (and
 * its main agent) per call, delegates to the native v2 services, and projects
 * the result into the v1 wire shape. Child sessions are implemented as forks
 * tagged in `custom` (`parent_session_id` + `child_session_kind`); listing reads
 * those markers from the `sessionIndex` summaries. No business logic is
 * duplicated here; the real work stays in the native services.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { type IAgentScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { IConfigService } from '#/app/config/config';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { toProtocolMessage } from '#/agent/contextMemory/messageProjection';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { ErrorCodes, isKimiError, KimiError } from '#/errors';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IModelResolver } from '#/app/model/modelResolver';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentPlanService } from '#/agent/plan/plan';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentWireRecordService } from '#/agent/wireRecord/wireRecord';
import { ISessionActivity } from '#/session/sessionActivity/sessionActivity';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { IWorkspaceRegistry } from '#/app/workspaceRegistry/workspaceRegistry';
import type {
  CreateSessionChildRequest,
  SessionStatusResponse,
  UndoSessionRequest,
  UndoSessionResponse,
  UpdateSessionProfileRequest,
} from '@moonshot-ai/protocol';

import {
  ISessionLegacyService,
  type SessionChildrenPage,
  type SessionChildrenQuery,
  type SessionWireFields,
} from './sessionLegacy';

/**
 * v1 `child_session_kind` marker (`packages/agent-core/.../sessionService.ts`).
 * A fork is only listed as a "child" when its metadata carries both
 * `parent_session_id` (the parent) and `child_session_kind === 'child'`; a
 * spoofed kind is ignored. Reused verbatim so v1/v2 agree on the tag.
 */
const CHILD_SESSION_KIND = 'child';

const CHILDREN_DEFAULT_PAGE_SIZE = 100;
const CHILDREN_MAX_PAGE_SIZE = 100;

/** v1 `:undo` page-size clamp (`packages/agent-core/.../sessionService.ts`). */
const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;

export class SessionLegacyService implements ISessionLegacyService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionLifecycleService private readonly lifecycle: ISessionLifecycleService,
    @ISessionIndex private readonly index: ISessionIndex,
    @IWorkspaceRegistry private readonly workspaceRegistry: IWorkspaceRegistry,
  ) {}

  async updateProfile(
    sessionId: string,
    body: UpdateSessionProfileRequest,
  ): Promise<SessionWireFields> {
    const session = await this.lifecycle.resume(sessionId);
    if (session === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    const metadata = session.accessor.get(ISessionMetadata);

    if (typeof body.title === 'string') {
      await metadata.setTitle(body.title);
    }

    // v1 `ISessionService.update` writes the wire metadata patch straight into
    // `custom` (replace, not deep-merge); `toProtocolSession` then spreads
    // `custom` back onto the wire `Session.metadata`. An empty patch is a no-op
    // (matches v1's `Object.keys(...).length > 0` guard).
    const metadataPatch = body.metadata;
    if (metadataPatch !== undefined && Object.keys(metadataPatch).length > 0) {
      await metadata.update({ custom: { ...(metadataPatch as Record<string, unknown>) } });
    }

    const agentConfig = body.agent_config;
    if (agentConfig !== undefined) {
      const agent = await this.resolveMainAgent(sessionId);
      await this.applyAgentConfig(agent, agentConfig);
    }

    const meta = await metadata.read();
    // `ISessionContext` carries the frozen work dir (gap G3 closed), so an
    // unregistered workspace does not collapse `cwd` here — matches v1, which
    // stores `workDir` on the session itself.
    const ctx = session.accessor.get(ISessionContext);
    return {
      id: meta.id,
      workspaceId: ctx.workspaceId,
      root: ctx.cwd,
      title: meta.title,
      lastPrompt: meta.lastPrompt,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archived: meta.archived,
      custom: meta.custom,
    };
  }

  async createChild(sessionId: string, body: CreateSessionChildRequest): Promise<SessionWireFields> {
    const parentTitle = await this.resolveParentTitle(sessionId);
    const handle = await this.lifecycle.fork({
      sourceSessionId: sessionId,
      title: body.title ?? `Child: ${parentTitle || sessionId}`,
      metadata: Object.assign({}, body.metadata, {
        parent_session_id: sessionId,
        child_session_kind: CHILD_SESSION_KIND,
      }),
    });
    const meta = await handle.accessor.get(ISessionMetadata).read();
    const ctx = handle.accessor.get(ISessionContext);
    return {
      id: meta.id,
      workspaceId: ctx.workspaceId,
      root: ctx.cwd,
      title: meta.title,
      lastPrompt: meta.lastPrompt,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archived: meta.archived,
      custom: meta.custom,
    };
  }

  async listChildren(sessionId: string, query: SessionChildrenQuery): Promise<SessionChildrenPage> {
    const exists =
      this.lifecycle.get(sessionId) !== undefined ||
      (await this.index.get(sessionId)) !== undefined;
    if (!exists) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }

    // v1 lists every session then filters by the `parent_session_id` +
    // `child_session_kind` markers (carried in `custom`); the index summary
    // already surfaces `custom`, so no per-session document read is needed.
    const all = await this.index.list({});
    const children = all.items.filter(
      (s) =>
        s.custom?.['parent_session_id'] === sessionId &&
        s.custom?.['child_session_kind'] === CHILD_SESSION_KIND,
    );

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = children.findIndex((s) => s.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = children.findIndex((s) => s.id === query.after_id);
    }

    let slice: SessionSummary[];
    if (query.before_id !== undefined && pivotIndex >= 0) {
      slice = children.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      slice = children.slice(0, pivotIndex);
    } else {
      slice = children;
    }

    const pageSize = Math.min(
      Math.max(query.page_size ?? CHILDREN_DEFAULT_PAGE_SIZE, 1),
      CHILDREN_MAX_PAGE_SIZE,
    );
    const page = slice.slice(0, pageSize);
    const items = await Promise.all(page.map((s) => this.projectSummary(s)));
    // `status` is layered on at the route edge: this adapter returns
    // protocol-free fields, and the route projects the live
    // `ISessionActivity.status()` onto each item and filters the page by the
    // `status` query (post-page, matching v1). `has_more` reflects the
    // pre-filter page.
    return { items, has_more: slice.length > pageSize };
  }

  async undo(sessionId: string, body: UndoSessionRequest): Promise<UndoSessionResponse> {
    const agent = await this.resolveMainAgent(sessionId);
    const context = agent.accessor.get(IAgentContextMemoryService);
    const before = context.get();
    const { count } = body;
    const precheck = precheckUndo(before, count);
    if (!precheck.ok) {
      const wireRecord = agent.accessor.get(IAgentWireRecordService);
      const records = wireRecord.getRecords();
      const contextRecordTypes = records
        .filter((r) => r.type.startsWith('context.'))
        .map((r) => r.type);
      throw new KimiError(
        ErrorCodes.SESSION_UNDO_UNAVAILABLE,
        undoUnavailableMessage(sessionId, precheck),
        {
          details: {
            historyLength: before.length,
            historyRoles: before.map((m) => `${m.role}:${m.origin?.kind ?? 'none'}`),
            wireRecordCount: records.length,
            contextRecordTypes,
          },
        },
      );
    }
    try {
      agent.accessor.get(IAgentPromptService).undo(count);
    } catch (error) {
      if (isKimiError(error) && error.code === ErrorCodes.REQUEST_INVALID) {
        throw new KimiError(ErrorCodes.SESSION_UNDO_UNAVAILABLE, error.message);
      }
      throw error;
    }
    const history = context.get();
    // Mirrors v1 `SessionService.undo`: project the post-undo history into a
    // wire `Page<Message>` (newest-first, page-size clamped) and pair it with
    // the live status. The route forwards this shape verbatim.
    const [summary, status] = await Promise.all([
      this.index.get(sessionId),
      this.assembleStatus(sessionId, agent),
    ]);
    return {
      messages: pageContextMessages(sessionId, summary?.createdAt ?? 0, history, body.page_size),
      status,
    };
  }

  // --- internals -------------------------------------------------------------

  /**
   * Best-effort parent title for the default `Child: <title>` name. Reads the
   * live handle first, then falls back to the persisted index. A missing parent
   * yields `undefined`; `lifecycle.fork` still throws `SESSION_NOT_FOUND` for
   * the real existence check.
   */
  private async resolveParentTitle(sessionId: string): Promise<string | undefined> {
    const live = this.lifecycle.get(sessionId);
    if (live !== undefined) {
      return (await live.accessor.get(ISessionMetadata).read()).title;
    }
    return (await this.index.get(sessionId))?.title;
  }

  private async projectSummary(summary: SessionSummary): Promise<SessionWireFields> {
    // Prefer the cwd persisted on the session summary (gap G3 closed); fall
    // back to the registry only for sessions written before `cwd` was stored.
    const root =
      summary.cwd ?? (await this.workspaceRegistry.get(summary.workspaceId))?.root ?? '';
    return {
      id: summary.id,
      workspaceId: summary.workspaceId,
      root,
      title: summary.title,
      lastPrompt: summary.lastPrompt,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      archived: summary.archived,
      custom: summary.custom,
    };
  }

  /**
   * Apply the v1 `agent_config` patch onto the main agent. Mirrors v1's
   * `IPromptService.applyAgentState` (`promptService.ts:650-743`) in both order
   * (model → thinking → permission → plan → swarm → goal) and diff behaviour:
   * the non-idempotent `plan.enter` / `swarm.enter` are guarded behind a state
   * read so a repeated `true` does not throw ('Already in plan mode'); the
   * idempotent setters (model / thinking / permission) fire directly. Goal
   * actions are one-shot and let domain errors (`goal.*`) propagate to the
   * route's `sendMappedError`.
   */
  private async applyAgentConfig(
    agent: IAgentScopeHandle,
    agentConfig: NonNullable<UpdateSessionProfileRequest['agent_config']>,
  ): Promise<void> {
    const profile = agent.accessor.get(IAgentProfileService);
    if (agentConfig.model !== undefined && agentConfig.model !== '') {
      await profile.setModel(agentConfig.model);
    }
    if (agentConfig.thinking !== undefined) {
      profile.setThinking(agentConfig.thinking);
    }
    if (agentConfig.permission_mode !== undefined) {
      agent
        .accessor.get(IAgentPermissionModeService)
        .setMode(agentConfig.permission_mode as PermissionMode);
    }
    if (agentConfig.plan_mode !== undefined) {
      const plan = agent.accessor.get(IAgentPlanService);
      const active = (await plan.status()) !== null;
      if (active !== agentConfig.plan_mode) {
        if (agentConfig.plan_mode) await plan.enter();
        else plan.exit();
      }
    }
    if (agentConfig.swarm_mode !== undefined) {
      const swarm = agent.accessor.get(IAgentSwarmService);
      if (swarm.isActive !== agentConfig.swarm_mode) {
        if (agentConfig.swarm_mode) swarm.enter('manual');
        else swarm.exit();
      }
    }
    if (agentConfig.goal_objective !== undefined) {
      await agent
        .accessor.get(IAgentGoalService)
        .createGoal({ objective: agentConfig.goal_objective });
    }
    if (agentConfig.goal_control !== undefined) {
      const goal = agent.accessor.get(IAgentGoalService);
      switch (agentConfig.goal_control) {
        case 'pause':
          await goal.pauseGoal({});
          break;
        case 'resume':
          await goal.resumeGoal({});
          break;
        case 'cancel':
          await goal.cancelGoal({});
          break;
      }
    }
  }

  private async resolveMainAgent(sessionId: string): Promise<IAgentScopeHandle> {
    // `resume` (not `get`) so a persisted-but-cold session — freshly opened in
    // the web UI before any prompt, or created by a previous process — is loaded
    // from disk instead of being reported as `session.not_found`. Mirrors v1's
    // `SessionService.undo`/`compact`, which call `resumeSession` first; `resume`
    // returns `undefined` only when the session is unknown or its workspace is
    // gone, so a genuinely missing session still 404s.
    const session = await this.lifecycle.resume(sessionId);
    if (session === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    return ensureMainAgent(session);
  }

  async status(sessionId: string): Promise<SessionStatusResponse> {
    const agent = await this.resolveMainAgent(sessionId);
    return this.assembleStatus(sessionId, agent);
  }

  private async assembleStatus(sessionId: string, agent: IAgentScopeHandle): Promise<SessionStatusResponse> {
    const session = this.lifecycle.get(sessionId);
    const profile = agent.accessor.get(IAgentProfileService);
    const contextSize = agent.accessor.get(IAgentContextSizeService);
    const permission = agent.accessor.get(IAgentPermissionModeService);
    const plan = agent.accessor.get(IAgentPlanService);
    const swarm = agent.accessor.get(IAgentSwarmService);

    const profileData = profile.data();
    const model = profile.getModel();
    const caps = profile.getModelCapabilities() as { max_context_tokens?: number };
    // v1 binds the default model to the main agent at session creation, so its
    // status always reports a real context window. v2 creates the main agent
    // lazily without binding a model until the first prompt/profile update, so a
    // fresh session has no model and `max_context_tokens` resolves to 0 — the
    // status line then shows "0/0". Mirror v1 by falling back to the configured
    // default model's context window whenever the agent has no model bound yet.
    const maxTokens =
      model === '' ? resolveDefaultModelContextTokens(agent) : (caps.max_context_tokens ?? 0);
    // `size` (measured + estimated) mirrors v1's `context.tokenCount`: it
    // reflects the live context even before the first measured exchange, whereas
    // `measured` stays 0 until the first LLM response lands.
    const tokens = contextSize.get().size;
    const planData = await plan.status();

    return {
      status: session?.accessor.get(ISessionActivity).status() ?? 'idle',
      model: model === '' ? undefined : model,
      thinking_level: profileData.thinkingLevel,
      permission: permission.mode,
      plan_mode: planData !== null,
      swarm_mode: swarm.isActive,
      context_tokens: tokens,
      max_context_tokens: maxTokens,
      context_usage: maxTokens > 0 ? tokens / maxTokens : 0,
    };
  }
}

/**
 * Resolve the configured default model's context window for the status line
 * when the main agent has no model bound yet (fresh session before the first
 * prompt). Returns 0 when no default model is configured or it cannot be
 * resolved (e.g. auth not ready), matching v1's "unknown" fallback.
 */
function resolveDefaultModelContextTokens(agent: IAgentScopeHandle): number {
  const defaultModel = agent.accessor.get(IConfigService).get<string>('defaultModel');
  if (typeof defaultModel !== 'string' || defaultModel.length === 0) return 0;
  try {
    return agent.accessor.get(IModelResolver).resolve(defaultModel).capabilities.max_context_tokens;
  } catch {
    return 0;
  }
}

/**
 * Mirror of v1 `pageContextMessages`: project the post-undo history into a
 * newest-first wire page, clamping `page_size` to `[1, 100]` (default 50).
 */
function pageContextMessages(
  sessionId: string,
  sessionCreatedAtMs: number,
  history: readonly ContextMessage[],
  requestedPageSize: number | undefined,
): { items: ReturnType<typeof toProtocolMessage>[]; has_more: boolean } {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = history.map((message, index) =>
    toProtocolMessage(sessionId, index, message, sessionCreatedAtMs),
  );
  const desc = all.toReversed();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
  };
}

type UndoPrecheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'empty' | 'compaction_boundary' | 'insufficient';
      readonly requested: number;
      readonly undoable: number;
    };

/**
 * v1 `canUndoHistory`, returning a structured reason instead of a bare boolean
 * so the wire error can say *why* an undo is unavailable. Scan from the end,
 * skipping injections, stopping at a compaction summary, and counting real user
 * prompts until `count` is met. `reason` is `empty` when no real user prompt
 * exists, `insufficient` when some exist but fewer than `count`, and
 * `compaction_boundary` when the scan hits a compaction summary first.
 */
export function precheckUndo(history: readonly ContextMessage[], count: number): UndoPrecheck {
  let remaining = count;
  let undoable = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    const originKind = message.origin?.kind;
    if (originKind === 'injection') continue;
    if (originKind === 'compaction_summary') {
      return { ok: false, reason: 'compaction_boundary', requested: count, undoable };
    }
    if (isRealUserPrompt(message)) {
      remaining -= 1;
      undoable += 1;
      if (remaining === 0) return { ok: true };
    }
  }
  return undoable === 0
    ? { ok: false, reason: 'empty', requested: count, undoable: 0 }
    : { ok: false, reason: 'insufficient', requested: count, undoable };
}

function undoUnavailableMessage(
  sessionId: string,
  precheck: Extract<UndoPrecheck, { ok: false }>,
): string {
  switch (precheck.reason) {
    case 'empty':
      return `Nothing to undo: no user message to undo in session ${sessionId}`;
    case 'compaction_boundary':
      return `Nothing to undo: would cross a compaction boundary in session ${sessionId}`;
    case 'insufficient':
      return `Nothing to undo: only ${precheck.undoable} of ${precheck.requested} requested turn(s) available in session ${sessionId}`;
  }
}

function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  if (
    origin.kind === 'skill_activation' &&
    (origin as { trigger?: string }).trigger === 'user-slash'
  ) {
    return true;
  }
  if (
    origin.kind === 'plugin_command' &&
    (origin as { trigger?: string }).trigger === 'user-slash'
  ) {
    return true;
  }
  return false;
}

registerScopedService(
  LifecycleScope.App,
  ISessionLegacyService,
  SessionLegacyService,
  InstantiationType.Delayed,
  'sessionLegacy',
);
