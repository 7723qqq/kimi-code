import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { isUnknownCapability } from '#/llm-adapter/contract/capability';
import type { Model } from '#/llm-adapter/model/catalog';
import type { ModelRecord } from '#/llm-adapter/model/model';
import { resolveEndpointBaseUrl, resolveModelAuthMaterial } from '#/llm-adapter/model/model-auth';
import { ProtocolAdapterRegistry } from '#/llm-adapter/protocol/protocolAdapterRegistry';
import type { ProviderConfig } from '#/llm-adapter/provider/provider';
import {
  deepseekConnection,
  getProviderDefinition,
  openAIConnection,
  resolveProviderDefinition,
} from '#/llm-adapter/provider/provider-definition';
import type { LlmModel } from '#human/llm/model';
import { resolveModelFamily } from '#human/llm/modelFamily';
import { resolveModelConnection } from '#human/llm/protocol/connection';

const ENV_KEYS = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
] as const;

const DEEPSEEK = 'deepseek';
const DEEPSEEK_MODEL = 'deepseek-v4.1-flash';
const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function modelRecord(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    provider: DEEPSEEK,
    model: DEEPSEEK_MODEL,
    maxContextSize: 131072,
    ...overrides,
  };
}

function llmModel(overrides: Partial<LlmModel> = {}): LlmModel {
  return {
    provider: 'openai',
    model: DEEPSEEK_MODEL,
    capability: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
    },
    ...overrides,
  };
}

function catalogModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'ds-v41',
    name: DEEPSEEK_MODEL,
    aliases: [],
    protocol: 'openai',
    headers: {},
    capabilities: {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 131072,
    },
    maxContextSize: 131072,
    alwaysThinking: false,
    providerType: 'openai',
    providerName: DEEPSEEK,
    ...overrides,
  };
}

describe('deepseek provider resolved by id over an openai type', () => {
  it('resolves the declared default endpoint instead of falling back to OpenAI', () => {
    const provider: ProviderConfig = { type: 'openai' };
    expect(resolveEndpointBaseUrl(modelRecord(), provider, DEEPSEEK)).toBe(
      DEEPSEEK_DEFAULT_BASE_URL,
    );
    expect(resolveEndpointBaseUrl(modelRecord(), provider)).toBeUndefined();
  });

  it('lets DEEPSEEK_BASE_URL override the declared default', () => {
    const provider: ProviderConfig = {
      type: 'openai',
      env: { DEEPSEEK_BASE_URL: 'https://deepseek.internal/v1' },
    };
    expect(resolveEndpointBaseUrl(modelRecord(), provider, DEEPSEEK)).toBe(
      'https://deepseek.internal/v1',
    );
  });

  it('takes the credential from the DEEPSEEK_API_KEY env table entry', () => {
    const material = resolveModelAuthMaterial({
      modelId: 'ds-v41',
      model: modelRecord(),
      provider: { type: 'openai', env: { DEEPSEEK_API_KEY: 'sk-deepseek' } },
      providerName: DEEPSEEK,
    });
    expect(material).toEqual({ apiKey: 'sk-deepseek' });
  });

  it('reads DEEPSEEK_API_KEY and the default endpoint at request time', () => {
    process.env['DEEPSEEK_API_KEY'] = 'sk-shell-deepseek';
    const resolved = resolveModelConnection(llmModel(), deepseekConnection);
    expect(resolved.apiKey).toBe('sk-shell-deepseek');
    expect(resolved.baseUrl).toBe(DEEPSEEK_DEFAULT_BASE_URL);
  });

  it('lets DEEPSEEK_BASE_URL override the request-time default', () => {
    process.env['DEEPSEEK_API_KEY'] = 'sk-shell-deepseek';
    process.env['DEEPSEEK_BASE_URL'] = 'https://deepseek.internal/v1';
    expect(resolveModelConnection(llmModel(), deepseekConnection).baseUrl).toBe(
      'https://deepseek.internal/v1',
    );
  });

  it('never picks up an OpenAI endpoint or key for the deepseek provider', () => {
    process.env['OPENAI_API_KEY'] = 'sk-openai-secret';
    process.env['OPENAI_BASE_URL'] = 'https://api.openai.com/v1';
    const resolved = resolveModelConnection(llmModel(), deepseekConnection);
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.baseUrl).toBe(DEEPSEEK_DEFAULT_BASE_URL);
  });

  it('routes the provider through the deepseek connection', () => {
    expect(resolveProviderDefinition('openai', DEEPSEEK, 'openai')?.connection).toBe(
      deepseekConnection,
    );
    expect(deepseekConnection.endpoint?.()).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseUrlEnv: 'DEEPSEEK_BASE_URL',
      defaultBaseUrl: DEEPSEEK_DEFAULT_BASE_URL,
    });
  });

  it('gives the family models the deepseek capability through the provider id', () => {
    const registry = new ProtocolAdapterRegistry();
    const capability = registry.resolveCapability('openai', DEEPSEEK_MODEL, 'openai', DEEPSEEK);
    expect(isUnknownCapability(capability)).toBe(false);
    expect(capability.image_in).toBe(true);
    expect(capability.thinking).toBe(true);
    expect(capability.pdf_in).toBe(false);
    const withoutId = registry.resolveCapability('openai', DEEPSEEK_MODEL, 'openai');
    expect(isUnknownCapability(withoutId)).toBe(true);
  });

  it('keeps the deepseek family identity for the model on that provider', () => {
    expect(resolveModelFamily(DEEPSEEK_MODEL)?.id).toBe('deepseek');
    expect(resolveModelFamily(DEEPSEEK_MODEL)?.curatedAdaptation).toBe(true);
  });

  it('resolves a catalog model on the provider without throwing', () => {
    const resolved = new ProtocolAdapterRegistry().resolve(catalogModel());
    expect(resolved.protocol).toBe('openai');
    expect(resolved.model.provider).toBe('openai');
  });
});

describe('other providers keep their previous resolution', () => {
  it('leaves a plain openai provider on the OpenAI endpoint and key', () => {
    process.env['OPENAI_API_KEY'] = 'sk-openai';
    const record = modelRecord({ provider: 'openai', model: 'gpt-4o' });
    expect(resolveEndpointBaseUrl(record, { type: 'openai' }, 'openai')).toBeUndefined();
    expect(getProviderDefinition('openai', 'openai')?.connection).toBeUndefined();
    expect(resolveProviderDefinition('openai', 'openai', 'openai')?.connection).toBeUndefined();
    const resolved = resolveModelConnection(
      llmModel({ provider: 'openai', model: 'gpt-4o' }),
      openAIConnection,
    );
    expect(resolved.apiKey).toBe('sk-openai');
    expect(resolved.baseUrl).toBeUndefined();
  });

  it('leaves an anthropic provider on the anthropic endpoint and key', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-anthropic';
    const record = modelRecord({ provider: 'anthropic', protocol: 'anthropic', model: 'claude' });
    expect(resolveEndpointBaseUrl(record, { type: 'anthropic' }, 'anthropic')).toBeUndefined();
    const definition = resolveProviderDefinition('anthropic', 'anthropic', 'anthropic');
    expect(definition?.id).toBe('anthropic');
    expect(definition?.connection).toBeUndefined();
    const auth = resolveModelAuthMaterial({
      modelId: 'claude',
      model: record,
      provider: { type: 'anthropic' },
      providerName: 'anthropic',
    });
    expect(auth).toEqual({});
  });

  it('does not treat an arbitrary openai-compatible provider id as a definition', () => {
    const provider: ProviderConfig = { type: 'openai', env: { OPENAI_API_KEY: 'sk-gateway' } };
    const record = modelRecord({
      provider: 'my-gateway',
      model: 'deepseek-v4.1-flash',
      baseUrl: 'https://gw.example.test/v1',
    });
    expect(resolveEndpointBaseUrl(record, provider, 'my-gateway')).toBe(
      'https://gw.example.test/v1',
    );
    const definition = resolveProviderDefinition('openai', 'my-gateway', 'openai');
    expect(definition?.id).toBe('openai');
    expect(definition?.connection).toBeUndefined();
    expect(definition?.capability).toBeUndefined();
    expect(
      resolveModelAuthMaterial({
        modelId: 'gw',
        model: record,
        provider,
        providerName: 'my-gateway',
      }),
    ).toEqual({ apiKey: 'sk-gateway' });
  });

  it('keeps a provider that names a protocol by type on that protocol definition', () => {
    const record = modelRecord({ provider: 'gateway', model: 'deepseek-v4.1-flash' });
    const provider: ProviderConfig = { type: 'openai', env: { OPENAI_API_KEY: 'sk-openai' } };
    expect(resolveEndpointBaseUrl(record, provider, undefined)).toBeUndefined();
    expect(resolveProviderDefinition('openai', undefined, 'openai')?.id).toBe('openai');
  });
});
