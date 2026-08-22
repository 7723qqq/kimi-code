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
