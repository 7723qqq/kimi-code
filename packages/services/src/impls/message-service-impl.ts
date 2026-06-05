/**
 * `MessageServiceImpl` — adapter between protocol-shaped REST surface and
 * agent-core's `AgentContextData.history` shape (Chain 3 / P1.3, W7.1).
 *
 * Wraps `IHarnessBridge.rpc.{listSessions, getContext}` and translates each
 * `ContextMessage` (kosong `Message` extended with `origin` + `isError`) into
 * the protocol-level `Message` discriminated-by-content shape (SCHEMAS §3).
 *
 * **Field mapping** (kosong/agent-core → protocol):
 *
 *   ContextMessage.role               →  Message.role            (1:1)
 *   ContextMessage.content[]          →  Message.content[]       (per-part adapter; see below)
 *   ContextMessage.toolCalls[]        →  Message.content[]       (appended as `tool_use` content parts)
 *   ContextMessage.toolCallId         →  Message.content[].tool_call_id  (when role==='tool', body becomes a tool_result)
 *   ContextMessage.isError            →  Message.content[0].is_error (only on tool_result)
 *
 * Content-part adapter (kosong ContentPart → SCHEMAS MessageContent):
 *
 *   { type:'text',      text }            → { type:'text', text }
 *   { type:'think',     think, encrypted? } → { type:'thinking', thinking:think, signature?:encrypted }
 *   { type:'image_url', imageUrl }        → { type:'image', source:{kind:'url', url:imageUrl.url } }
 *                                            (file/base64 reserved for future kosong shape)
 *   { type:'audio_url', audioUrl }        → { type:'text', text:`[audio:${audioUrl.url}]` }
 *                                            (SCHEMAS §3 has no audio content variant; flatten lossy)
 *   { type:'video_url', videoUrl }        → { type:'text', text:`[video:${videoUrl.url}]` }
 *                                            (same as audio — no video variant in §3)
 *
 * Tool messages (role === 'tool'): kosong stores the tool output as the
 * `content[]` plus a top-level `toolCallId`. The adapter projects this into
 * the protocol's single `{type:'tool_result', tool_call_id, output, is_error?}`
 * content part, with `output` carrying the flattened text content of the
 * tool message (most tool messages return a single text part, per Loop).
 *
 * Assistant messages with tool calls (role === 'assistant', `toolCalls.length > 0`):
 * the adapter emits the content parts first, then ONE `tool_use` part per
 * `ToolCall` in `toolCalls` — preserving call order.
 *
 * **ID synthesis**: kosong's `Message` has no `id`. We derive a deterministic
 * id from `(sessionId, history_index)`:
 *
 *     id = `msg_<sessionId>_<6-digit-index>`
 *
 * Example: `msg_sess_01HZZZ_000003` for the 4th message in session
 * `sess_01HZZZ`. The 6-digit padding keeps lexicographic sort = numeric sort
 * for up to 1M messages per session. The format is opaque to clients — the
 * only contract is "stable, time-sortable string min(1)".
 *
 * **Timestamp synthesis**: kosong's `Message` has no timestamp. We derive
 * `created_at` from `sessionSummary.createdAt + history_index` (1ms apart per
 * message) so timestamp ordering matches id ordering. Real per-message
 * timestamps are deferred until agent-core surfaces per-message persistence
 * (documented in `packages/protocol/src/message.ts` header + STATUS Decisions).
 *
 * **Pagination**: SCHEMAS §1.3 / REST §3.4 say default 50, max 100 — applied
 * at the route layer. This impl receives a fully-validated query.
 *   - No `before_id` / `after_id`: returns the last `page_size` messages
 *     (created_at desc, equivalent to "history.slice(-page_size).reverse()").
 *   - `before_id`: messages strictly older than the pivot (history-prefix
 *     before the pivot index), most-recent first.
 *   - `after_id`: messages strictly newer than the pivot (history-suffix after
 *     the pivot index), most-recent first.
 *   - `has_more`: true iff the underlying eligible slice is bigger than
 *     `page_size`.
 *
 * **Role filter**: applied AFTER pagination on the visible page. This matches
 * SCHEMAS' "filter doesn't change cursor semantics" implicit contract. A
 * later optimization can fold the filter into the slice once agent-core
 * surfaces server-side message queries.
 *
 * **CoreAPI surface gap — session-existence check**: agent-core does NOT
 * expose `getSession(id)` and `getContext` itself doesn't accept a session id
 * (it expects `WithSessionId` from the proxy wrapper). We existence-check via
 * `listSessions({}) + find(id)` (mirrors `SessionServiceImpl.get`).
 *
 * **Anti-corruption**: imports `@moonshot-ai/agent-core` only for type-only
 * `SessionSummary` / `AgentContextData` / `ContextMessage`. Runtime calls go
 * through `IHarnessBridge.rpc.<method>`.
 */

import { Disposable } from '@moonshot-ai/agent-core';
import type {
  AgentContextData,
  ContextMessage,
  SessionSummary,
} from '@moonshot-ai/agent-core';
import type {
  Message,
  MessageContent,
  MessageRole,
  PageResponse,
  ToolUseContent,
} from '@moonshot-ai/protocol';

import { IHarnessBridge } from '../bridge/harness-bridge';
import {
  IMessageService,
  MessageNotFoundError,
  type MessageListQuery,
} from '../interfaces/message-service';
import { SessionNotFoundError } from '../interfaces/session-service';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
/** Agent id used for all session-scoped getContext calls (matches agent-core convention; see `core-impl.ts:788`). */
const MAIN_AGENT_ID = 'main';

/**
 * Derive a stable opaque message id from (sessionId, index). Format is
 * documented in the module header.
 */
export function deriveMessageId(sessionId: string, index: number): string {
  const padded = String(index).padStart(6, '0');
  return `msg_${sessionId}_${padded}`;
}

/**
 * Inverse of `deriveMessageId`: parse `msg_<sessionId>_<index>` back into
 * `{sessionId, index}`. Returns `undefined` if the id doesn't match the
 * `MessageServiceImpl` ULID-shape contract.
 */
export function parseMessageId(
  messageId: string,
): { sessionId: string; index: number } | undefined {
  if (!messageId.startsWith('msg_')) return undefined;
  const rest = messageId.slice('msg_'.length);
  // sessionId may itself contain underscores (sess_01HZZZ...), so split from
  // the RIGHT on '_'.
  const lastUnderscore = rest.lastIndexOf('_');
  if (lastUnderscore <= 0) return undefined;
  const sessionId = rest.slice(0, lastUnderscore);
  const indexStr = rest.slice(lastUnderscore + 1);
  if (!/^\d+$/.test(indexStr)) return undefined;
  const index = Number.parseInt(indexStr, 10);
  if (!Number.isFinite(index) || index < 0) return undefined;
  return { sessionId, index };
}

/**
 * kosong's `Message.role` is `'system' | 'user' | 'assistant' | 'tool'` —
 * already aligned with SCHEMAS §3's `MessageRole`. We pass-through.
 */
function toProtocolRole(role: ContextMessage['role']): MessageRole {
  return role as MessageRole;
}

/**
 * Translate kosong content parts to SCHEMAS §3 content parts. See header
 * for the full mapping table.
 */
function mapContentPart(part: ContextMessage['content'][number]): MessageContent {
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
      // SCHEMAS §3 has no audio content variant; flatten to a `text` marker
      // so the wire shape stays well-typed without inventing new schema.
      return {
        type: 'text',
        text: `[audio:${part.audioUrl.url}]`,
      };
    case 'video_url':
      return {
        type: 'text',
        text: `[video:${part.videoUrl.url}]`,
      };
  }
}

/**
 * Build the protocol-shaped `Message.content[]` for one ContextMessage.
 *
 * Order:
 *   1. For `tool` role: emit a SINGLE `tool_result` part. The output is the
 *      flattened text of the kosong message's content parts (most tool
 *      messages emit a single text). `is_error` is taken from `ContextMessage.isError`.
 *   2. For other roles: emit each content part mapped per `mapContentPart`,
 *      THEN append one `tool_use` part per `ToolCall` (assistant only).
 */
function buildProtocolContent(msg: ContextMessage): MessageContent[] {
  if (msg.role === 'tool') {
    if (msg.toolCallId === undefined) {
      // Defensive — kosong tool messages always carry toolCallId. If absent,
      // fall back to text passthrough so we don't lose user-visible content.
      return msg.content.map((p) => mapContentPart(p));
    }
    const flattenedOutput = msg.content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    const part: MessageContent = msg.isError === true
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
 * Convert one history-array entry into the protocol's `Message` shape.
 *
 * `sessionCreatedAtMs` is the session's `createdAt` (ms). We add the index
 * so per-message `created_at` increases monotonically across the array.
 */
export function toProtocolMessage(
  sessionId: string,
  index: number,
  msg: ContextMessage,
  sessionCreatedAtMs: number,
): Message {
  const id = deriveMessageId(sessionId, index);
  const role = toProtocolRole(msg.role);
  const content = buildProtocolContent(msg);
  const createdAtMs = sessionCreatedAtMs + index;
  return {
    id,
    session_id: sessionId,
    role,
    content,
    created_at: new Date(createdAtMs).toISOString(),
  };
}

export class MessageServiceImpl extends Disposable implements IMessageService {
  constructor(@IHarnessBridge private readonly bridge: IHarnessBridge) {
    super();
  }

  async list(sid: string, query: MessageListQuery): Promise<PageResponse<Message>> {
    const summary = await this._requireSession(sid);
    const context = await this._getContext(sid);
    const all: Message[] = context.history.map((m, idx) =>
      toProtocolMessage(sid, idx, m, summary.createdAt),
    );
    // SCHEMAS §1.3: "缺省返回最近 N 条 (created_at desc)" — newest first.
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
      slice = desc;
    }

    const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
    const page = slice.slice(0, pageSize);
    const hasMore = slice.length > pageSize;

    // Role filter is applied AFTER pagination — see header.
    const filtered =
      query.role !== undefined ? page.filter((m) => m.role === query.role) : page;

    return { items: filtered, has_more: hasMore };
  }

  async get(sid: string, mid: string): Promise<Message> {
    const summary = await this._requireSession(sid);
    const parsed = parseMessageId(mid);
    if (parsed === undefined || parsed.sessionId !== sid) {
      throw new MessageNotFoundError(sid, mid);
    }
    const context = await this._getContext(sid);
    const entry = context.history[parsed.index];
    if (entry === undefined) {
      throw new MessageNotFoundError(sid, mid);
    }
    return toProtocolMessage(sid, parsed.index, entry, summary.createdAt);
  }

  /**
   * Confirms the session exists and returns its summary (for the timestamp
   * base). Throws `SessionNotFoundError` (→ 40401) on miss.
   */
  private async _requireSession(sid: string): Promise<SessionSummary> {
    const all = await this.bridge.rpc.listSessions({});
    const summary = all.find((s) => s.id === sid);
    if (summary === undefined) {
      throw new SessionNotFoundError(sid);
    }
    return summary;
  }

  /**
   * Fetch the session's in-memory history via `getContext`. Closed sessions
   * may surface an error here — re-thrown as `SessionNotFoundError` so the
   * route layer maps it to 40401 (the most defensible mapping when the
   * session is not currently loaded into the active session map).
   */
  private async _getContext(sid: string): Promise<AgentContextData> {
    try {
      return await this.bridge.rpc.getContext({ sessionId: sid, agentId: MAIN_AGENT_ID });
    } catch (err) {
      throw new SessionNotFoundError(sid);
    }
  }
}
