import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IBootstrapService } from '#/bootstrap';
import {
  ConfigScope,
  ConfigTarget,
  IConfigRegistry,
  IConfigService,
  type ConfigSectionChangedEvent,
} from '#/config/config';
import { ConfigRegistry, ConfigService } from '#/config/configService';
import { FileStorageService, IStorageService } from '#/storage';
import { ProvidersSectionSchema } from '#/provider/provider';
import {
  providersEnvBindings,
  providersFromToml,
  providersToToml,
  stripProvidersEnv,
} from '#/provider/configSection';
import { kimiModelEnvOverlay } from '#/provider/envOverlay';
import {
  LOOP_CONTROL_SECTION,
  LoopControlSchema,
  loopControlFromToml,
  loopControlToToml,
} from '#/loop/configSection';
import { stubBootstrap } from '../bootstrap/stubs';
import { registerConfigServices } from '../config/stubs';
import { registerLogServices } from '../log/stubs';

const passthroughSchema = { parse: (value: unknown) => value };

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
        reg.defineInstance(IBootstrapService, stubBootstrap(homeDir));
        reg.defineInstance(IStorageService, new FileStorageService(homeDir));
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
    expect(text).toContain('model_alias = "k2"');
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

  it('onDidSectionChange fires only when the delivered value changes', async () => {
    const svc = ix.get(IConfigService);
    const sectionFired: string[] = [];
    const changeFired: string[] = [];
    disposables.add(svc.onDidSectionChange((e) => sectionFired.push(e.domain)));
    disposables.add(svc.onDidChange((e) => changeFired.push(e.domain)));

    await svc.set('session', { modelAlias: 'k2' });
    await svc.set('session', { modelAlias: 'k2' });
    await svc.set('session', { modelAlias: 'k9' });

    expect(sectionFired).toEqual(['session', 'session']);
    expect(changeFired).toEqual(['session', 'session', 'session']);
  });

  it('change events carry value and previousValue', async () => {
    const svc = ix.get(IConfigService);
    const events: ConfigSectionChangedEvent[] = [];
    disposables.add(svc.onDidSectionChange((e) => events.push(e)));

    await svc.set('session', { modelAlias: 'k2' });
    await svc.set('session', { modelAlias: 'k9' });

    expect(events).toEqual([
      { domain: 'session', source: 'set', value: { modelAlias: 'k2' }, previousValue: undefined },
      { domain: 'session', source: 'set', value: { modelAlias: 'k9' }, previousValue: { modelAlias: 'k2' } },
    ]);
  });

  it('rejects invalid patches and does not write them', async () => {
    const registry = ix.get(IConfigRegistry);
    registry.registerSection('session', z.object({ modelAlias: z.string() }));
    const svc = ix.get(IConfigService);
    await expect(svc.set('session', { modelAlias: 1 })).rejects.toThrow();
    await expect(readFile(join(homeDir, 'config.toml'), 'utf-8')).rejects.toThrow();
  });

  it('applies defaults and fires change when a section registers after load', () => {
    const svc = ix.get(IConfigService);
    expect(svc.get('session')).toBeUndefined();
    const fired: string[] = [];
    disposables.add(svc.onDidChange((e) => fired.push(e.domain)));

    const registry = ix.get(IConfigRegistry);
    registry.registerSection('session', z.object({ modelAlias: z.string() }), {
      defaultValue: { modelAlias: 'default' },
    });

    expect(svc.get('session')).toEqual({ modelAlias: 'default' });
    expect(fired).toContain('session');
  });

  it('reloads when config.toml is edited externally', async () => {
    const svc = ix.get(IConfigService);
    await svc.set('session', { modelAlias: 'k2' });

    const reloaded = new Promise<void>((resolve) => {
      const sub = svc.onDidChange((e) => {
        if (e.domain === 'session' && e.source === 'reload') {
          sub.dispose();
          resolve();
        }
      });
    });

    await writeFile(join(homeDir, 'config.toml'), '[session]\nmodel_alias = "k9"\n', 'utf-8');
    await reloaded;
    expect(svc.get('session')).toEqual({ modelAlias: 'k9' });
  });
});

describe('ConfigService TOML compatibility', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let homeDir: string;
  let configPath: string;

  beforeEach(async () => {
    disposables = new DisposableStore();
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-config-toml-'));
    configPath = join(homeDir, 'config.toml');
    ix = buildConfigServices(homeDir, {}, registerOwnerSections);
  });
  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  function buildConfigServices(
    home: string,
    env: NodeJS.ProcessEnv = {},
    register?: (registry: IConfigRegistry) => void,
  ): TestInstantiationService {
    const services = createServices(disposables, {
      base: [registerConfigServices, registerLogServices],
      additionalServices: (reg) => {
        reg.defineInstance(IBootstrapService, stubBootstrap(home, env));
        reg.defineInstance(IStorageService, new FileStorageService(home));
        reg.define(IConfigService, ConfigService);
      },
    });
    register?.(services.get(IConfigRegistry));
    return services;
  }

  // Mirror the section registrations the real owner services perform, so the
  // config dispatcher applies the same snake_case ↔ camelCase transforms.
  function registerOwnerSections(registry: IConfigRegistry): void {
    registry.registerSection('providers', ProvidersSectionSchema, {
      defaultValue: {},
      env: providersEnvBindings,
      stripEnv: stripProvidersEnv,
      fromToml: providersFromToml,
      toToml: providersToToml,
    });
    registry.registerSection(LOOP_CONTROL_SECTION, LoopControlSchema, {
      fromToml: loopControlFromToml,
      toToml: loopControlToToml,
    });
    registry.registerEffectiveOverlay(kimiModelEnvOverlay);
  }

  async function seedToml(text: string): Promise<void> {
    await writeFile(configPath, text, 'utf-8');
  }

  it('reads snake_case provider keys into camelCase', async () => {
    await seedToml(`
[providers.acme]
type = "kimi"
api_key = "sk-test"
base_url = "https://example.test"
custom_headers = { X-Trace = "abc" }
`);
    const svc = ix.get(IConfigService);
    await svc.ready;
    expect(svc.get('providers')).toEqual({
      acme: {
        type: 'kimi',
        apiKey: 'sk-test',
        baseUrl: 'https://example.test',
        customHeaders: { 'X-Trace': 'abc' },
      },
    });
  });

  it('migrates loop_control max_steps_per_run to maxStepsPerTurn', async () => {
    await seedToml(`
[loop_control]
max_steps_per_run = 7
max_retries_per_step = 2
`);
    const svc = ix.get(IConfigService);
    await svc.ready;
    expect(svc.get('loopControl')).toEqual({ maxStepsPerTurn: 7, maxRetriesPerStep: 2 });
  });

  it('preserves unknown top-level keys across a write (round-trip)', async () => {
    await seedToml(`
theme = "dark"

[notifications]
enabled = true
`);
    const svc = ix.get(IConfigService);
    await svc.set('session', { modelAlias: 'k2' });
    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('theme = "dark"');
    expect(text).toContain('[notifications]');
    expect(text).toContain('[session]');
    expect(text).toContain('model_alias = "k2"');
  });

  it('writes provider updates back as snake_case', async () => {
    const svc = ix.get(IConfigService);
    await svc.set('providers', { acme: { type: 'kimi', apiKey: 'sk-new' } });
    const text = await readFile(configPath, 'utf-8');
    expect(text).toContain('[providers.acme]');
    expect(text).toContain('api_key = "sk-new"');
    expect(text).not.toContain('apiKey');
  });

  it('applies KIMI_MODEL_* env overlay in memory but never persists it', async () => {
    await seedToml(`
[providers.acme]
type = "kimi"
api_key = "sk-disk"
`);
    const svc = buildConfigServices(homeDir, {
      KIMI_MODEL_NAME: 'env-model',
      KIMI_MODEL_API_KEY: 'sk-env',
      KIMI_MODEL_PROVIDER_TYPE: 'kimi',
    }, registerOwnerSections).get(IConfigService);
    await svc.ready;
    const providers = svc.get<Record<string, { apiKey?: string }>>('providers');
    expect(providers['__kimi_env__']?.apiKey).toBe('sk-env');
    expect(svc.get('defaultModel')).toBe('__kimi_env_model__');

    // A provider write must not flush the env provider or its shell api key.
    await svc.set('providers', { acme: { type: 'kimi', apiKey: 'sk-disk2' } });
    const text = await readFile(configPath, 'utf-8');
    expect(text).not.toContain('__kimi_env__');
    expect(text).not.toContain('sk-env');
    expect(text).toContain('api_key = "sk-disk2"');
  });

  it('exposes KIMI_MODEL_* request overrides as modelOverrides', async () => {
    const svc = buildConfigServices(homeDir, {
      KIMI_MODEL_NAME: 'env-model',
      KIMI_MODEL_API_KEY: 'sk-env',
      KIMI_MODEL_TEMPERATURE: '0.7',
      KIMI_MODEL_TOP_P: '0.9',
      KIMI_MODEL_THINKING_KEEP: 'keep',
      KIMI_MODEL_MAX_COMPLETION_TOKENS: '4096',
    }, registerOwnerSections).get(IConfigService);
    await svc.ready;
    expect(svc.get('modelOverrides')).toEqual({
      temperature: 0.7,
      topP: 0.9,
      thinkingKeep: 'keep',
      maxCompletionTokens: 4096,
    });
  });
});

describe('ConfigService layers', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let homeDir: string;

  beforeEach(async () => {
    disposables = new DisposableStore();
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-config-layers-'));
    ix = createServices(disposables, {
      base: [registerConfigServices, registerLogServices],
      additionalServices: (reg) => {
        reg.defineInstance(IBootstrapService, stubBootstrap(homeDir));
        reg.defineInstance(IStorageService, new FileStorageService(homeDir));
        reg.define(IConfigService, ConfigService);
      },
    });
  });
  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('memory override beats the user value and is not persisted', async () => {
    const svc = ix.get(IConfigService);
    await svc.set('session', { modelAlias: 'user-model' });
    await svc.set('session', { modelAlias: 'memory-model' }, ConfigTarget.Memory);
    expect(svc.get('session')).toEqual({ modelAlias: 'memory-model' });

    const text = await readFile(join(homeDir, 'config.toml'), 'utf-8');
    expect(text).toContain('model_alias = "user-model"');
    expect(text).not.toContain('memory-model');
  });

  it('replace with undefined clears a memory override', async () => {
    const svc = ix.get(IConfigService);
    await svc.set('session', { modelAlias: 'user-model' });
    await svc.set('session', { modelAlias: 'memory-model' }, ConfigTarget.Memory);
    await svc.replace('session', undefined, ConfigTarget.Memory);
    expect(svc.get('session')).toEqual({ modelAlias: 'user-model' });
  });

  it('inspect reports per-layer values', async () => {
    const registry = ix.get(IConfigRegistry);
    registry.registerSection('session', passthroughSchema, { defaultValue: { modelAlias: 'default' } });
    const svc = ix.get(IConfigService);
    await svc.set('session', { modelAlias: 'user-model' });
    await svc.set('session', { modelAlias: 'memory-model' }, ConfigTarget.Memory);

    const view = svc.inspect('session');
    expect(view.defaultValue).toEqual({ modelAlias: 'default' });
    expect(view.userValue).toEqual({ modelAlias: 'user-model' });
    expect(view.memoryValue).toEqual({ modelAlias: 'memory-model' });
    expect(view.value).toEqual({ modelAlias: 'memory-model' });
  });

  it('getAll includes the memory overlay', async () => {
    const svc = ix.get(IConfigService);
    await svc.set('session', { modelAlias: 'user-model' });
    await svc.set('tool', { x: 1 }, ConfigTarget.Memory);
    expect(svc.getAll()).toMatchObject({ session: { modelAlias: 'user-model' }, tool: { x: 1 } });
  });

  it('fires onDidChange for memory writes', async () => {
    const svc = ix.get(IConfigService);
    const fired: string[] = [];
    disposables.add(svc.onDidChange((e) => fired.push(e.domain)));
    await svc.set('session', { modelAlias: 'm' }, ConfigTarget.Memory);
    expect(fired).toEqual(['session']);
  });

  it('registerSection stores scope metadata', () => {
    const registry = ix.get(IConfigRegistry);
    registry.registerSection('loopControl', passthroughSchema, { scope: ConfigScope.Project });
    expect(registry.getSection('loopControl')?.scope).toBe(ConfigScope.Project);
  });
});

describe('ConfigService section env bindings / stripEnv', () => {
  let disposables: DisposableStore;
  let homeDir: string;

  beforeEach(async () => {
    disposables = new DisposableStore();
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-config-overlay-'));
  });
  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  function build(env: NodeJS.ProcessEnv = {}) {
    return createServices(disposables, {
      base: [registerConfigServices, registerLogServices],
      additionalServices: (reg) => {
        reg.defineInstance(IBootstrapService, stubBootstrap(homeDir, env));
        reg.defineInstance(IStorageService, new FileStorageService(homeDir));
        reg.define(IConfigService, ConfigService);
      },
    });
  }

  it('applies section env bindings onto the effective value', async () => {
    const ix = build({ GADGET_LEVEL: '7' });
    const registry = ix.get(IConfigRegistry);
    registry.registerSection('gadget', passthroughSchema, {
      env: { envLevel: 'GADGET_LEVEL' },
    });
    const svc = ix.get(IConfigService);
    await svc.ready;
    expect(svc.get('gadget')).toEqual({ envLevel: '7' });
  });

  it('stripEnv keeps env-derived fields out of the persisted file', async () => {
    const ix = build({ GADGET_LEVEL: '7' });
    const registry = ix.get(IConfigRegistry);
    registry.registerSection('gadget', passthroughSchema, {
      env: { envLevel: 'GADGET_LEVEL' },
      stripEnv: (value) => {
        const out = { ...(value as Record<string, unknown>) };
        delete out['envLevel'];
        return out;
      },
    });
    const svc = ix.get(IConfigService);
    await svc.set('gadget', { user: true, envLevel: '7' });
    const text = await readFile(join(homeDir, 'config.toml'), 'utf-8');
    expect(text).not.toContain('envLevel');
    expect(text).toContain('user = true');
  });
});
