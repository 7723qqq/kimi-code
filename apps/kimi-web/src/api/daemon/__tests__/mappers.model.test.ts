// apps/kimi-web/src/api/daemon/__tests__/mappers.model.test.ts
// Unit tests for toAppModel and toAppProvider mappers.
import { describe, expect, it } from 'vitest';
import { toAppModel, toAppProvider } from '../mappers';
import type { WireModel, WireProvider } from '../wire';

describe('toAppModel', () => {
  it('maps required fields', () => {
    const wire: WireModel = {
      provider: 'prov_moonshot',
      model: 'moonshot-v1-128k',
      max_context_size: 131072,
    };
    const app = toAppModel(wire);
    expect(app.id).toBe('moonshot-v1-128k');
    expect(app.provider).toBe('prov_moonshot');
    expect(app.model).toBe('moonshot-v1-128k');
    expect(app.maxContextSize).toBe(131072);
    expect(app.displayName).toBeUndefined();
    expect(app.capabilities).toBeUndefined();
  });

  it('maps optional display_name and capabilities', () => {
    const wire: WireModel = {
      provider: 'prov_anthropic',
      model: 'claude-sonnet-4-6',
      max_context_size: 200000,
      display_name: 'Claude Sonnet 4.6',
      capabilities: ['thinking'],
    };
    const app = toAppModel(wire);
    expect(app.displayName).toBe('Claude Sonnet 4.6');
    expect(app.capabilities).toEqual(['thinking']);
  });

  it('id equals the model field (not provider)', () => {
    const wire: WireModel = {
      provider: 'prov_foo',
      model: 'my-model-name',
      max_context_size: 8192,
    };
    const app = toAppModel(wire);
    // id should be the model string so PATCH session can use it directly
    expect(app.id).toBe('my-model-name');
  });
});

describe('toAppProvider', () => {
  it('maps all fields correctly', () => {
    const wire: WireProvider = {
      id: 'prov_moonshot',
      type: 'moonshot',
      has_api_key: true,
      status: 'connected',
      models: ['moonshot-v1-128k', 'moonshot-v1-32k'],
    };
    const app = toAppProvider(wire);
    expect(app.id).toBe('prov_moonshot');
    expect(app.type).toBe('moonshot');
    expect(app.hasApiKey).toBe(true);
    expect(app.status).toBe('connected');
    expect(app.models).toEqual(['moonshot-v1-128k', 'moonshot-v1-32k']);
    expect(app.baseUrl).toBeUndefined();
    expect(app.defaultModel).toBeUndefined();
  });

  it('maps optional base_url and default_model', () => {
    const wire: WireProvider = {
      id: 'prov_custom',
      type: 'custom',
      base_url: 'https://my-api.example.com',
      default_model: 'my-model',
      has_api_key: false,
      status: 'unconfigured',
    };
    const app = toAppProvider(wire);
    expect(app.baseUrl).toBe('https://my-api.example.com');
    expect(app.defaultModel).toBe('my-model');
    expect(app.hasApiKey).toBe(false);
    expect(app.status).toBe('unconfigured');
  });

  it('maps error status', () => {
    const wire: WireProvider = {
      id: 'prov_err',
      type: 'openai',
      has_api_key: true,
      status: 'error',
    };
    const app = toAppProvider(wire);
    expect(app.status).toBe('error');
  });
});
