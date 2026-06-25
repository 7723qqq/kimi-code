import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IEnvironmentService } from '#/environment/environment';
import {
  IConfigRegistry,
  IConfigService,
  ISessionConfigService,
  type SessionConfigSection,
} from '#/config/config';
import { ConfigRegistry, ConfigService } from '#/config/configService';
import { SessionConfigService } from '#/config/sessionConfigService';
import { ISessionMetaStore } from '#/sessionMetaStore';
import { registerConfigServices } from '../config/stubs';
import { stubEnvironment } from '../environment/stubs';
import { registerLogServices } from '../log/stubs';

const passthroughSchema = { parse: (value: unknown) => value };

function stubSessionMetaStore(initial: Record<string, unknown> = {}) {
  let data = { ...initial };
  const store: ISessionMetaStore = {
    _serviceBrand: undefined,
    read: () => Promise.resolve({ ...data }),
    write: (patch) => {
      data = { ...data, ...patch };
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
  };
  return {
    store,
    snapshot() {
      return { ...data };
    },
  };
}

describe('ConfigRegistry', () => {
  it('registers and retrieves a section', () => {
    const reg = new ConfigRegistry();
    reg.registerSection('permission', passthroughSchema);
    expect(reg.getSection('permission')).toMatchObject({ domain: 'permission' });
    expect(reg.getSection('missing')).toBeUndefined();
  });

  it('throws when the same domain is registered twice', () => {
    const reg = new ConfigRegistry();
    reg.registerSection('permission', passthroughSchema);
    expect(() => reg.registerSection('permission', passthroughSchema)).toThrow(/already registered/);
  });

  it('deep-merges patches', () => {
    const reg = new ConfigRegistry();
    const merged = reg.merge('session', { a: 1, nested: { x: 1, y: 2 } }, { nested: { y: 3, z: 4 }, b: 2 });
    expect(merged).toEqual({ a: 1, b: 2, nested: { x: 1, y: 3, z: 4 } });
  });

  it('validates with the registered schema', () => {
    const reg = new ConfigRegistry();
    reg.registerSection('session', z.object({ modelAlias: z.string() }));
    expect(reg.validate('session', { modelAlias: 'k2' })).toEqual({ modelAlias: 'k2' });
    expect(() => reg.validate('session', { modelAlias: 1 })).toThrow();
  });

  it('returns registered defaults', () => {
    const reg = new ConfigRegistry();
    reg.registerSection('session', passthroughSchema, { defaultValue: { modelAlias: 'default' } });
    expect(reg.defaultValue('session')).toEqual({ modelAlias: 'default' });
  });
});

describe('ConfigService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let homeDir: string;

  beforeEach(async () => {
    disposables = new DisposableStore();
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-config-'));
    ix = createServices(disposables, {
      base: [registerConfigServices, registerLogServices],
      additionalServices: (reg) => {
        reg.defineInstance(IEnvironmentService, stubEnvironment(homeDir));
        reg.define(IConfigService, ConfigService);
      },
    });
  });
  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('set merges and get reads back', async () => {
    const svc = ix.get(IConfigService);
    await svc.set('session', { modelAlias: 'k2', nested: { a: 1 } });
    await svc.set('session', { nested: { b: 2 } });
    expect(svc.get('session')).toEqual({ modelAlias: 'k2', nested: { a: 1, b: 2 } });
  });

  it('persists config to config.toml', async () => {
    const svc = ix.get(IConfigService);
    await svc.set('session', { modelAlias: 'k2' });
    const text = await readFile(join(homeDir, 'config.toml'), 'utf-8');
    expect(text).toContain('[session]');
    expect(text).toContain('modelAlias = "k2"');
  });

  it('reloads config from disk', async () => {
    const svc = ix.get(IConfigService);
    await svc.set('session', { modelAlias: 'k2' });
    await svc.reload();
    expect(svc.get('session')).toEqual({ modelAlias: 'k2' });
  });

  it('fires onDidChange with the domain', async () => {
    const svc = ix.get(IConfigService);
    const fired: string[] = [];
    disposables.add(svc.onDidChange((e) => fired.push(e.domain)));
    await svc.set('session', { modelAlias: 'k2' });
    await svc.set('tool', { x: 1 });
    expect(fired).toEqual(['session', 'tool']);
  });

  it('rejects invalid patches and does not write them', async () => {
    const registry = ix.get(IConfigRegistry);
    registry.registerSection('session', z.object({ modelAlias: z.string() }));
    const svc = ix.get(IConfigService);
    await expect(svc.set('session', { modelAlias: 1 })).rejects.toThrow();
    await expect(readFile(join(homeDir, 'config.toml'), 'utf-8')).rejects.toThrow();
  });
});

describe('SessionConfigService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let sessionSection: SessionConfigSection;
  let metaStore: ReturnType<typeof stubSessionMetaStore>;

  beforeEach(() => {
    disposables = new DisposableStore();
    sessionSection = {};
    metaStore = stubSessionMetaStore();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.definePartialInstance(IConfigService, { get: <T>() => sessionSection as T });
        reg.defineInstance(ISessionMetaStore, metaStore.store);
        reg.define(ISessionConfigService, SessionConfigService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('reads the session section from global config', async () => {
    sessionSection = { modelAlias: 'k2', systemPrompt: 'hi', provider: 'p' };
    const view = ix.get(ISessionConfigService);
    await view.ready;
    expect(view.modelAlias).toBe('k2');
    expect(view.systemPrompt).toBe('hi');
    expect(view.provider).toBe('p');
    expect(view.thinkingLevel).toBeUndefined();
  });

  it('restores session metadata overrides', async () => {
    metaStore = stubSessionMetaStore({ modelAlias: 'restored', thinkingLevel: 'high' });
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.definePartialInstance(IConfigService, { get: <T>() => sessionSection as T });
        reg.defineInstance(ISessionMetaStore, metaStore.store);
        reg.define(ISessionConfigService, SessionConfigService);
      },
    });
    const view = ix.get(ISessionConfigService);
    await view.ready;
    expect(view.modelAlias).toBe('restored');
    expect(view.thinkingLevel).toBe('high');
  });

  it('setModel / setThinking persist metadata and update the view', async () => {
    const view = ix.get(ISessionConfigService);
    await view.ready;
    await view.setModel('k1');
    await view.setThinking('high');
    expect(view.modelAlias).toBe('k1');
    expect(view.thinkingLevel).toBe('high');
    expect(metaStore.snapshot()).toEqual({ modelAlias: 'k1', thinkingLevel: 'high' });
  });

  it('fires onDidChange after updates', async () => {
    const view = ix.get(ISessionConfigService);
    await view.ready;
    const changed: string[] = [];
    disposables.add(view.onDidChange((e) => changed.push(...e.changed)));
    await view.setModel('k1');
    await view.setThinking('high');
    expect(changed).toEqual(['modelAlias', 'thinkingLevel']);
  });
});
