import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAtomicDocumentStorage, IAtomicDocumentStore } from '#/storage';
import { AtomicDocumentStore } from '#/storage/atomicDocumentStore';
import { InMemoryStorageService } from '#/storage/inMemoryStorageService';

interface State {
  readonly title?: string;
  readonly count?: number;
}

describe('AtomicDocumentStore', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let storage: InMemoryStorageService;
  let config: IAtomicDocumentStore;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    storage = new InMemoryStorageService();
    ix.stub(IAtomicDocumentStorage, storage);
    ix.set(IAtomicDocumentStore, new SyncDescriptor(AtomicDocumentStore));
    config = ix.get(IAtomicDocumentStore);
  });

  afterEach(() => disposables.dispose());

  it('get returns undefined for a missing key', async () => {
    expect(await config.get('session', 'state.json')).toBeUndefined();
  });

  it('set + get round-trips a value', async () => {
    await config.set<State>('session', 'state.json', { title: 'hello', count: 1 });
    expect(await config.get<State>('session', 'state.json')).toEqual({ title: 'hello', count: 1 });
  });

  it('set atomically replaces the previous value', async () => {
    await config.set<State>('session', 'state.json', { title: 'old' });
    await config.set<State>('session', 'state.json', { title: 'new', count: 2 });
    expect(await config.get<State>('session', 'state.json')).toEqual({ title: 'new', count: 2 });
  });

  it('keys are independent', async () => {
    await config.set<State>('session', 'a.json', { title: 'A' });
    await config.set<State>('session', 'b.json', { title: 'B' });
    expect(await config.get<State>('session', 'a.json')).toEqual({ title: 'A' });
    expect(await config.get<State>('session', 'b.json')).toEqual({ title: 'B' });
  });

  it('scopes are isolated', async () => {
    await config.set<State>('scope-a', 'k', { title: 'A' });
    await config.set<State>('scope-b', 'k', { title: 'B' });
    expect(await config.get<State>('scope-a', 'k')).toEqual({ title: 'A' });
    expect(await config.get<State>('scope-b', 'k')).toEqual({ title: 'B' });
  });

  it('delete removes a key; missing delete is a no-op', async () => {
    await config.set<State>('session', 'state.json', { title: 'x' });
    await config.delete('session', 'state.json');
    expect(await config.get('session', 'state.json')).toBeUndefined();
    await expect(config.delete('session', 'state.json')).resolves.toBeUndefined();
  });

  it('list returns keys, optionally filtered by prefix', async () => {
    await config.set('session', 'job-1', {});
    await config.set('session', 'job-2', {});
    await config.set('session', 'state.json', {});
    expect((await config.list('session')).toSorted()).toEqual(['job-1', 'job-2', 'state.json']);
    expect((await config.list('session', 'job-')).toSorted()).toEqual(['job-1', 'job-2']);
  });

  it('value is persisted through the underlying IStorageService', async () => {
    await config.set<State>('session', 'state.json', { title: 'x' });
    const raw = new TextDecoder().decode(await storage.read('session', 'state.json'));
    expect(JSON.parse(raw)).toEqual({ title: 'x' });
  });
});
