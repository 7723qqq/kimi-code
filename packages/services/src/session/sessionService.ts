import {
  Disposable,
  Emitter,
  ErrorCodes,
  IInstantiationService,
  InstantiationType,
  KimiError,
  registerSingleton,
} from '@moonshot-ai/agent-core';
import type {
  AgentContextData,
  ContextMessage,
  JsonObject,
  SessionMeta,
  SessionSummary,
} from '@moonshot-ai/agent-core';
import {
  type CompactSessionRequest,
  type CompactSessionResponse,
  type Message,
  type PageResponse,
  type Session,
  type SessionChildCreate,
  type SessionCreate,
  type SessionFork,
  type SessionStatusResponse,
  type SessionUpdate,
  type UndoSessionRequest,
  type UndoSessionResponse,
} from '@moonshot-ai/protocol';

import { ICoreProcessService } from '../coreProcess/coreProcess';
import { IEventService } from '../event/event';
import { toProtocolMessage } from '../message/message';
import { IPromptService, type AgentStatePatch } from '../prompt/prompt';
import {
  ISessionService,
  SessionNotFoundError,
  SessionUndoUnavailableError,
  toProtocolSession,
  type SessionListQuery,
} from './session';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;
const CHILD_SESSION_KIND = 'child';

function asJsonObject(value: Record<string, unknown>): JsonObject {
  return value as unknown as JsonObject;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function canUndoHistory(history: readonly ContextMessage[], count: number): boolean {
  let found = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') return false;
    if (isRealUserPrompt(message)) {
      found++;
      if (found >= count) return true;
    }
  }
  return false;
}

function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  return origin.kind === 'skill_activation' && origin.trigger === 'user-slash';
}

function pageContextMessages(
  sessionId: string,
  sessionCreatedAtMs: number,
  context: AgentContextData,
  requestedPageSize: number | undefined,
): PageResponse<Message> {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = context.history.map((message, index) =>
    toProtocolMessage(sessionId, index, message, sessionCreatedAtMs),
  );
  const desc = all.toReversed();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
  };
}

export class SessionService extends Disposable implements ISessionService {
  readonly _serviceBrand: undefined;

  private readonly _onDidCreate = this._register(new Emitter<{ session: Session }>());
  readonly onDidCreate = this._onDidCreate.event;
  private readonly _onDidClose = this._register(new Emitter<{ sessionId: string }>());
  readonly onDidClose = this._onDidClose.event;

  constructor(
    @ICoreProcessService private readonly core: ICoreProcessService,
    @IEventService private readonly eventService: IEventService,
    @IInstantiationService
    private readonly instantiation: IInstantiationService,
  ) {
    super();
  }

  async create(input: SessionCreate): Promise<Session> {
    if (input.metadata === undefined || typeof input.metadata.cwd !== 'string') {
      throw new Error('SessionService.create: metadata.cwd is required');
    }
    const metadataForCore = asJsonObject(input.metadata as Record<string, unknown>);
    const summary = await this.core.rpc.createSession({
      workDir: input.metadata.cwd,
      metadata: metadataForCore,
      ...(input.agent_config?.model !== undefined ? { model: input.agent_config.model } : {}),
    });
    if (input.title !== undefined) {
      try {
        await this.core.rpc.renameSession({ sessionId: summary.id, title: input.title });
      } catch {
      }
    }
    const meta = await this.tryGetMeta(summary.id);
    const session = toProtocolSession(summary, meta);
    this.emitCreated(session);
    return session;
  }

  async list(query: SessionListQuery): Promise<PageResponse<Session>> {
    const all =
      query.workDir !== undefined
        ? await this.core.rpc.listSessions({ workDir: query.workDir })
        : await this.core.rpc.listSessions({});
    const sorted = all.toSorted((a, b) => b.createdAt - a.createdAt);

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = sorted.findIndex((s) => s.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = sorted.findIndex((s) => s.id === query.after_id);
    }

    let slice: typeof sorted;
    if (query.before_id !== undefined && pivotIndex >= 0) {
      slice = sorted.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      slice = sorted.slice(0, pivotIndex);
    } else {
      slice = sorted;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const pageSummaries = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    const items = await Promise.all(
      pageSummaries.map(async (s) => toProtocolSession(s, await this.tryGetMeta(s.id))),
    );

    const filtered =
      query.status !== undefined ? items.filter((s) => s.status === query.status) : items;

    return { items: filtered, has_more: hasMore };
  }

  async get(id: string): Promise<Session> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    const meta = await this.tryGetMeta(id);
    return toProtocolSession(summary, meta);
  }

  async update(id: string, input: SessionUpdate): Promise<Session> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    if (input.title !== undefined) {
      await this.core.rpc.renameSession({ sessionId: id, title: input.title });
    }

    const metadataPatch = input.metadata;
    if (metadataPatch !== undefined && Object.keys(metadataPatch).length > 0) {
      await this.core.rpc.updateSessionMetadata({
        sessionId: id,
        metadata: { custom: metadataPatch as Record<string, unknown> },
      });
    }

    const ac = input.agent_config;
    if (ac !== undefined) {
      const patch: AgentStatePatch = {};
      if (ac.model !== undefined && ac.model !== '') patch.model = ac.model;
      if (ac.thinking !== undefined) patch.thinking = ac.thinking;
      if (ac.permission_mode !== undefined) patch.permission_mode = ac.permission_mode;
      if (ac.plan_mode !== undefined) patch.plan_mode = ac.plan_mode;
      if (
        patch.model !== undefined ||
        patch.thinking !== undefined ||
        patch.permission_mode !== undefined ||
        patch.plan_mode !== undefined
      ) {
        const promptService = this.instantiation.invokeFunction((a) =>
          a.get(IPromptService),
        );
        await promptService.applyAgentState(id, patch, 'meta');
      }
    }

    const allAfter = await this.core.rpc.listSessions({});
    const summaryAfter = allAfter.find((s) => s.id === id) ?? summary;
    const meta = await this.tryGetMeta(id);
    return toProtocolSession(summaryAfter, meta);
  }

  async fork(id: string, input: SessionFork): Promise<Session> {
    const source = await this.get(id);
    const title = input.title ?? `Fork: ${source.title || source.id}`;
    const metadata = input.metadata === undefined ? undefined : asJsonObject(input.metadata);
    const summary = await this.core.rpc.forkSession({
      sessionId: id,
      title,
      metadata,
    });
    const meta = await this.tryGetMeta(summary.id);
    const session = toProtocolSession(summary, meta);
    this.emitCreated(session);
    return session;
  }

  async listChildren(id: string, query: SessionListQuery): Promise<PageResponse<Session>> {
    await this.get(id);
    const all = await this.core.rpc.listSessions({});
    const sorted = all.toSorted((a, b) => b.createdAt - a.createdAt);
    const children = sorted.filter(
      (summary) =>
        summary.metadata?.['parent_session_id'] === id &&
        summary.metadata?.['child_session_kind'] === CHILD_SESSION_KIND,
    );

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = children.findIndex((s) => s.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = children.findIndex((s) => s.id === query.after_id);
    }

    let slice: typeof children;
    if (query.before_id !== undefined && pivotIndex >= 0) {
      slice = children.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      slice = children.slice(0, pivotIndex);
    } else {
      slice = children;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const pageSummaries = slice.slice(0, pageSize);
    const items = await Promise.all(
      pageSummaries.map(async (s) => toProtocolSession(s, await this.tryGetMeta(s.id))),
    );
    const filtered =
      query.status !== undefined
        ? items.filter((session) => session.status === query.status)
        : items;

    return {
      items: filtered,
      has_more: slice.length > pageSize,
    };
  }

  async createChild(id: string, input: SessionChildCreate): Promise<Session> {
    const parent = await this.get(id);
    const title = input.title ?? `Child: ${parent.title || parent.id}`;
    const metadata = asJsonObject({
      ...input.metadata,
      parent_session_id: id,
      child_session_kind: CHILD_SESSION_KIND,
    });
    const summary = await this.core.rpc.forkSession({
      sessionId: id,
      title,
      metadata,
    });
    const meta = await this.tryGetMeta(summary.id);
    const session = toProtocolSession(summary, meta);
    this.emitCreated(session);
    return session;
  }

  private emitCreated(session: Session): void {
    this._onDidCreate.fire({ session });
    this.eventService.publish({
      type: 'event.session.created',
      agentId: 'main',
      sessionId: session.id,
      session,
    });
  }

  async getStatus(id: string): Promise<SessionStatusResponse> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    const [config, context, permission, plan] = await Promise.all([
      this.core.rpc.getConfig({ sessionId: id, agentId: 'main' }),
      this.core.rpc.getContext({ sessionId: id, agentId: 'main' }),
      this.core.rpc.getPermission({ sessionId: id, agentId: 'main' }),
      this.core.rpc.getPlan({ sessionId: id, agentId: 'main' }),
    ]);

    const maxContextTokens = config.modelCapabilities?.max_context_tokens ?? 0;
    const contextTokens = context.tokenCount;
    const contextUsage = maxContextTokens > 0 ? contextTokens / maxContextTokens : 0;

    return {
      model: config.modelAlias ?? config.provider?.model,
      thinking_level: config.thinkingLevel,
      permission: permission.mode,
      plan_mode: plan !== null,
      context_tokens: contextTokens,
      max_context_tokens: maxContextTokens,
      context_usage: contextUsage,
    };
  }

  async compact(id: string, input: CompactSessionRequest): Promise<CompactSessionResponse> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }

    const instruction = normalizeOptionalString(input.instruction);
    await this.core.rpc.beginCompaction({
      sessionId: id,
      agentId: 'main',
      instruction,
    });
    return {};
  }

  async undo(id: string, input: UndoSessionRequest): Promise<UndoSessionResponse> {
    const summary = await this.requireSummary(id);
    await this.core.rpc.resumeSession({ sessionId: id });
    const before = await this.core.rpc.getContext({ sessionId: id, agentId: 'main' });
    if (!canUndoHistory(before.history, input.count)) {
      throw new SessionUndoUnavailableError(id);
    }

    try {
      await this.core.rpc.undoHistory({
        sessionId: id,
        agentId: 'main',
        count: input.count,
      });
    } catch (error) {
      if (error instanceof KimiError && error.code === ErrorCodes.REQUEST_INVALID) {
        throw new SessionUndoUnavailableError(id, error.message);
      }
      throw error;
    }

    const after = await this.core.rpc.getContext({ sessionId: id, agentId: 'main' });
    return {
      messages: pageContextMessages(id, summary.createdAt, after, input.page_size),
      status: await this.getStatus(id),
    };
  }

  async delete(id: string): Promise<{ deleted: true }> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    await this.core.rpc.closeSession({ sessionId: id });
    this._onDidClose.fire({ sessionId: id });
    return { deleted: true };
  }

  private async requireSummary(id: string): Promise<SessionSummary> {
    const all = await this.core.rpc.listSessions({});
    const summary = all.find((s) => s.id === id);
    if (summary === undefined) {
      throw new SessionNotFoundError(id);
    }
    return summary;
  }

  private async tryGetMeta(id: string): Promise<SessionMeta | undefined> {
    try {
      const meta = await this.core.rpc.getSessionMetadata({ sessionId: id });
      return meta;
    } catch {
      return undefined;
    }
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    super.dispose();
  }
}

registerSingleton(ISessionService, SessionService, InstantiationType.Delayed);
