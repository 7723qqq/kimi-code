/**
 * `workspaceRegistry` domain (L1) — `IWorkspaceRegistry` implementation.
 *
 * In-memory skeleton of the known-workspaces catalog; persistence through
 * `IAtomicDocumentStore` will replace the map in a later phase. Bound at Core scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';

import { IWorkspaceRegistry, type Workspace, type WorkspaceUpdate } from './workspaceRegistry';

export class WorkspaceRegistryService implements IWorkspaceRegistry {
  declare readonly _serviceBrand: undefined;
  private readonly workspaces = new Map<string, Workspace>();

  list(): Promise<readonly Workspace[]> {
    return Promise.resolve([...this.workspaces.values()]);
  }

  get(id: string): Promise<Workspace | undefined> {
    return Promise.resolve(this.workspaces.get(id));
  }

  createOrTouch(root: string, name?: string): Promise<Workspace> {
    const id = encodeWorkDirKey(root);
    const existing = this.workspaces.get(id);
    if (existing !== undefined) {
      const touched: Workspace = { ...existing, lastOpenedAt: Date.now() };
      this.workspaces.set(id, touched);
      return Promise.resolve(touched);
    }
    const now = Date.now();
    const ws: Workspace = {
      id,
      root,
      name: name ?? root.split('/').pop() ?? root,
      createdAt: now,
      lastOpenedAt: now,
    };
    this.workspaces.set(id, ws);
    return Promise.resolve(ws);
  }

  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined> {
    const existing = this.workspaces.get(id);
    if (existing === undefined) return Promise.resolve(undefined);
    const updated: Workspace = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
    };
    this.workspaces.set(id, updated);
    return Promise.resolve(updated);
  }

  delete(id: string): Promise<void> {
    this.workspaces.delete(id);
    return Promise.resolve(void 0);
  }
}

registerScopedService(
  LifecycleScope.Core,
  IWorkspaceRegistry,
  WorkspaceRegistryService,
  InstantiationType.Delayed,
  'workspaceRegistry',
);
