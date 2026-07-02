/**
 * `session` domain (L6) — session command service.
 *
 * Defines the public contract for session-level commands: `ISessionService`
 * runs operations that mutate session-level state and coordinate across the
 * session's sub-services (e.g. `archive`). Read views live on their own
 * services (`sessionActivity`, `agentLifecycle`, `sessionMetadata`); this
 * facade owns only commands. Session-scoped — one instance per session.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionService {
  readonly _serviceBrand: undefined;
  archive(): Promise<void>;
}

export const ISessionService: ServiceIdentifier<ISessionService> =
  createDecorator<ISessionService>('sessionService');
