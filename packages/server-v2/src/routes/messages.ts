/**
 * `/sessions/{session_id}/messages*` route handlers — server-v2 port.
 *
 * Implements the v1 `/api/v1/sessions/{sid}/messages` wire contract on top of
 * `agent-core-v2`:
 *   GET    /sessions/{session_id}/messages              query: ListMessages   data: Page<Message>
 *   GET    /sessions/{session_id}/messages/{message_id} -                     data: Message
 *
 * **Thin wrapper over `IContextMemory`**: the main agent's `IContextMemory` is
 * already exposed at Agent scope (`messages:list` in the RPC action map). These
 * REST routes borrow it by interface and project its `ContextMessage[]` history
 * into the protocol's `Message` shape, then apply the same id-derivation,
 * pagination and role-filter semantics as v1
 * (`packages/agent-core/src/services/message/message.ts`).
 *
 * **History source**: the live in-memory history (`IContextMemory.get()`), not
 * the persisted wire transcript. Unlike v1, this slice does not rebuild the
 * pre-compaction transcript from `wire.jsonl` — a compacted agent reports the
 * folded view. Rebuilding the full transcript is left as a gap until v2 exposes
 * a wire-read facade.
 *
 * **Resolution**: `core` → `ISessionIndex` (existence + `createdAt` base) →
 * `ISessionLifecycleService` (live session handle) → `IAgentLifecycleService`
 * (the `main` agent) → `IContextMemory`. When the session is not live or has no
 * main agent yet (server-v2 gap G10 — the main agent is not created on session
 * creation), the history is empty: `list` returns an empty page and `get`
 * answers `40403`.
 *
 * **Error mapping**:
 *   - unknown session   → `40401` (session.not_found)
 *   - unknown message   → `40403` (message.not_found)
 *   - invalid query     → `40001` (validation.failed, via defineRoute)
 */

import {
  IContextMemory,
  ISessionIndex,
  ISessionLifecycleService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  ErrorCode,
  getMessageResponseSchema,
  listMessagesResponseSchema,
  messageRoleSchema,
} from '@moonshot-ai/protocol';
import type { Message, MessageContent, MessageRole, ToolUseContent } from '@moonshot-ai/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';

/** One entry from the main agent's live history. */
type MemoryMessage = ReturnType<IContextMemory['get']>[number];

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

interface MessageRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

// --- Query coercion ---------------------------------------------------------

/**
 * HTTP query strings arrive as `Record<string, string>`. Coerce `page_size`
 * here so the protocol's cursor schema stays HTTP-agnostic — mirrors
 * `sessions.ts:sessionsListQueryCoercion` and v1's messages route.
 */
const messagesListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    role: messageRoleSchema.optional(),
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

// --- Params -----------------------------------------------------------------

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const messageIdParamSchema = z.object({
  session_id: z.string().min(1),
  message_id: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

// --- Registration -----------------------------------------------------------

export function registerMessagesRoutes(app: MessageRouteHost, core: Scope): void {
  // GET /sessions/{session_id}/messages --------------------------------
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/messages',
      params: sessionIdParamSchema,
      querystring: messagesListQueryCoercion,
      success: { data: listMessagesResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List messages for a session',
      tags: ['messages'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const loaded = await loadProtocolMessages(core, session_id);
      if (loaded === undefined) {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      const query = req.query;
      // SCHEMAS §1.3: newest first (`created_at desc`).
      const desc = [...loaded].reverse();

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
        slice = desc;
      }

      const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
      const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
      const page = slice.slice(0, pageSize);
      const hasMore = slice.length > pageSize;

      // Role filter is applied AFTER pagination, matching v1.
      const filtered =
        query.role !== undefined ? page.filter((m) => m.role === query.role) : page;

      reply.send(okEnvelope({ items: filtered, has_more: hasMore }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<MessageRouteHost['get']>[2],
  );

  // GET /sessions/{session_id}/messages/{message_id} -------------------
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/messages/{message_id}',
      params: messageIdParamSchema,
      success: { data: getMessageResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.MESSAGE_NOT_FOUND]: {},
      },
      description: 'Get a message by ID',
      tags: ['messages'],
    },
    async (req, reply) => {
      const { session_id, message_id } = req.params;
      // Resolve the session first: an unknown sid maps to 40401 even when the
      // message id is malformed or belongs to another session (40403).
      const loaded = await loadProtocolMessages(core, session_id);
      if (loaded === undefined) {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      const parsed = parseMessageId(message_id);
      if (parsed === undefined || parsed.sessionId !== session_id) {
        reply.send(messageNotFound(session_id, message_id, req.id));
        return;
      }
      const entry = loaded[parsed.index];
      if (entry === undefined) {
        reply.send(messageNotFound(session_id, message_id, req.id));
        return;
      }
      reply.send(okEnvelope(entry, req.id));
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<MessageRouteHost['get']>[2],
  );
}

// ---------------------------------------------------------------------------
// Resolution — walk core → session → main agent → live history. Returns the
// full protocol-shaped transcript in ascending order, or `undefined` when the
// session does not exist (→ 40401). A missing live session / main agent yields
// an empty history (gap G10), not a 404.
// ---------------------------------------------------------------------------

async function loadProtocolMessages(core: Scope, sid: string): Promise<Message[] | undefined> {
  const summary = await core.accessor.get(ISessionIndex).get(sid);
  if (summary === undefined) return undefined;

  const session = core.accessor.get(ISessionLifecycleService).get(sid);
  if (session === undefined) return [];
  const agent = await ensureMainAgent(session);
  const history = agent.accessor.get(IContextMemory).get();

  return history.map((msg, index) => toProtocolMessage(sid, index, msg, summary.createdAt));
}

// ---------------------------------------------------------------------------
// API body wrapper — pure projection from a `ContextMessage` history entry to
// the wire `Message` shape. Mirrors v1's `toProtocolMessage` and helpers so the
// REST contract is byte-for-byte compatible for the fields both share.
// ---------------------------------------------------------------------------

/** Derive a stable opaque message id from (sessionId, index). */
function deriveMessageId(sessionId: string, index: number): string {
  const padded = String(index).padStart(6, '0');
  return `msg_${sessionId}_${padded}`;
}

/**
 * Inverse of `deriveMessageId`: parse `msg_<sessionId>_<index>` back into
 * `{sessionId, index}`. Returns `undefined` when the id does not match the
 * derived contract. The session id may itself contain underscores, so the split
 * is taken from the RIGHT on `_`.
 */
function parseMessageId(messageId: string): { sessionId: string; index: number } | undefined {
  if (!messageId.startsWith('msg_')) return undefined;
  const rest = messageId.slice('msg_'.length);
  const lastUnderscore = rest.lastIndexOf('_');
  if (lastUnderscore <= 0) return undefined;
  const sessionId = rest.slice(0, lastUnderscore);
  const indexStr = rest.slice(lastUnderscore + 1);
  if (!/^\d+$/.test(indexStr)) return undefined;
  const index = Number.parseInt(indexStr, 10);
  if (!Number.isFinite(index) || index < 0) return undefined;
  return { sessionId, index };
}

/** kosong's `Role` already matches SCHEMAS §3's `MessageRole` — pass through. */
function toProtocolRole(role: MemoryMessage['role']): MessageRole {
  return role as MessageRole;
}

/** Translate one kosong content part to a SCHEMAS §3 content part. */
function mapContentPart(part: MemoryMessage['content'][number]): MessageContent {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think': {
      const sig = part.encrypted;
      return sig !== undefined
        ? { type: 'thinking', thinking: part.think, signature: sig }
        : { type: 'thinking', thinking: part.think };
    }
    case 'image_url':
      return {
        type: 'image',
        source: { kind: 'url', url: part.imageUrl.url },
      };
    case 'audio_url':
      // SCHEMAS §3 has no audio content variant; flatten to a `text` marker so
      // the wire shape stays well-typed without inventing a new schema.
      return { type: 'text', text: `[audio:${part.audioUrl.url}]` };
    case 'video_url':
      // Same as audio — no video variant in §3.
      return { type: 'text', text: `[video:${part.videoUrl.url}]` };
  }
}

/**
 * Build the protocol-shaped `Message.content[]` for one history entry:
 *   1. `tool` role → a single `tool_result` part (flattened text output;
 *      `is_error` from `ContextMessage.isError`).
 *   2. other roles → each mapped content part, then one `tool_use` part per
 *      `ToolCall` (assistant only).
 */
function buildProtocolContent(msg: MemoryMessage): MessageContent[] {
  if (msg.role === 'tool') {
    if (msg.toolCallId === undefined) {
      // Defensive — kosong tool messages always carry toolCallId. If absent,
      // fall back to text passthrough so user-visible content is not lost.
      return msg.content.map((p) => mapContentPart(p));
    }
    const flattenedOutput = msg.content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    const part: MessageContent =
      msg.isError === true
        ? {
            type: 'tool_result',
            tool_call_id: msg.toolCallId,
            output: flattenedOutput,
            is_error: true,
          }
        : {
            type: 'tool_result',
            tool_call_id: msg.toolCallId,
            output: flattenedOutput,
          };
    return [part];
  }

  const base = msg.content.map((p) => mapContentPart(p));

  if (msg.role === 'assistant' && msg.toolCalls.length > 0) {
    for (const call of msg.toolCalls) {
      let parsedInput: unknown = call.arguments;
      if (typeof call.arguments === 'string') {
        try {
          parsedInput = JSON.parse(call.arguments);
        } catch {
          parsedInput = call.arguments;
        }
      }
      const part: ToolUseContent = {
        type: 'tool_use',
        tool_call_id: call.id,
        tool_name: call.name,
        input: parsedInput,
      };
      base.push(part);
    }
  }

  return base;
}

/**
 * Convert one history entry into the protocol's `Message` shape.
 * `created_at` is synthesized from the session's `createdAt` plus the entry
 * index so it increases monotonically across the array.
 */
function toProtocolMessage(
  sessionId: string,
  index: number,
  msg: MemoryMessage,
  sessionCreatedAtMs: number,
): Message {
  const id = deriveMessageId(sessionId, index);
  const role = toProtocolRole(msg.role);
  const content = buildProtocolContent(msg);
  const createdAtMs = sessionCreatedAtMs + index;
  // Expose the message origin via metadata so REST clients (e.g. the web UI)
  // can hide injected / system user turns the same way the TUI does. Absent for
  // plain user / assistant / tool messages with no origin.
  const metadata = msg.origin !== undefined ? { origin: msg.origin } : undefined;
  return {
    id,
    session_id: sessionId,
    role,
    content,
    created_at: new Date(createdAtMs).toISOString(),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

// ---------------------------------------------------------------------------
// Error envelopes
// ---------------------------------------------------------------------------

function sessionNotFound(sid: string, requestId: string): unknown {
  return errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${sid} does not exist`, requestId);
}

function messageNotFound(sid: string, mid: string, requestId: string): unknown {
  return errEnvelope(
    ErrorCode.MESSAGE_NOT_FOUND,
    `message ${mid} does not exist in session ${sid}`,
    requestId,
  );
}
