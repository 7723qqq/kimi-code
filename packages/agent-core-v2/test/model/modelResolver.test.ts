/**
 * `model` domain — `ModelResolverService` regression tests.
 *
 * Covers two resolver responsibilities:
 *  1. Auth shape — the resolved `Model` god-object drives real requests through
 *     kosong, which reads the bearer/api token from `ProviderRequestAuth.apiKey`
 *     (`requireProviderApiKey`). The resolver's `AuthProvider` must return the
 *     token as `apiKey` (not wrapped in `headers`), so a resolved Model can
 *     authenticate against its endpoint.
 *  2. Default thinking — the resolver reads the `thinking` / `defaultThinking`
 *     config sections and applies the same default effort the production agent
 *     path (via `profile`) does, so a plain `model.request()` behaves
 *     identically (some endpoints reject a request that omits thinking).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IOAuthService } from '#/app/auth';
import { IConfigService } from '#/app/config/config';
import { type ModelConfig, IModelResolver, IModelService } from '#/app/model';
import { ModelResolverService } from '#/app/model/modelResolverService';
import { IPlatformService } from '#/app/platform';
import { type ProviderConfig, IProviderService } from '#/app/provider';
import { IProtocolAdapterRegistry } from '#/app/protocol';

describe('ModelResolverService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let providers: Record<string, ProviderConfig>;
  let models: Record<string, ModelConfig>;
  let configValues: Record<string, unknown>;
  let resolveTokenProvider: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    providers = {};
    models = {};
    configValues = {};
    resolveTokenProvider = vi.fn();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IConfigService, {
          get: ((domain: string) => configValues[domain]) as unknown as IConfigService['get'],
        });
        reg.definePartialInstance(IProviderService, {
          get: ((name: string) => providers[name]) as IProviderService['get'],
          list: (() => providers) as IProviderService['list'],
        });
        reg.definePartialInstance(IPlatformService, {
          get: (() => undefined) as IPlatformService['get'],
          list: (() => ({})) as IPlatformService['list'],
        });
        reg.definePartialInstance(IModelService, {
          get: ((id: string) => models[id]) as IModelService['get'],
          list: (() => models) as IModelService['list'],
        });
        reg.definePartialInstance(IOAuthService, {
          resolveTokenProvider: resolveTokenProvider as unknown as IOAuthService['resolveTokenProvider'],
        });
        reg.definePartialInstance(IProtocolAdapterRegistry, {
          supportedProtocols: () => [],
        });
        reg.define(IModelResolver, ModelResolverService);
      },
    });
  });

  afterEach(() => disposables.dispose());

  it('returns the provider apiKey as ProviderRequestAuth.apiKey', async () => {
    providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk-test' };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

    const auth = await ix.get(IModelResolver).resolve('m').authProvider.getAuth();

    expect(auth).toEqual({ apiKey: 'sk-test' });
  });

  it('prefers a model-inline apiKey override as ProviderRequestAuth.apiKey', async () => {
    providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk-provider' };
    models['m'] = {
      provider: 'p',
      model: 'wire-name',
      maxContextSize: 1000,
      apiKey: 'sk-model',
    };

    const auth = await ix.get(IModelResolver).resolve('m').authProvider.getAuth();

    expect(auth).toEqual({ apiKey: 'sk-model' });
  });

  it('returns an OAuth access token as ProviderRequestAuth.apiKey', async () => {
    providers['p'] = {
      type: 'kimi',
      baseUrl: 'https://example.test/v1',
      oauth: { storage: 'file', key: 'oauth/test' },
    };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };
    resolveTokenProvider.mockReturnValue({ getAccessToken: async () => 'oauth-token' });

    const auth = await ix.get(IModelResolver).resolve('m').authProvider.getAuth();

    expect(auth).toEqual({ apiKey: 'oauth-token' });
    expect(resolveTokenProvider).toHaveBeenCalledWith('p', { storage: 'file', key: 'oauth/test' });
  });

  it('returns undefined when the model carries no auth material', async () => {
    providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1' };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };

    const auth = await ix.get(IModelResolver).resolve('m').authProvider.getAuth();

    expect(auth).toBeUndefined();
  });

  it('falls through an empty-string provider apiKey to OAuth', async () => {
    providers['p'] = {
      type: 'kimi',
      baseUrl: 'https://example.test/v1',
      apiKey: '',
      oauth: { storage: 'file', key: 'oauth/test' },
    };
    models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000 };
    resolveTokenProvider.mockReturnValue({ getAccessToken: async () => 'oauth-token' });

    const auth = await ix.get(IModelResolver).resolve('m').authProvider.getAuth();

    expect(auth).toEqual({ apiKey: 'oauth-token' });
  });

  describe('default thinking', () => {
    function resolveEffort(capabilities?: string[]): string | null {
      providers['p'] = { type: 'kimi', baseUrl: 'https://example.test/v1', apiKey: 'sk' };
      models['m'] = {
        provider: 'p',
        model: 'wire-name',
        maxContextSize: 1000,
        ...(capabilities === undefined ? {} : { capabilities }),
      };
      return ix.get(IModelResolver).resolve('m').thinkingEffort;
    }

    it('defaults to "high" when thinking is not disabled', () => {
      expect(resolveEffort()).toBe('high');
    });

    it('is off (null) when defaultThinking is false', () => {
      configValues['defaultThinking'] = false;
      expect(resolveEffort()).toBeNull();
    });

    it('is off (null) when thinking.mode is "off"', () => {
      configValues['thinking'] = { mode: 'off' };
      expect(resolveEffort()).toBeNull();
    });

    it('uses the configured thinking.effort', () => {
      configValues['thinking'] = { effort: 'medium' };
      expect(resolveEffort()).toBe('medium');
    });

    it('clamps an explicit off back to on for always_thinking models', () => {
      configValues['defaultThinking'] = false;
      expect(resolveEffort(['always_thinking'])).toBe('high');
    });
  });

  describe('baseUrl normalization', () => {
    function resolveBaseUrl(protocol: string, providerType: string, baseUrl: string): string {
      providers['p'] = { type: providerType, baseUrl, apiKey: 'sk' } as ProviderConfig;
      models['m'] = { provider: 'p', model: 'wire-name', maxContextSize: 1000, protocol } as ModelConfig;
      return ix.get(IModelResolver).resolve('m').baseUrl;
    }

    it('strips a trailing /v1 for the anthropic protocol', () => {
      expect(resolveBaseUrl('anthropic', 'kimi', 'https://example.test/coding/v1')).toBe(
        'https://example.test/coding',
      );
    });

    it('strips a trailing /v1/ (with slash) for the anthropic protocol', () => {
      expect(resolveBaseUrl('anthropic', 'kimi', 'https://example.test/coding/v1/')).toBe(
        'https://example.test/coding',
      );
    });

    it('does not strip /v1 for non-anthropic protocols', () => {
      expect(resolveBaseUrl('kimi', 'kimi', 'https://example.test/coding/v1')).toBe(
        'https://example.test/coding/v1',
      );
    });
  });
});
