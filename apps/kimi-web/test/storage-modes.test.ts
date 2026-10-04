import { beforeEach, describe, expect, it } from 'vitest';

import {
  loadHiddenWorkspaces,
  loadModeMap,
  saveHiddenWorkspaces,
  saveModeMap,
} from '../src/lib/storage';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  const backing = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => void store.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: backing, configurable: true });
});

describe('loadModeMap / saveModeMap', () => {
  it('round-trips a boolean map, keeping only true entries', () => {
    saveModeMap('k.test.modes', { s1: true, s2: false, s3: true });
    expect(loadModeMap('k.test.modes')).toEqual({ s1: true, s3: true });
  });

  it('returns an empty map for a missing key', () => {
    expect(loadModeMap('k.test.missing')).toEqual({});
  });

  it('discards non-object payloads (legacy bare-string format)', () => {
    store.set('k.test.modes', 'true');
    expect(loadModeMap('k.test.modes')).toEqual({});
  });

  it('discards array payloads', () => {
    store.set('k.test.modes', JSON.stringify(['s1']));
    expect(loadModeMap('k.test.modes')).toEqual({});
  });

  it('returns an empty map for corrupt JSON', () => {
    store.set('k.test.modes', '{not json');
    expect(loadModeMap('k.test.modes')).toEqual({});
  });
});

describe('loadHiddenWorkspaces / saveHiddenWorkspaces', () => {
  it('round-trips the removed-root list', () => {
    saveHiddenWorkspaces(['/home/u/a', '/home/u/b']);
    expect(loadHiddenWorkspaces()).toEqual(['/home/u/a', '/home/u/b']);
  });

  it('returns an empty list when unset or malformed', () => {
    expect(loadHiddenWorkspaces()).toEqual([]);
    store.set('kimi-web.hidden-workspaces', '{"not":"an array"}');
    expect(loadHiddenWorkspaces()).toEqual([]);
  });

  it('filters non-string entries', () => {
    store.set('kimi-web.hidden-workspaces', JSON.stringify(['/ok', 3, null]));
    expect(loadHiddenWorkspaces()).toEqual(['/ok']);
  });
});