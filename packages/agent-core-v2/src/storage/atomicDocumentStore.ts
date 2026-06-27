/**
 * `IAtomicDocumentStore` / `AtomicDocumentStore` — the atomic-document
 * access-pattern store.
 *
 * Sits on top of `IStorageService` and stores one typed JSON value per
 * `(scope, key)`, replaced atomically on every write. This is the atomic-
 * document access pattern: `state.json`, `upcoming-goals.json`, per-id
 * cron/background records, etc.
 *
 * It is a DI service: any domain that needs an atomic document injects
 * `IAtomicDocumentStore` and calls `get/set` with the scope it owns — it does
 * not construct stores itself. JSON (de)serialization and atomic replacement
 * are centralized here so domains do not reimplement them.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IAtomicDocumentStorage, IStorageService } from './storageService';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface IAtomicDocumentStore {
  readonly _serviceBrand: undefined;

  /** Read the value at `(scope, key)`, or `undefined` when absent. */
  get<T>(scope: string, key: string): Promise<T | undefined>;

  /** Atomically replace the value at `(scope, key)`. */
  set<T>(scope: string, key: string, value: T): Promise<void>;

  /** Delete `(scope, key)`. Missing keys are not an error. */
  delete(scope: string, key: string): Promise<void>;

  /** List the keys under `scope`, optionally filtered by `prefix`. */
  list(scope: string, prefix?: string): Promise<readonly string[]>;

  /**
   * Acquire a disposable handle for `(scope, key)`. Register it with your
   * `Disposable`; when you are disposed, the handle is released. The shared
   * store itself is not disposed. Atomic documents are durable on write, so
   * the handle currently releases no resources; it exists for interface
   * symmetry with `IAppendLogStore`.
   */
  acquire(scope: string, key: string): IDisposable;
}

export const IAtomicDocumentStore: ServiceIdentifier<IAtomicDocumentStore> =
  createDecorator<IAtomicDocumentStore>('atomicDocumentStore');

export class AtomicDocumentStore implements IAtomicDocumentStore {
  declare readonly _serviceBrand: undefined;

  constructor(@IAtomicDocumentStorage private readonly storage: IStorageService) {}

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    const bytes = await this.storage.read(scope, key);
    return bytes === undefined ? undefined : (JSON.parse(textDecoder.decode(bytes)) as T);
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    await this.storage.write(scope, key, textEncoder.encode(JSON.stringify(value)), {
      atomic: true,
    });
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.storage.delete(scope, key);
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    return this.storage.list(scope, prefix);
  }

  acquire(scope: string, key: string): IDisposable {
    return toDisposable(() => {});
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAtomicDocumentStore,
  AtomicDocumentStore,
  InstantiationType.Delayed,
  'storage',
);
