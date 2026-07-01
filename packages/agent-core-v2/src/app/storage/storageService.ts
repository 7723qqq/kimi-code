/**
 * `storage` domain — the bottom-most persistence substrate.
 *
 * `IStorageService` is the single, backend-pluggable byte store that every
 * other local-persistence abstraction is built on. It exposes the two
 * irreducible durable primitives side by side:
 *
 *   - `write`  — atomic whole-value replacement (the `Config` access pattern).
 *   - `append` — ordered, durable byte extension   (the `Record` access pattern).
 *
 * They are not interchangeable: building `append` on top of `write` is O(n)
 * per append, and building `write` on top of `append` yields awkward "read
 * the last value" semantics. Keeping both as first-class primitives lets each
 * implementation implement them optimally (file: `open('a')` vs tmp+rename;
 * db: `INSERT` vs `UPSERT`).
 *
 * The service is intentionally byte-oriented and scope/key-addressed: it knows
 * nothing about JSON, records, configs, versions or framing. Those concerns
 * live in the typed facades above it (`IAppendLogStore`, `IAtomicDocumentStore`).
 * Two additional tokens, `IAppendLogStorage` and `IAtomicDocumentStorage`, share
 * the `IStorageService` interface so the composition root can route the
 * append-log and atomic-document access patterns to different backends.
 *
 * `scope`/`key` are trusted internal path segments for the file implementation
 * (e.g. scope `"agents/main"`, key `"wire.jsonl"`); they are not user input.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

export interface StorageWriteOptions {
  readonly atomic?: boolean;
}

export interface StorageAppendOptions {
  readonly durable?: boolean;
}

export interface IStorageService {
  readonly _serviceBrand: undefined;

  read(scope: string, key: string): Promise<Uint8Array | undefined>;

  readStream(scope: string, key: string): AsyncIterable<Uint8Array>;

  write(scope: string, key: string, data: Uint8Array, options?: StorageWriteOptions): Promise<void>;

  append(scope: string, key: string, data: Uint8Array, options?: StorageAppendOptions): Promise<void>;

  list(scope: string, prefix?: string): Promise<readonly string[]>;

  delete(scope: string, key: string): Promise<void>;

  watch?(scope: string, key: string): Event<void>;

  flush(): Promise<void>;

  close(): Promise<void>;
}

export const IStorageService: ServiceIdentifier<IStorageService> =
  createDecorator<IStorageService>('storageService');

export const IAppendLogStorage: ServiceIdentifier<IStorageService> =
  createDecorator<IStorageService>('appendLogStorage');

export const IAtomicDocumentStorage: ServiceIdentifier<IStorageService> =
  createDecorator<IStorageService>('atomicDocumentStorage');

/**
 * `IBlobStorage` — role token for the blob-store backend.
 *
 * Like `IAppendLogStorage` and `IAtomicDocumentStorage`, this is the same
 * `IStorageService` interface under a distinct identity so the composition root
 * can route large, content-addressed blob objects to a dedicated backend
 * (e.g., S3 in a server-only deployment) while other storage roles use a
 * different backend.
 */
export const IBlobStorage: ServiceIdentifier<IStorageService> =
  createDecorator<IStorageService>('blobStorage');
