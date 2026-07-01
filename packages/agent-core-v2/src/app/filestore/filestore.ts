/**
 * `filestore` domain (L2) — `IFileStore` contract.
 *
 * Process-global upload store backing the `/files` REST endpoints: persists
 * uploaded bytes in the `IBlobStorage` backend and their `FileMeta` index in the
 * same byte store, then hands callers a stream back on download. The v1
 * `IFileStore` returned a filesystem `blobPath`; here the byte-store substrate
 * is stream-oriented, so `get` yields a `Readable` instead. Bound at App scope.
 */

import type { Readable } from 'node:stream';

import type { FileMeta } from '@moonshot-ai/protocol';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/** Hard upload cap mirrored from the v1 server (50 MiB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface SaveOptions {
  /** Display name override; defaults to the uploaded filename. */
  readonly name?: string;
  /** MIME type; defaults to `application/octet-stream`. */
  readonly mimeType?: string;
  /** Optional TTL in seconds; recorded as `expires_at` on the metadata. */
  readonly expiresInSec?: number;
}

export interface GetResult {
  readonly meta: FileMeta;
  /** Bytes of the stored blob, streamed from the backend. */
  readonly stream: Readable;
}

export interface IFileStore {
  readonly _serviceBrand: undefined;

  save(source: Readable, filename: string, options?: SaveOptions): Promise<FileMeta>;

  get(fileId: string): Promise<GetResult>;

  delete(fileId: string): Promise<void>;
}

export const IFileStore: ServiceIdentifier<IFileStore> = createDecorator<IFileStore>('fileStore');
