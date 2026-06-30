/**
 * `session-lifecycle` domain (L6) — creates and tracks sessions at the process root.
 *
 * Defines the public contract of session lifecycle: the `CreateSessionOptions`,
 * `ForkSessionOptions`, and the `ISessionLifecycleService` used to create
 * sessions (`create`), look up the live ones (`get` / `list`), close them
 * (`close`), archive them (`archive`), and fork them (`fork`). App-scoped — a
 * single process-wide instance owns the live session scope tree. Persisted
 * sessions (open or closed) are the `session-index` read model; per-session
 * behaviour lives in the Session-scoped domains.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IScopeHandle } from '#/_base/di/scope';

export interface CreateSessionOptions {
  readonly sessionId: string;
  readonly workDir: string;
}

export interface ForkSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  /** Title for the forked session. Defaults to `Fork: <source title or id>`. */
  readonly title?: string;
  /** Custom metadata merged (minus reserved `goal`) into the forked session. */
  readonly metadata?: Record<string, unknown>;
}

export interface ISessionLifecycleService {
  readonly _serviceBrand: undefined;
  create(opts: CreateSessionOptions): Promise<IScopeHandle>;
  get(sessionId: string): IScopeHandle | undefined;
  list(): readonly IScopeHandle[];
  close(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  fork(opts: ForkSessionOptions): Promise<IScopeHandle>;
}

export const ISessionLifecycleService: ServiceIdentifier<ISessionLifecycleService> =
  createDecorator<ISessionLifecycleService>('sessionLifecycleService');
