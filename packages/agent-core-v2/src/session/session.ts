/**
 * `session` domain (L6) — session facade.
 *
 * Defines the public contract of a session: the `ISessionService` used by upper
 * layers to query status, manage child agents (`fork` / `listChildren`), and
 * run session operations (`compact` / `undo` / `archive`). The `SessionStatus`
 * model lives in `session-activity` and is re-exported here for convenience.
 * Session-scoped — one instance per session. The agent loop itself is driven
 * by `agent-lifecycle` and `turn`, not here.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IScopeHandle } from '#/_base/di/scope';
import type { SessionStatus } from '#/session-activity';

export type { SessionStatus };

export interface SessionMeta {
  readonly id: string;
  readonly title?: string;
  readonly agents?: readonly string[];
  readonly [key: string]: unknown;
}

export interface ISessionService {
  readonly _serviceBrand: undefined;
  status(): SessionStatus;
  agents(): readonly IScopeHandle[];
  fork(): Promise<IScopeHandle>;
  listChildren(): readonly IScopeHandle[];
  compact(): Promise<void>;
  undo(): Promise<void>;
  archive(): Promise<void>;
}

export const ISessionService: ServiceIdentifier<ISessionService> =
  createDecorator<ISessionService>('sessionService');
