import {
  ISessionIndex,
  IWireService,
  resumeSessionById,
  type IAgentScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import type { Message, MessageRole } from '../../protocol/message';
import { ensureMainAgent } from '../../transport/mainAgent';
import type { WireProjectionService } from '../transcript/wireProjection';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

export class MessageNotFoundError extends Error {
  readonly sessionId: string;
  readonly messageId: string;
  constructor(sessionId: string, messageId: string) {
    super(`message ${messageId} does not exist in session ${sessionId}`);
    this.name = 'MessageNotFoundError';
    this.sessionId = sessionId;
    this.messageId = messageId;
  }
}

export class MessageCursorNotFoundError extends Error {
  readonly messageId: string;
  constructor(messageId: string) {
    super(`message ${messageId} used as a pagination cursor does not exist`);
    this.name = 'MessageCursorNotFoundError';
    this.messageId = messageId;
  }
}

export interface MessageListQuery {
  readonly before_id?: string | undefined;
  readonly after_id?: string | undefined;
  readonly page_size?: number | undefined;
  readonly role?: MessageRole | undefined;
}

export interface PageResponse<T> {
  items: T[];
  has_more: boolean;
}

export async function listMessages(
  core: Scope,
  sessionId: string,
  query: MessageListQuery,
  projections: WireProjectionService,
): Promise<PageResponse<Message>> {
  const all = await loadMessages(core, sessionId);
  const desc = [...all].toReversed();

  let start = 0;
  let end = all.length;
  if (query.before_id !== undefined) {
    const pivotIndex = descendingIndex(query.before_id);
    if (pivotIndex < 0) throw new MessageCursorNotFoundError(query.before_id);
    start = pivotIndex + 1;
  } else if (query.after_id !== undefined) {
    const pivotIndex = descendingIndex(query.after_id);
    if (pivotIndex < 0) throw new MessageCursorNotFoundError(query.after_id);
    end = pivotIndex;
  }

  const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
  const items: Message[] = [];
  let hasMore = false;
  for (let index = start; index < end; index++) {
    const message = all[all.length - 1 - index]!;
    if (query.role !== undefined && message.role !== query.role) continue;
    if (items.length === pageSize) {
      hasMore = true;
      break;
    }
    items.push(message);
  }
  return { items, has_more: hasMore };
}

export async function getMessage(
  core: Scope,
  sessionId: string,
  messageId: string,
  projections: WireProjectionService,
): Promise<Message> {
  const all = await loadMessages(core, sessionId, projections);
  const entry = all.find((m) => m.id === messageId);
  if (entry === undefined) {
    throw new MessageNotFoundError(sessionId, messageId);
  }
  return entry;
}

async function loadMessages(
  core: Scope,
  sessionId: string,
  projections: WireProjectionService,
): Promise<Message[]> {
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) {
    throw new SessionNotFoundError(sessionId);
  }

  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) return [];
  const agent = await ensureMainAgent(session);
  return loadMessageHistory(agent, sessionId, summary.createdAt, projections);
}

export async function loadMessageHistory(
  agent: IAgentScopeHandle,
  sessionId: string,
  sessionCreatedAtMs: number,
  projections: WireProjectionService,
): Promise<Message[]> {
  await agent.accessor.get(IWireService).flush();
  return projections.readMessages(agent, sessionId, sessionCreatedAtMs);
}
