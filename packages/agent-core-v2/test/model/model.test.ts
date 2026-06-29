/**
 * `model` domain tests — covers `ModelService` CRUD over the `models` config
 * section, schema registration, and the delete-via-replace semantics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IConfigRegistry, IConfigService } from '#/config/config';
import { ConfigRegistry } from '#/config/configService';
import { IModelService, type ModelAlias, MODELS_SECTION } from '#/model/model';
import { ModelService } from '#/model/modelService';

describe('ModelService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let registry: ConfigRegistry;
  let models: Record<string, ModelAlias>;
  let configSet: ReturnType<typeof vi.fn>;
  let configReplace: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    registry = new ConfigRegistry();
    models = {};
    configSet = vi.fn().mockResolvedValue(undefined);
    configReplace = vi.fn().mockResolvedValue(undefined);
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IConfigRegistry, registry);
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) =>
            domain === MODELS_SECTION ? models : undefined) as IConfigService['get'],
          set: configSet as unknown as IConfigService['set'],
          replace: configReplace as unknown as IConfigService['replace'],
          onDidChange: (() => ({ dispose: () => {} })) as IConfigService['onDidChange'],
        });
      },
    });
  });
  afterEach(() => disposables.dispose());

  function createService(): IModelService {
    return ix.createInstance(ModelService);
  }

  it('registers the models section schema on construction', () => {
    createService();
    expect(registry.getSection(MODELS_SECTION)).toBeDefined();
  });

  it('set delegates to config.set with a single-alias patch', async () => {
    const svc = createService();
    await svc.set('m1', { provider: 'p', model: 'x', maxContextSize: 1000 });
    expect(configSet).toHaveBeenCalledWith(MODELS_SECTION, {
      m1: { provider: 'p', model: 'x', maxContextSize: 1000 },
    });
  });

  it('get reads a single alias from config', () => {
    models['m1'] = { provider: 'p', model: 'x', maxContextSize: 1000 };
    const svc = createService();
    expect(svc.get('m1')).toEqual({ provider: 'p', model: 'x', maxContextSize: 1000 });
    expect(svc.get('missing')).toBeUndefined();
  });

  it('list returns all aliases', () => {
    models['m1'] = { provider: 'p', model: 'x', maxContextSize: 1000 };
    models['m2'] = { provider: 'p', model: 'y', maxContextSize: 2000 };
    const svc = createService();
    expect(svc.list()).toEqual({
      m1: { provider: 'p', model: 'x', maxContextSize: 1000 },
      m2: { provider: 'p', model: 'y', maxContextSize: 2000 },
    });
  });

  it('delete removes the alias and replaces the whole section', async () => {
    models['m1'] = { provider: 'p', model: 'x', maxContextSize: 1000 };
    models['m2'] = { provider: 'p', model: 'y', maxContextSize: 2000 };
    const svc = createService();
    await svc.delete('m1');
    expect(configReplace).toHaveBeenCalledWith(MODELS_SECTION, {
      m2: { provider: 'p', model: 'y', maxContextSize: 2000 },
    });
  });

  it('delete is a no-op when the alias is absent', async () => {
    const svc = createService();
    await svc.delete('missing');
    expect(configReplace).not.toHaveBeenCalled();
  });
});
