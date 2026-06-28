/**
 * `session-lifecycle` domain (L6) — `ISessionLifecycleService` implementation.
 *
 * Owns the process-wide registry of open Session child scopes, creating them
 * through the DI scope tree. Bound at Core scope. Persisting the session
 * record and rooting its per-session storage are wired by the composition
 * root; querying the persisted set is the `sessionIndex` read model.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import {
  createScopedChildHandle,
  type IScopeHandle,
  LifecycleScope,
  registerScopedService,
} from '#/_base/di/scope';

import { type CreateSessionOptions, ISessionLifecycleService } from './sessionLifecycle';

export class SessionLifecycleService implements ISessionLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, IScopeHandle>();

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {}

  create(opts: CreateSessionOptions): Promise<IScopeHandle> {
    const handle = createScopedChildHandle(
      this.instantiation,
      LifecycleScope.Session,
      opts.sessionId,
    );
    this.sessions.set(opts.sessionId, handle);
    return Promise.resolve(handle);
  }

  get(sessionId: string): IScopeHandle | undefined {
    return this.sessions.get(sessionId);
  }

  list(): readonly IScopeHandle[] {
    return [...this.sessions.values()];
  }

  close(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }
}

registerScopedService(
  LifecycleScope.Core,
  ISessionLifecycleService,
  SessionLifecycleService,
  InstantiationType.Delayed,
  'session-lifecycle',
);
