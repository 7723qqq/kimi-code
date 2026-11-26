import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type { ProjectInstance, WorkspaceInstanceSnapshot } from '../../project/projectInstance/projectInstance';

export type WorkspaceInstanceRef =
  | { readonly workspaceId: string; readonly root?: string }
  | { readonly root: string };

export interface WorkspaceInstanceChange {
  readonly workspaceId: string;
  readonly instance?: ProjectInstance;
}

export interface WorkspaceInstancesSnapshot {
  readonly workspaces: readonly WorkspaceInstanceSnapshot[];
}

export interface WorkspaceInstanceLease {
  readonly instance: ProjectInstance;
  dispose(): void;
}

export interface IProjectInstanceManager {
  readonly _serviceBrand: undefined;
  readonly onDidChange: Event<WorkspaceInstanceChange>;
  acquire(ref: WorkspaceInstanceRef): Promise<WorkspaceInstanceLease>;
  get(workspaceId: string): ProjectInstance | undefined;
  findByRoot(root: string): ProjectInstance | undefined;
  findContaining(cwd: string): ProjectInstance | undefined;
  list(): readonly ProjectInstance[];
  snapshot(): WorkspaceInstancesSnapshot;
}

export const IProjectInstanceManager: ServiceIdentifier<IProjectInstanceManager> = createDecorator<IProjectInstanceManager>('workspaceInstanceManager');
