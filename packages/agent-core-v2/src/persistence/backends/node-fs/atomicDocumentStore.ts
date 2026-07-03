/**
 * `AtomicDocumentStore` — node-fs backend for `IAtomicDocumentStore`.
 *
 * JSON and TOML codec implementations plus the `AtomicDocumentStoreBase`,
 * `AtomicDocumentStore`, and `TomlAtomicDocumentStore` classes. Reads and
 * writes bytes through `IStorageService` / `IAtomicDocumentStorage`. Bound at
 * App scope.
 */

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { InstantiationType } from '#/_base/di/extensions';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Event } from '#/_base/event';

import { IAtomicDocumentStorage, IStorageService } from '#/persistence/interface/storage';
import {
  IAtomicDocumentStore,
  IAtomicTomlDocumentStore,
  type DocumentCodec,
} from '#/persistence/interface/atomicDocumentStore';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const jsonDocumentCodec: DocumentCodec = {
  encode(value: unknown): Uint8Array {
    return textEncoder.encode(JSON.stringify(value));
  },
  decode(bytes: Uint8Array): unknown {
    return JSON.parse(textDecoder.decode(bytes));
  },
};

export const tomlDocumentCodec: DocumentCodec = {
  encode(value: unknown): Uint8Array {
    return textEncoder.encode(`${stringifyToml(value as Record<string, unknown>)}\n`);
  },
  decode(bytes: Uint8Array): unknown {
    const text = textDecoder.decode(bytes);
    if (text.trim().length === 0) return {};
    return parseToml(text);
  },
};

class AtomicDocumentStoreBase implements IAtomicDocumentStore {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly storage: IStorageService,
    private readonly codec: DocumentCodec,
  ) {}

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    const bytes = await this.storage.read(scope, key);
    return bytes === undefined ? undefined : (this.codec.decode(bytes) as T);
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    await this.storage.write(scope, key, this.codec.encode(value), { atomic: true });
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.storage.delete(scope, key);
  }

  async list(scope: string, prefix?: string): Promise<readonly string[]> {
    return this.storage.list(scope, prefix);
  }

  watch(scope: string, key: string): Event<void> {
    return this.storage.watch?.(scope, key) ?? (Event.None as Event<void>);
  }

  acquire(_scope: string, _key: string): IDisposable {
    return toDisposable(() => {});
  }
}

export class AtomicDocumentStore extends AtomicDocumentStoreBase {
  constructor(@IAtomicDocumentStorage storage: IStorageService) {
    super(storage, jsonDocumentCodec);
  }
}

export class TomlAtomicDocumentStore extends AtomicDocumentStoreBase {
  constructor(@IStorageService storage: IStorageService) {
    super(storage, tomlDocumentCodec);
  }
}

registerScopedService(
  LifecycleScope.App,
  IAtomicDocumentStore,
  AtomicDocumentStore,
  InstantiationType.Delayed,
  'storage',
);

registerScopedService(
  LifecycleScope.App,
  IAtomicTomlDocumentStore,
  TomlAtomicDocumentStore,
  InstantiationType.Delayed,
  'storage',
);
