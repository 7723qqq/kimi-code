/**
 * `ISessionService` — daemon-facing session CRUD interface (Chain 2 / P1.2).
 *
 * Wraps `IHarnessBridge.rpc.{createSession, listSessions, closeSession,
 * updateSessionMetadata}` and adapts agent-core's camelCase + number
 * timestamps to the protocol's snake_case + ISO 8601 `Z` shape (see SCHEMAS.md
 * §2). The adapter is the load-bearing piece of this chain — every later
 * service in `@moonshot-ai/services` (messages, prompts, ...) inherits this
 * camelCase ↔ snake_case + number ↔ ISO pattern.
 *
 * **Why a service layer**: REST handlers in `@moonshot-ai/daemon` are
 * disallowed from importing `@moonshot-ai/kimi-code-sdk` (anti-corruption
 * test). Routes call `accessor.get(ISessionService).<method>(...)`; the
 * adapter is here.
 *
 * **CoreAPI shape gap**: agent-core does NOT expose `getSession(id)` returning
 * a full `SessionSummary` — `getSessionMetadata` returns the smaller
 * `SessionMeta` shape. `get(id)` is implemented via `listSessions({})` +
 * filter, throwing `SessionNotFoundError` (→ 40401) when the id is absent.
 * See `SessionServiceImpl` for details + the gap documentation.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type {
  CursorQuery,
  PageResponse,
  Session,
  SessionCreate,
  SessionUpdate,
} from '@moonshot-ai/protocol';

/**
 * Listing query — `before_id`/`after_id` + `page_size` mutual exclusivity is
 * already enforced by `cursorQuerySchema`. The service layer adds an optional
 * status filter the daemon layer parses out of the REST query string.
 */
export interface SessionListQuery extends CursorQuery {
  status?: import('@moonshot-ai/protocol').SessionStatus;
}

export interface ISessionService {
  /**
   * `POST /v1/sessions` — create a new session. Requires `metadata.cwd`
   * (agent-core's `createSession` calls `requiredWorkDir`; missing cwd ⇒ throw).
   */
  create(input: SessionCreate): Promise<Session>;

  /**
   * `GET /v1/sessions` — list sessions. Cursor pagination is applied
   * client-side over `bridge.rpc.listSessions({})` (the CoreAPI surface
   * doesn't take a cursor today — see W6 STATUS Decisions). Default
   * `page_size = 20` per REST.md §1.6 is applied at the route layer, not here.
   */
  list(query: SessionListQuery): Promise<PageResponse<Session>>;

  /**
   * `GET /v1/sessions/{id}` — single session by id. Implemented as
   * `listSessions({}) + .find(id)`; throws `SessionNotFoundError` (→ 40401)
   * when not found.
   */
  get(id: string): Promise<Session>;

  /**
   * `PATCH /v1/sessions/{id}` — partial update. Backed by
   * `updateSessionMetadata` for metadata changes; `title` writes through the
   * same path (mapped onto agent-core's `SessionMeta.title`).
   * Returns the post-update Session.
   */
  update(id: string, input: SessionUpdate): Promise<Session>;

  /**
   * `DELETE /v1/sessions/{id}` — close (= soft-delete in v1) the session.
   * Backed by `bridge.rpc.closeSession({sessionId})`. CoreAPI does not
   * surface a hard delete; first daemon version conflates close == delete
   * (see W6 STATUS Decisions).
   *
   * Returns `{ deleted: true }` envelope shape per REST §3.3.
   */
  delete(id: string): Promise<{ deleted: true }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISessionService = createDecorator<ISessionService>('ISessionService');

/**
 * Sentinel error class — daemon's route layer catches this and maps to
 * `code: 40401` (session.not_found). Other errors fall through to the W4
 * `installErrorHandler` (→ 50001 internal).
 */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}
