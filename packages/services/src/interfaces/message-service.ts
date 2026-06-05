/**
 * `IMessageService` — daemon-facing message history interface (Chain 3 / P1.3, W7.1).
 *
 * Wraps `IHarnessBridge.rpc.getContext({sessionId, agentId})` and adapts
 * agent-core's `ContextMessage` history shape (kosong `Message` + origin) to
 * the protocol's SCHEMAS.md §3 `Message` discriminated-by-content union.
 *
 * Endpoint mapping (REST.md §3.4):
 *   GET  /v1/sessions/{sid}/messages         → list(sid, ListMessagesQuery)
 *   GET  /v1/sessions/{sid}/messages/{mid}   → get(sid, mid)
 *
 * Sentinel errors:
 *   - `SessionNotFoundError`   → 40401 at the route layer
 *   - `MessageNotFoundError`   → 40403 at the route layer
 *
 * The adapter is documented in `packages/services/src/impls/message-service-impl.ts`.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type {
  CursorQuery,
  Message,
  MessageRole,
  PageResponse,
} from '@moonshot-ai/protocol';

/**
 * Listing query — `before_id`/`after_id` + `page_size` mutex is enforced
 * by `cursorQuerySchema`. The service layer adds an optional role filter.
 */
export interface MessageListQuery extends CursorQuery {
  role?: MessageRole;
}

export interface IMessageService {
  /**
   * `GET /v1/sessions/{sid}/messages` — paginated message history.
   *
   * Default `page_size = 50`, max 100 (REST.md §3.4 / SCHEMAS §1.3).
   * Defaults are applied at the route layer.
   *
   * `before_id` / `after_id` are cursors keyed on message id (ULID, time
   * sortable). Result order is `created_at desc`; clients displaying in
   * ascending order should `.reverse()`.
   *
   * Throws `SessionNotFoundError` (→ 40401) when `sid` doesn't exist.
   */
  list(sid: string, query: MessageListQuery): Promise<PageResponse<Message>>;

  /**
   * `GET /v1/sessions/{sid}/messages/{mid}` — single message by id.
   *
   * Throws `SessionNotFoundError` (→ 40401) when `sid` doesn't exist.
   * Throws `MessageNotFoundError` (→ 40403) when the session is known but
   * no message with `mid` lives in its history.
   */
  get(sid: string, mid: string): Promise<Message>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IMessageService = createDecorator<IMessageService>('IMessageService');

/**
 * Sentinel error — daemon's route layer catches and maps to
 * `code: 40403` (message.not_found).
 */
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
