/**
 * `InMemoryStorageService` — `IStorageService` backed by in-memory maps.
 *
 * Registered as the default `IStorageService` at Core scope so scopes and
 * tests work out of the box. For durable production storage, the composition
 * root seeds a `FileStorageService` (rooted at `bootstrap.homeDir`) into the
 * Core scope via `ScopeOptions.extra`, overriding this default — the same
 * pattern `blobStoreService` uses.
 *
 * `append` concatenates into the same key slot `write` replaces, mirroring the
 * file implementation's single-namespace semantics so the two are
 * interchangeable for the facades above.
 */

import {
  DisposableStore,
  combinedDisposable,
  toDisposable,
  type IDisposable,
} from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';

import {
  IAppendLogStorage,
  IAtomicDocumentStorage,
  IBlobStorage,
  IStorageService,
  type StorageAppendOptions,
  type StorageWriteOptions,
} from './storageService';

interface WatchEntry {
  readonly emitter: Emitter<void>;
  count: number;
}

export class InMemoryStorageService implements IStorageService {
  declare readonly _serviceBrand: undefined;

  private readonly scopes = new Map<string, Map<string, Uint8Array>>();
  private readonly watchers = new Map<string, WatchEntry>();

  async read(scope: string, key: string): Promise<Uint8Array | undefined> {
    return this.scopes.get(scope)?.get(key);
  }

  async *readStream(scope: string, key: string): AsyncIterable<Uint8Array> {
    const data = this.scopes.get(scope)?.get(key);
    if (data !== undefined) yield data;
  }

  async write(
    scope: string,
    key: string,
    data: Uint8Array,
    _options: StorageWriteOptions = {},
  ): Promise<void> {
    this.bucket(scope).set(key, data);
    this.notifyWatchers(scope, key);
  }

  async append(
    scope: string,
    key: string,
    data: Uint8Array,
    _options: StorageAppendOptions = {},
  ): Promise<void> {
    const bucket = this.bucket(scope);
    const existing = bucket.get(key);
    if (existing === undefined) {
      bucket.set(key, data);
      this.notifyWatchers(scope, key);
      return;
    }
    const merged = new Uint8Array(existing.byteLength + data.byteLength);
    merged.set(existing, 0);
    merged.set(data, existing.byteLength);
    bucket.set(key, merged);
    this.notifyWatchers(scope, key);
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    const bucket = this.scopes.get(scope);
    if (bucket === undefined) return [];
    const keys = [...bucket.keys()];
    return prefix === undefined ? keys : keys.filter((key) => key.startsWith(prefix));
  }

  async delete(scope: string, key: string): Promise<void> {
    this.scopes.get(scope)?.delete(key);
    this.notifyWatchers(scope, key);
  }

  watch(scope: string, key: string): Event<void> {
    const id = this.watchKey(scope, key);
    return (listener, thisArg, disposables) => {
      let entry = this.watchers.get(id);
      if (entry === undefined) {
        entry = { emitter: new Emitter<void>(), count: 0 };
        this.watchers.set(id, entry);
      }
      entry.count++;
      const subscription = entry.emitter.event(listener, thisArg);
      let tornDown = false;
      const teardown = toDisposable(() => {
        if (tornDown) return;
        tornDown = true;
        entry!.count--;
        if (entry!.count === 0) {
          entry!.emitter.dispose();
          this.watchers.delete(id);
        }
      });
      const combined = combinedDisposable(subscription, teardown);
      if (disposables instanceof DisposableStore) {
        disposables.add(combined);
      } else if (disposables !== undefined) {
        (disposables as IDisposable[]).push(combined);
      }
      return combined;
    };
  }

  private notifyWatchers(scope: string, key: string): void {
    this.watchers.get(this.watchKey(scope, key))?.emitter.fire();
  }

  private watchKey(scope: string, key: string): string {
    return `${scope}\0${key}`;
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}

  private bucket(scope: string): Map<string, Uint8Array> {
    let bucket = this.scopes.get(scope);
    if (bucket === undefined) {
      bucket = new Map();
      this.scopes.set(scope, bucket);
    }
    return bucket;
  }
}

registerScopedService(
  LifecycleScope.Core,
  IStorageService,
  InMemoryStorageService,
  InstantiationType.Delayed,
  'storage',
);

registerScopedService(
  LifecycleScope.Core,
  IAppendLogStorage,
  InMemoryStorageService,
  InstantiationType.Delayed,
  'storage',
);

registerScopedService(
  LifecycleScope.Core,
  IAtomicDocumentStorage,
  InMemoryStorageService,
  InstantiationType.Delayed,
  'storage',
);

registerScopedService(
  LifecycleScope.Core,
  IBlobStorage,
  InMemoryStorageService,
  InstantiationType.Delayed,
  'storage',
);
