/**
 * `hostFs` domain (L1) — local real-filesystem primitives.
 *
 * Defines the `IHostFileSystem` used by the program side (persistence, skill
 * loading, workspace registry) to read and write the app's own files on the
 * real local disk, plus the stat/entry models. App-scoped — one shared
 * instance. The Agent side never injects this directly; its local backend
 * reuses it internally.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface HostFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly size: number;
}

export interface HostDirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

export interface IHostFileSystem {
  readonly _serviceBrand: undefined;

  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /**
   * Create a file exclusively with `data`. Returns `true` when the file was
   * created, `false` when it already existed (EEXIST) — the existing content is
   * left untouched. Used by content-addressed stores where a collision means
   * the same bytes are already present.
   */
  createExclusive(path: string, data: Uint8Array): Promise<boolean>;
  stat(path: string): Promise<HostFileStat>;
  readdir(path: string): Promise<readonly HostDirEntry[]>;
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  remove(path: string): Promise<void>;
}

export const IHostFileSystem: ServiceIdentifier<IHostFileSystem> =
  createDecorator<IHostFileSystem>('hostFileSystem');
