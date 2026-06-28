/**
 * `session-lifecycle` domain (L6) — creates and tracks sessions at the process root.
 *
 * Defines the public contract of session lifecycle: the `CreateSessionOptions`
 * and the `ISessionLifecycleService` used to create sessions (`create`), look
 * up the live ones (`get` / `list`), and close them. Core-scoped — a single
 * process-wide instance owns the live session scope tree. It owns only the
 * registry of open Session scopes; querying persisted sessions (open or
 * closed) is the `sessionIndex` read model, and per-session behaviour lives in
 * the Session-scoped `session` domain.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IScopeHandle } from '#/_base/di/scope';

export interface CreateSessionOptions {
  readonly sessionId: string;
  readonly workDir: string;
}

export interface ISessionLifecycleService {
  readonly _serviceBrand: undefined;
  create(opts: CreateSessionOptions): Promise<IScopeHandle>;
  get(sessionId: string): IScopeHandle | undefined;
  list(): readonly IScopeHandle[];
  close(sessionId: string): Promise<void>;
}

export const ISessionLifecycleService: ServiceIdentifier<ISessionLifecycleService> =
  createDecorator<ISessionLifecycleService>('sessionLifecycleService');
