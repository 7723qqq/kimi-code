/**
 * `hostFs` domain (L1) — local real-filesystem primitives.
 *
 * Defines the `IHostFileSystem` used by the program side (persistence, skill
 * loading, workspace registry) and the os file tools to read and write files on
 * the real local disk, plus the stat/entry models. App-scoped — one shared
 * instance.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { TextDecodeErrors } from '#/_base/execEnv';

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
  /**
   * Read bytes from `path`. When `n` is given, reads at most the first `n`
   * bytes (a ranged/prefix read); otherwise reads the whole file. The ranged
   * form is used by callers that only need a header (e.g. file-type sniffing)
   * so they never load a large file just to inspect its first bytes.
   */
  readBytes(path: string, n?: number): Promise<Uint8Array>;
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /**
   * Stream the lines of a UTF-8 (or other `encoding`) text file, yielding each
   * line including its trailing terminator. `errors` mirrors Python's text
   * decode error handling (`strict` throws on invalid bytes, used by the Read
   * tool to surface non-UTF-8 files). Streaming lets callers paginate and
   * stop early without loading the whole file.
   */
  readLines(
    path: string,
    options?: { encoding?: BufferEncoding; errors?: TextDecodeErrors },
  ): AsyncGenerator<string>;
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
