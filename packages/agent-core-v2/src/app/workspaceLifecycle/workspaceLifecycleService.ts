/**
 * `workspaceLifecycle` domain — `IWorkspaceLifecycleService` implementation.
 *
 * Rides on the upstream `IWorkspaceInstanceManager` (App scope): `handlerFor`
 * delegates to `getOrCreate` (create-or-get with the manager's in-flight
 * join keyed by workspaceId), `handlers.list()` maps the manager's instances
 * and `onDidMaterializeHandler` forwards the manager's change events. Each
 * handle wraps a `WorkspaceInstance`; its `accessor` resolves
 * `ISessionLifecycleService` lazily through `program.createSessionController`
 * (one cached controller per handler, disposed with the handle — handlers
 * are never closed, they die with the App scope's disposal cascade).
 * `sessions.list(workspaceId)` is the live-session projection of the
 * App-scope `ISessionManager` filtered by workspace. Bound at App scope.
 */

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { Emitter, type Event } from '#/_base/event';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { LifecycleScope } from '#/app/scopes';
import { BugIndicatingError } from '#/errors';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';

import {
  IWorkspaceLifecycleService,
  type IWorkspaceScopeHandle,
  type WorkspaceHandlerRegistry,
  type WorkspaceRef,
  type WorkspaceSessionRegistry,
} from './workspaceLifecycle';

export class WorkspaceLifecycleService extends Service implements IWorkspaceLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly controllers = new Map<string, SessionLifecycleService>();
  private readonly handles = new Map<string, IWorkspaceScopeHandle>();
  private readonly _onDidMaterializeHandler = this._register(new Emitter<IWorkspaceScopeHandle>());
  readonly onDidMaterializeHandler: Event<IWorkspaceScopeHandle> =
    this._onDidMaterializeHandler.event;

  readonly handlers: WorkspaceHandlerRegistry = {
    list: () => this.manager.list().map((instance) => this.handleOf(instance)),
  };

  readonly sessions: WorkspaceSessionRegistry = {
    list: (workspaceId: string) =>
      this.sessionManager
        .list()
        .filter((handle) => handle.accessor.get(ISessionContext).workspaceId === workspaceId)
        .map((handle) => handle.id),
  };

  constructor(
    @IWorkspaceInstanceManager private readonly manager: IWorkspaceInstanceManager,
    @ISessionManager private readonly sessionManager: ISessionManager,
  ) {
    super();
    this._register(
      this.manager.onDidChange(({ instance }) => {
        if (instance !== undefined) {
          this._onDidMaterializeHandler.fire(this.handleOf(instance));
        }
      }),
    );
  }

  async handlerFor(ref: WorkspaceRef): Promise<IWorkspaceScopeHandle> {
    const instance = await this.manager.getOrCreate(ref);
    return this.handleOf(instance);
  }

  private handleOf(instance: WorkspaceInstance): IWorkspaceScopeHandle {
    const existing = this.handles.get(instance.id);
    if (existing !== undefined) return existing;
    const handle: IWorkspaceScopeHandle = {
      id: instance.id,
      accessor: {
        get: <T>(serviceId: unknown): T => {
          if (serviceId === ISessionLifecycleService) {
            return this.controllerOf(instance) as unknown as T;
          }
          throw new BugIndicatingError(
            `workspace handler of ${instance.id} only resolves ISessionLifecycleService`,
          );
        },
      },
      dispose: () => {
        this.handles.delete(instance.id);
        const controller = this.controllers.get(instance.id);
        if (controller !== undefined) {
          this.controllers.delete(instance.id);
          controller.dispose();
        }
      },
    };
    this.handles.set(instance.id, handle);
    return handle;
  }

  private controllerOf(instance: WorkspaceInstance): SessionLifecycleService {
    const existing = this.controllers.get(instance.id);
    if (existing !== undefined) return existing;
    const controller = instance.program.createSessionController();
    this.controllers.set(instance.id, controller);
    return controller;
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceLifecycleService,
  WorkspaceLifecycleService,
  ScopeActivation.OnScopeCreated,
  'workspaceLifecycle',
);
