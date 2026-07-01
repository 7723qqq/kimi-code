/**
 * `storage` domain (L1) — `IAtomicDocumentStore` contract and its JSON/TOML
 * implementations.
 *
 * The atomic-document access-pattern store: one typed value per `(scope,
 * key)`, replaced atomically on every write. Serialization is delegated to a
 * `DocumentCodec` so the same access pattern serves different on-disk formats:
 * `jsonDocumentCodec` backs the default `AtomicDocumentStore` (cron/background/
 * session metadata) and `tomlDocumentCodec` backs `TomlAtomicDocumentStore`
 * (the `config` document). Reads and writes bytes through `IStorageService`
 * (the config document) or `IAtomicDocumentStorage` (everyone else). Bound at
 * App scope.
 */

import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { InstantiationType } from '#/_base/di/extensions';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Event } from '#/_base/event';

import { IAtomicDocumentStorage, IStorageService } from './storageService';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface DocumentCodec {
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

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

export interface IAtomicDocumentStore {
  readonly _serviceBrand: undefined;

  get<T>(scope: string, key: string): Promise<T | undefined>;

  set<T>(scope: string, key: string, value: T): Promise<void>;

  delete(scope: string, key: string): Promise<void>;

  list(scope: string, prefix?: string): Promise<readonly string[]>;

  watch(scope: string, key: string): Event<void>;

  acquire(scope: string, key: string): IDisposable;
}

export const IAtomicDocumentStore: ServiceIdentifier<IAtomicDocumentStore> =
  createDecorator<IAtomicDocumentStore>('atomicDocumentStore');

export const IAtomicTomlDocumentStore: ServiceIdentifier<IAtomicDocumentStore> =
  createDecorator<IAtomicDocumentStore>('atomicTomlDocumentStore');

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
