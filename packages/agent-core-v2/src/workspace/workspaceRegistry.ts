/**
 * `workspace` domain (cross-cutting) — core-scope workspace registry contract.
 *
 * Defines the public contract of the persistent, process-wide catalog of known
 * workspaces (`IWorkspaceRegistry`): the `Workspace` records keyed by a stable
 * `wd_<slug>_<hash>` id, plus the `WorkspacePatch` used to rename one. Core-
 * scoped — one shared registry for the whole process. Backed by
 * `<homeDir>/workspaces.json`; session counts are delegated to `ISessionStore`
 * so this domain never reaches into the session store's on-disk layout.
 */

import type { Workspace } from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface WorkspacePatch {
  name?: string;
}

export interface IWorkspaceRegistry {
  readonly _serviceBrand: undefined;

  /** List every registered workspace, most-recently-opened first. */
  list(): Promise<Workspace[]>;

  /** Fetch a single workspace by id; throws `WorkspaceError` (workspace.not_found) if absent. */
  get(workspaceId: string): Promise<Workspace>;

  /**
   * Register `root` (idempotent): creates the entry on first sight, otherwise
   * bumps `last_opened_at`. Throws `WorkspaceError` (fs.path_not_found) when
   * `root` does not exist on disk.
   */
  createOrTouch(root: string, name?: string): Promise<Workspace>;

  /** Rename a workspace (display name only). */
  update(workspaceId: string, patch: WorkspacePatch): Promise<Workspace>;

  /** Unregister a workspace (does not remove on-disk content). */
  delete(workspaceId: string): Promise<void>;

  /** Resolve a workspace id back to its absolute root path. */
  resolveRoot(workspaceId: string): Promise<string>;
}

export const IWorkspaceRegistry: ServiceIdentifier<IWorkspaceRegistry> =
  createDecorator<IWorkspaceRegistry>('workspaceRegistry');
