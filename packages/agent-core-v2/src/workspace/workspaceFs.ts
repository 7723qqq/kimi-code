/**
 * `workspace` domain (cross-cutting) — core-scope folder-picker contract.
 *
 * Defines the public contract of the host-filesystem browser
 * (`IWorkspaceFsService`) backing the workspace folder picker: listing a
 * directory's subfolders (`browse`) and the picker landing payload (`home`).
 * Core-scoped and host-fs based — it operates on arbitrary absolute paths of
 * the host, deliberately distinct from the session-scoped, kaos-sandboxed `fs`
 * domain used by tools.
 */

import type { FsBrowseResponse, FsHomeResponse } from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IWorkspaceFsService {
  readonly _serviceBrand: undefined;

  /** List subdirectories of `absPath` (defaults to `$HOME`), annotated with git state. */
  browse(absPath?: string): Promise<FsBrowseResponse>;

  /** Folder-picker landing payload: `$HOME` plus recently-opened workspace roots. */
  home(): Promise<FsHomeResponse>;
}

export const IWorkspaceFsService: ServiceIdentifier<IWorkspaceFsService> =
  createDecorator<IWorkspaceFsService>('workspaceFsService');

export const RECENT_ROOTS_LIMIT = 8;
