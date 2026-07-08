/**
 * `messageLegacy` domain — `IMessageLegacyService` implementation.
 *
 * Stateless App-scope dispatcher: each call resolves the target session (and
 * its main agent), sources the transcript, and projects it into the v1 wire
 * shape.
 *
 * History source is the main agent's `wire.jsonl` record log, NOT the live
 * `IAgentContextMemoryService.get()`: that live history is the model's CURRENT
 * context — after a compaction it collapses into `[...keptUserMessages,
 * compaction_summary]`, which made `GET /sessions/{sid}/messages` lose
 * everything before the fold. The wire log keeps every record, so
 * `reduceContextTranscript` rebuilds the full transcript (compaction inserts a
 * summary marker instead of dropping the prefix) — the same view v1's
 * `MessageService` serves. Records reach disk through an async flush queue, so
 * a request on a live session may find the wire a few records behind memory:
 * `foldedLength` is what the live history length WOULD be from the file's
 * records, and anything beyond it in the real live context is appended as the
 * unflushed tail. Pagination, id derivation, and the role filter mirror v1's
 * `MessageService`
 * (`packages/agent-core/src/services/message/messageService.ts`).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Message, PageResponse } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { type ISessionScopeHandle, LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ensureMainAgent, MAIN_AGENT_ID } from '#/session/agentLifecycle/mainAgent';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import {
  reduceContextTranscript,
  type ContextTranscript,
} from '#/agent/contextMemory/contextTranscript';
import { toProtocolMessage } from '#/agent/contextMemory/messageProjection';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { ErrorCodes, KimiError } from '#/errors';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionLifecycleService } from '#/app/sessionLifecycle/sessionLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { PersistedRecord } from '#/wire/wireService';

import { IMessageLegacyService, type MessageListQuery } from './messageLegacy';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export class MessageLegacyService implements IMessageLegacyService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionLifecycleService private readonly lifecycle: ISessionLifecycleService,
    @ISessionIndex private readonly index: ISessionIndex,
  ) {}

  async list(sessionId: string, query: MessageListQuery): Promise<PageResponse<Message>> {
    const all = await this.loadMessages(sessionId);
    // v1 / SCHEMAS §1.3: newest first (`created_at desc`).
    const desc = [...all].reverse();

    let pivotIndex = -1;
    if (query.before_id !== undefined) {
      pivotIndex = desc.findIndex((m) => m.id === query.before_id);
    } else if (query.after_id !== undefined) {
      pivotIndex = desc.findIndex((m) => m.id === query.after_id);
    }

    let slice: Message[];
    if (query.before_id !== undefined && pivotIndex >= 0) {
      // before_id = older entries → tail of the desc array, exclusive of pivot.
      slice = desc.slice(pivotIndex + 1);
    } else if (query.after_id !== undefined && pivotIndex >= 0) {
      // after_id = newer entries → head of the desc array, exclusive of pivot.
      slice = desc.slice(0, pivotIndex);
    } else {
      // Unknown cursor → fall through to the full list, matching v1.
      slice = desc;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const page = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    // Role filter is applied AFTER pagination, matching v1.
    const filtered = query.role !== undefined ? page.filter((m) => m.role === query.role) : page;

    return { items: filtered, has_more: hasMore };
  }

  async get(sessionId: string, messageId: string): Promise<Message> {
    // Resolve the session first: an unknown sid maps to 40401 even when the
    // message id is malformed or belongs to another session (40403).
    const all = await this.loadMessages(sessionId);
    const entry = all.find((m) => m.id === messageId);
    if (entry === undefined) {
      throw new KimiError(
        ErrorCodes.MESSAGE_NOT_FOUND,
        `message ${messageId} does not exist in session ${sessionId}`,
      );
    }
    return entry;
  }

  /**
   * Full main-agent transcript projected into the v1 `Message` wire shape,
   * oldest-first. Throws `session.not_found` (→ 40401) when the session is
   * unknown. An unreachable cold session (workspace gone) yields an empty
   * transcript rather than an error.
   */
  private async loadMessages(sessionId: string): Promise<Message[]> {
    const summary = await this.index.get(sessionId);
    if (summary === undefined) {
      throw new KimiError(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }

    const session = await this.lifecycle.resume(sessionId);
    if (session === undefined) return [];
    // Materialize the main agent so the live context is available for the
    // unflushed-tail merge below. `resume` already restored + replayed the
    // wire for a cold session; a live session is already current.
    const agent = await ensureMainAgent(session);

    // Read the wire file BEFORE the live context so the in-memory history is
    // always at least as new as the file snapshot and the tail merge can only
    // append (mirrors v1 `MessageService`).
    const transcript = await this.readTranscript(session);
    const contextMessages = agent.accessor.get(IAgentContextMemoryService).get();
    const entries = mergeLiveTail(transcript, contextMessages);

    return entries.map((msg, index) => toProtocolMessage(sessionId, index, msg, summary.createdAt));
  }

  /** Reduce the main agent's persisted wire log into the full transcript. */
  private async readTranscript(session: ISessionScopeHandle): Promise<ContextTranscript> {
    const ctx = session.accessor.get(ISessionContext);
    const wirePath = join(ctx.sessionDir, 'agents', MAIN_AGENT_ID, 'wire.jsonl');
    const records = await readWireRecords(wirePath);
    return reduceContextTranscript(records);
  }
}

/**
 * Append the unflushed live tail: when the in-memory (folded) context is
 * longer than the wire-derived `foldedLength`, the surplus is records that
 * have not reached disk yet and must be appended so a read on a live session
 * does not trail memory.
 */
function mergeLiveTail(
  transcript: ContextTranscript,
  contextMessages: readonly ContextMessage[],
): readonly ContextMessage[] {
  if (contextMessages.length <= transcript.foldedLength) return transcript.entries;
  return [...transcript.entries, ...contextMessages.slice(transcript.foldedLength)];
}

/**
 * Parse a `wire.jsonl` file. A torn final line (crash mid-flush) is dropped;
 * corruption anywhere else throws. A missing file yields an empty record list
 * (a brand-new session whose context has not been flushed yet).
 */
async function readWireRecords(wirePath: string): Promise<PersistedRecord[]> {
  let raw: string;
  try {
    raw = await readFile(wirePath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const lines = raw.split('\n');
  const records: PersistedRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as PersistedRecord);
    } catch (parseError) {
      if (i === lines.length - 1) break;
      throw new Error(
        `wire.jsonl: corrupted line ${i + 1} in ${wirePath}: ${String(parseError)}`,
        { cause: parseError },
      );
    }
  }
  return records;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

registerScopedService(
  LifecycleScope.App,
  IMessageLegacyService,
  MessageLegacyService,
  InstantiationType.Delayed,
  'messageLegacy',
);
