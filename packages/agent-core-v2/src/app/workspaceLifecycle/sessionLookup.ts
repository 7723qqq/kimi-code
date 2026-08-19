/**
 * `workspaceLifecycle` domain — pure session-lookup helpers over the handler chain.
 *
 * The explicit `sessionIndex` → `IWorkspaceLifecycleService.handlerFor` →
 * handler `ISessionLifecycleService` composition, shared by every caller
 * that addresses a session by id from outside the Workspace scope (edge
 * routes, in-process SDKs). These are plain functions over a STABLE
 * accessor (a `Scope` / scope-handle `accessor`, never a transient
 * `invokeFunction` one) — they are not an App-scope session lifecycle
 * facade: the live registry and every lifecycle method stay on the
 * handler's own service. Own no scoped state.
 */

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ErrorCodes, isError2 } from '#/errors';
import {
  ISessionLifecycleService,
  type ResumeSessionOptions,
} from '#/workspace/sessionLifecycle/sessionLifecycle';

import { IWorkspaceLifecycleService, type IWorkspaceScopeHandle } from './workspaceLifecycle';

export async function handlerForSession(
  accessor: ServicesAccessor,
  sessionId: string,
): Promise<IWorkspaceScopeHandle | undefined> {
  const summary = await accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) return undefined;
  try {
    return await accessor
      .get(IWorkspaceLifecycleService)
      .handlerFor({ workspaceId: summary.workspaceId, root: summary.cwd });
  } catch (error) {
    if (isError2(error) && error.code === ErrorCodes.WORKSPACE_NOT_FOUND) return undefined;
    throw error;
  }
}

export async function resumeSessionById(
  accessor: ServicesAccessor,
  sessionId: string,
  opts?: ResumeSessionOptions,
): Promise<ISessionScopeHandle | undefined> {
  try {
    return await accessor.get(ISessionManager).resume(sessionId, opts);
  } catch (error) {
    accessor
      .get(ITelemetryService)
      .withContext({ sessionId })
      .track2('session_load_failed', {
        reason: isError2(error) ? error.code : error instanceof Error ? error.name : 'unknown',
      });
    throw error;
  }
}

export function liveHandlerForSession(
  accessor: ServicesAccessor,
  sessionId: string,
): IWorkspaceScopeHandle | undefined {
  for (const handler of accessor.get(IWorkspaceLifecycleService).handlers.list()) {
    if (handler.accessor.get(ISessionLifecycleService).get(sessionId) !== undefined) {
      return handler;
    }
  }
  return undefined;
}

export function getLiveSessionById(
  accessor: ServicesAccessor,
  sessionId: string,
): ISessionScopeHandle | undefined {
  return accessor.get(ISessionManager).get(sessionId);
}

export async function closeSessionById(
  accessor: ServicesAccessor,
  sessionId: string,
): Promise<void> {
  await accessor.get(ISessionManager).close(sessionId);
}

export function followWorkspaceHandlers(
  accessor: ServicesAccessor,
  follow: (service: ISessionLifecycleService) => IDisposable,
): IDisposable {
  const lifecycle = accessor.get(IWorkspaceLifecycleService);
  const store = new DisposableStore();
  for (const handler of lifecycle.handlers.list()) {
    store.add(follow(handler.accessor.get(ISessionLifecycleService)));
  }
  store.add(
    lifecycle.onDidMaterializeHandler((handler) => {
      if (!store.isDisposed) {
        store.add(follow(handler.accessor.get(ISessionLifecycleService)));
      }
    }),
  );
  return store;
}

type SessionLifecycleEvents = Required<
  Pick<ISessionManager, 'onDidCloseSession' | 'onDidArchiveSession'>
>;

export function followSessionLifecycles(
  accessor: ServicesAccessor,
  follow: (service: SessionLifecycleEvents) => IDisposable,
): IDisposable {
  const manager = accessor.get(ISessionManager);
  if (manager.onDidCloseSession === undefined || manager.onDidArchiveSession === undefined) {
    return { dispose: () => {} };
  }
  return follow(manager as SessionLifecycleEvents);
}
