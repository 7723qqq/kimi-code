/**
 * `workspaceLifecycle` domain — workspace handler lifecycle contract.
 *
 * Defines the `IWorkspaceLifecycleService`, the App-scope owner of the live
 * workspace handler registry: one `IWorkspaceScopeHandle` per workspaceId,
 * materialized on demand through `handlerFor` (create-or-get with the
 * in-flight join of the backing `IWorkspaceInstanceManager`, so concurrent
 * sessions of one workspace never duplicate a handler) and never closed
 * afterwards — handlers die with the App scope. The implementation rides on
 * the upstream workspace instance manager: each handle wraps a
 * `WorkspaceInstance` and lazily exposes its program's
 * `ISessionLifecycleService` controller. Read side: `handlers.list()` and
 * `sessions.list(workspaceId)`, plus `onDidMaterializeHandler` for App-scope
 * observers that must follow every handler's per-handler services. There is
 * deliberately NO App-scope session lifecycle entry point — session
 * create/resume/fork lives on the handler's `ISessionLifecycleService`;
 * callers compose `sessionIndex` → `handlerFor` → handler.
 */

import {
  createDecorator,
  type ServiceIdentifier,
  type ServicesAccessor,
} from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export interface IWorkspaceScopeHandle {
  readonly id: string;
  readonly accessor: ServicesAccessor;
  dispose(): void;
}

export type WorkspaceRef =
  | { readonly workspaceId: string; readonly root?: string }
  | { readonly root: string };

export interface WorkspaceHandlerRegistry {
  list(): readonly IWorkspaceScopeHandle[];
}

export interface WorkspaceSessionRegistry {
  list(workspaceId: string): readonly string[];
}

export interface IWorkspaceLifecycleService {
  readonly _serviceBrand: undefined;

  readonly onDidMaterializeHandler: Event<IWorkspaceScopeHandle>;
  handlerFor(ref: WorkspaceRef): Promise<IWorkspaceScopeHandle>;
  readonly handlers: WorkspaceHandlerRegistry;
  readonly sessions: WorkspaceSessionRegistry;
}

export const IWorkspaceLifecycleService: ServiceIdentifier<IWorkspaceLifecycleService> =
  createDecorator<IWorkspaceLifecycleService>('workspaceLifecycleService');
