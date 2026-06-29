import { describe, expect, it } from 'vitest';

import type { IConfigService } from '#/config';
import { ErrorCodes, KimiError } from '#/errors';
import { ModelProvider } from '#/modelProvider';

function stubConfig(sections: Record<string, unknown>): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: () => ({ dispose: () => {} }),
    get: <T>(domain: string) => sections[domain] as T,
    inspect: () => ({ value: undefined, defaultValue: undefined, userValue: undefined, memoryValue: undefined }),
    getAll: () => ({ ...sections }),
    set: () => Promise.resolve(),
    replace: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    diagnostics: () => [],
  } as unknown as IConfigService;
}

function baseSections(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    defaultProvider: 'kimi',
    defaultModel: 'k1',
    providers: {
      kimi: { type: 'kimi', apiKey: 'sk-test' },
    },
    models: {
      k1: { provider: 'kimi', model: 'kimi-model', maxContextSize: 128000 },
    },
    ...overrides,
  };
}

describe('ModelProvider', () => {
  it('resolves a configured model to its provider', () => {
    const pm = new ModelProvider({ config: stubConfig(baseSections()) });
    const resolved = pm.resolveProviderConfig('k1');
    expect(resolved.providerName).toBe('kimi');
    expect(resolved.provider).toMatchObject({ model: 'kimi-model' });
    expect(resolved.modelCapabilities).toBeDefined();
  });

  it('exposes defaultModel from config', () => {
    const pm = new ModelProvider({ config: stubConfig(baseSections()) });
    expect(pm.defaultModel).toBe('k1');
  });

  it('reads providers and models from the config service', () => {
    const config = stubConfig(baseSections());
    const pm = new ModelProvider({ config });
    expect(pm.defaultModel).toBe('k1');
    expect(pm.resolveProviderConfig('k1').providerName).toBe('kimi');
  });

  it('throws CONFIG_INVALID for an unknown model', () => {
    const pm = new ModelProvider({ config: stubConfig(baseSections()) });
    expect(() => pm.resolveProviderConfig('does-not-exist')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID } as Partial<KimiError>),
    );
  });

  it('throws CONFIG_INVALID when model has no provider and no defaultProvider', () => {
    const config = stubConfig(
      baseSections({
        defaultProvider: undefined,
        models: {
          k1: { provider: 'kimi', model: 'kimi-model', maxContextSize: 128000 },
          orphan: { model: 'm', maxContextSize: 1000 },
        },
      }),
    );
    const pm = new ModelProvider({ config });
    expect(() => pm.resolveProviderConfig('orphan')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID } as Partial<KimiError>),
    );
  });

  it('throws CONFIG_INVALID when provider is not configured', () => {
    const config = stubConfig(
      baseSections({
        models: {
          k1: { provider: 'kimi', model: 'kimi-model', maxContextSize: 128000 },
          ghost: { provider: 'missing', model: 'm', maxContextSize: 1000 },
        },
      }),
    );
    const pm = new ModelProvider({ config });
    expect(() => pm.resolveProviderConfig('ghost')).toThrowError(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID } as Partial<KimiError>),
    );
  });
});
