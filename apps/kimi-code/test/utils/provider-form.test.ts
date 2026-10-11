import { describe, expect, it } from 'vitest';

import type { KimiConfig } from '@moonshot-ai/kimi-code-sdk';

import {
  PROVIDER_WIRE_TYPES,
  buildAddPatch,
  defaultModelRow,
  normalizeBaseUrlForType,
  planEditWrite,
  validateProviderForm,
  type ProviderFormModelRow,
  type ProviderFormValue,
} from '#/utils/provider-form';

function modelRow(overrides: Partial<ProviderFormModelRow> = {}): ProviderFormModelRow {
  return { model: 'gpt-4.1', maxContextSize: '128000', displayName: '', ...overrides };
}

function formValue(overrides: Partial<ProviderFormValue> = {}): ProviderFormValue {
  return {
    id: 'demo',
    type: 'openai',
    apiKey: 'sk-demo',
    baseUrl: 'https://api.example.com/v1',
    models: [modelRow()],
    ...overrides,
  };
}

/** A config holding another provider, an existing alias, thinking, and default pointers. */
function makeCurrent(): KimiConfig {
  return {
    providers: {
      old: {
        type: 'anthropic',
        apiKey: 'sk-old',
        baseUrl: 'https://old.example.com',
        source: { kind: 'registry', url: 'https://registry.example.com/api.json' },
        customHeaders: { 'x-tenant': 'acme' },
        env: { REGION: 'cn' },
        stream: true,
        defaultModel: 'old/claude',
      },
      other: { type: 'openai', apiKey: 'sk-other', baseUrl: 'https://other.example.com' },
    },
    defaultProvider: 'old',
    defaultModel: 'old/claude',
    models: {
      'old/claude': {
        provider: 'old',
        model: 'claude',
        maxContextSize: 200000,
        maxOutputSize: 64000,
        supportEfforts: ['low', 'high'],
        capabilities: ['tool_use'],
        adaptiveThinking: false,
        protocol: 'anthropic',
        baseUrl: 'https://old.example.com/v1',
        overrides: { maxOutputSize: 32000 },
        displayName: 'Old Claude',
      },
      'other/gpt': { provider: 'other', model: 'gpt', maxContextSize: 128000 },
    },
    thinking: { enabled: true, effort: 'high' },
  };
}

function editValue(overrides: Partial<ProviderFormValue> = {}): ProviderFormValue {
  return formValue({
    id: 'new',
    type: 'anthropic',
    apiKey: '',
    baseUrl: '',
    models: [modelRow({ model: 'claude', maxContextSize: '200000' })],
    ...overrides,
  });
}

describe('PROVIDER_WIRE_TYPES', () => {
  it('lists the six official wire types in order', () => {
    expect(PROVIDER_WIRE_TYPES).toEqual([
      'kimi',
      'openai',
      'openai_responses',
      'anthropic',
      'google-genai',
      'vertexai',
    ]);
  });
});

describe('validateProviderForm', () => {
  it('accepts a complete value', () => {
    expect(validateProviderForm(formValue(), { requireApiKey: true })).toBeNull();
  });

  it('requires the API key only when asked', () => {
    expect(validateProviderForm(formValue({ apiKey: '' }), { requireApiKey: true })).toBe(
      'apiKeyRequired',
    );
    expect(validateProviderForm(formValue({ apiKey: '   ' }), { requireApiKey: true })).toBe(
      'apiKeyRequired',
    );
    expect(validateProviderForm(formValue({ apiKey: '' }), { requireApiKey: false })).toBeNull();
  });

  it('reports idRequired for an empty or whitespace-only id', () => {
    expect(validateProviderForm(formValue({ id: '' }), { requireApiKey: true })).toBe('idRequired');
    expect(validateProviderForm(formValue({ id: '   ' }), { requireApiKey: true })).toBe(
      'idRequired',
    );
  });

  it('reports idInvalid for the characters the official id rule rejects', () => {
    for (const id of ['demo@host', ' demo', 'demo/prod', '-demo']) {
      expect(validateProviderForm(formValue({ id }), { requireApiKey: true }), id).toBe(
        'idInvalid',
      );
    }
  });

  it('accepts every id shape the official rule allows', () => {
    for (const id of ['demo', 'Demo 1', 'demo_prod-2', '中文 名称']) {
      expect(validateProviderForm(formValue({ id }), { requireApiKey: true }), id).toBeNull();
    }
    // The official rule (requirements R2, design §2:
    // /^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u — identical to dist-web's `dL` and to
    // `modelsDevImport.ts`'s PROVIDER_ID_PATTERN) accepts digit-leading ids and
    // has no length cap.
    expect(validateProviderForm(formValue({ id: '1demo' }), { requireApiKey: true })).toBeNull();
    expect(
      validateProviderForm(formValue({ id: 'd'.repeat(200) }), { requireApiKey: true }),
    ).toBeNull();
  });

  it('requires a non-empty base URL but does not validate its shape', () => {
    expect(validateProviderForm(formValue({ baseUrl: '' }), { requireApiKey: true })).toBe(
      'baseUrlRequired',
    );
    expect(validateProviderForm(formValue({ baseUrl: '  ' }), { requireApiKey: true })).toBe(
      'baseUrlRequired',
    );
    expect(validateProviderForm(formValue({ baseUrl: 'not-a-url' }), { requireApiKey: true })).toBe(
      null,
    );
  });

  it('requires at least one model row with a non-empty model id', () => {
    expect(validateProviderForm(formValue({ models: [] }), { requireApiKey: true })).toBe(
      'modelRequired',
    );
    expect(
      validateProviderForm(formValue({ models: [modelRow({ model: '  ' })] }), {
        requireApiKey: true,
      }),
    ).toBe('modelRequired');
  });

  it('requires the context size and rejects anything but a positive integer', () => {
    expect(
      validateProviderForm(formValue({ models: [modelRow({ maxContextSize: '' })] }), {
        requireApiKey: true,
      }),
    ).toBe('contextSizeRequired');
    expect(
      validateProviderForm(formValue({ models: [modelRow({ maxContextSize: ' ' })] }), {
        requireApiKey: true,
      }),
    ).toBe('contextSizeRequired');
    for (const maxContextSize of ['0', '-1', '1.5', 'abc', '1e3']) {
      expect(
        validateProviderForm(formValue({ models: [modelRow({ maxContextSize })] }), {
          requireApiKey: true,
        }),
        maxContextSize,
      ).toBe('contextSizeInvalid');
    }
    expect(
      validateProviderForm(formValue({ models: [modelRow({ maxContextSize: '1048576' })] }), {
        requireApiKey: true,
      }),
    ).toBeNull();
  });
});

describe('normalizeBaseUrlForType', () => {
  it('strips a trailing /v1 (with or without a trailing slash) for anthropic', () => {
    expect(normalizeBaseUrlForType('https://api.anthropic.com/v1', 'anthropic')).toBe(
      'https://api.anthropic.com',
    );
    expect(normalizeBaseUrlForType('https://api.anthropic.com/v1/', 'anthropic')).toBe(
      'https://api.anthropic.com',
    );
    expect(normalizeBaseUrlForType('https://api.anthropic.com', 'anthropic')).toBe(
      'https://api.anthropic.com',
    );
    expect(normalizeBaseUrlForType('https://api.anthropic.com/v1beta', 'anthropic')).toBe(
      'https://api.anthropic.com/v1beta',
    );
  });

  it('leaves every other wire type untouched', () => {
    for (const type of PROVIDER_WIRE_TYPES) {
      if (type === 'anthropic') continue;
      expect(normalizeBaseUrlForType('https://api.example.com/v1', type), type).toBe(
        'https://api.example.com/v1',
      );
    }
  });
});

describe('defaultModelRow', () => {
  it('starts every field empty', () => {
    expect(defaultModelRow()).toStrictEqual({ model: '', maxContextSize: '', displayName: '' });
  });
});

describe('buildAddPatch', () => {
  it('writes the provider and the model alias with the official defaults', () => {
    const patch = buildAddPatch(formValue({ models: [modelRow({ displayName: 'GPT 4.1' })] }));

    expect(patch.providers).toStrictEqual({
      demo: { type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-demo' },
    });
    expect(patch.models).toStrictEqual({
      'demo/gpt-4.1': {
        provider: 'demo',
        model: 'gpt-4.1',
        maxContextSize: 128000,
        displayName: 'GPT 4.1',
        capabilities: ['tool_use', 'thinking'],
        adaptiveThinking: true,
      },
    });
  });

  it('trims every written value and unfolds multiple model rows', () => {
    const patch = buildAddPatch(
      formValue({
        id: ' demo ',
        apiKey: ' sk-demo ',
        baseUrl: ' https://api.example.com/v1 ',
        models: [
          modelRow({ model: ' gpt-4.1 ', maxContextSize: ' 128000 ' }),
          modelRow({ model: 'gpt-4.1-mini', maxContextSize: '200000' }),
        ],
      }),
    );

    expect(patch.providers?.['demo']).toStrictEqual({
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-demo',
    });
    expect(Object.keys(patch.models ?? {})).toEqual(['demo/gpt-4.1', 'demo/gpt-4.1-mini']);
    expect(patch.models?.['demo/gpt-4.1']?.maxContextSize).toBe(128000);
  });

  it('omits blank apiKey, baseUrl and displayName keys entirely', () => {
    const patch = buildAddPatch(
      formValue({ apiKey: '', baseUrl: '', models: [modelRow({ displayName: '  ' })] }),
    );
    const provider = patch.providers?.['demo'] ?? {};
    const alias = patch.models?.['demo/gpt-4.1'] ?? {};

    expect('apiKey' in provider).toBe(false);
    expect('baseUrl' in provider).toBe(false);
    expect('displayName' in alias).toBe(false);
  });

  it('touches nothing but the added provider and alias', () => {
    const patch = buildAddPatch(formValue());

    expect(Object.keys(patch)).toEqual(['providers', 'models']);
    expect('thinking' in patch).toBe(false);
    expect('defaultModel' in patch).toBe(false);
    expect('defaultProvider' in patch).toBe(false);
    expect(Object.keys(patch.providers ?? {})).toEqual(['demo']);
    expect(Object.keys(patch.models ?? {})).toEqual(['demo/gpt-4.1']);

    // Folding the patch into the existing config leaves the other entries and
    // the thinking section byte-identical.
    const current = makeCurrent();
    const mergedProviders: Record<string, unknown> = { ...current.providers, ...patch.providers };
    const mergedModels: Record<string, unknown> = { ...current.models, ...patch.models };
    expect(mergedProviders['old']).toStrictEqual(current.providers['old']);
    expect(mergedProviders['other']).toStrictEqual(current.providers['other']);
    expect(mergedModels['old/claude']).toStrictEqual(current.models?.['old/claude']);
    expect(mergedModels['other/gpt']).toStrictEqual(current.models?.['other/gpt']);
  });
});

describe('planEditWrite', () => {
  // T1 ① pure rename: the new alias exists and the old id is gone everywhere.
  it('renames the provider without leaving the old id behind', () => {
    const { removeProviderId, patch } = planEditWrite(makeCurrent(), editValue(), 'old');

    expect(removeProviderId).toBe('old');
    expect(Object.keys(patch.providers ?? {})).toEqual(['new']);
    expect('old' in (patch.providers ?? {})).toBe(false);
    expect(Object.keys(patch.models ?? {})).toEqual(['new/claude']);
    expect('old/claude' in (patch.models ?? {})).toBe(false);
    expect(patch.providers?.['new']?.type).toBe('anthropic');
    expect(patch.providers?.['new']?.apiKey).toBe('sk-old');
    expect('thinking' in patch).toBe(false);
  });

  // T1 ② the default model follows the rename.
  it('migrates defaultModel and defaultProvider to the new id', () => {
    const { patch } = planEditWrite(makeCurrent(), editValue(), 'old');

    expect(patch.defaultModel).toBe('new/claude');
    expect(patch.defaultProvider).toBe('new');
    expect(patch.providers?.['new']?.defaultModel).toBe('new/claude');
  });

  // T1 ③ deleting the row the default pointed at must not leave a dangling pointer.
  it('drops defaultModel when the row it pointed at is deleted', () => {
    const current = makeCurrent();
    const value = editValue({
      models: [modelRow({ model: 'claude-2', maxContextSize: '200000' })],
    });
    const { patch } = planEditWrite(current, value, 'old');

    expect('defaultModel' in patch).toBe(false);
    expect('defaultProvider' in patch).toBe(true);
    expect('defaultModel' in (patch.providers?.['new'] ?? {})).toBe(false);
    expect(patch.models?.['new/claude-2']?.capabilities).toEqual(['tool_use', 'thinking']);
  });

  it('keeps default pointers that belong to another provider', () => {
    const current: KimiConfig = {
      ...makeCurrent(),
      defaultModel: 'other/gpt',
      defaultProvider: 'other',
    };
    const { patch } = planEditWrite(current, editValue(), 'old');

    expect('defaultModel' in patch).toBe(false);
    expect('defaultProvider' in patch).toBe(false);
  });

  it('inherits every provider field the form does not edit', () => {
    const { patch } = planEditWrite(makeCurrent(), editValue({ apiKey: 'sk-new' }), 'old');

    expect(patch.providers?.['new']).toStrictEqual({
      type: 'anthropic',
      apiKey: 'sk-new',
      baseUrl: 'https://old.example.com',
      source: { kind: 'registry', url: 'https://registry.example.com/api.json' },
      customHeaders: { 'x-tenant': 'acme' },
      env: { REGION: 'cn' },
      stream: true,
      defaultModel: 'new/claude',
    });
  });

  it('preserves the aliases’ untouched fields and overrides the edited ones', () => {
    const value = editValue({
      baseUrl: 'https://new.example.com',
      models: [modelRow({ model: 'claude', maxContextSize: '250000', displayName: 'New Claude' })],
    });
    const { patch } = planEditWrite(makeCurrent(), value, 'old');

    expect(patch.models?.['new/claude']).toStrictEqual({
      provider: 'new',
      model: 'claude',
      maxContextSize: 250000,
      maxOutputSize: 64000,
      supportEfforts: ['low', 'high'],
      capabilities: ['tool_use'],
      adaptiveThinking: false,
      protocol: 'anthropic',
      baseUrl: 'https://old.example.com/v1',
      overrides: { maxOutputSize: 32000 },
      displayName: 'New Claude',
    });
    expect(patch.providers?.['new']?.baseUrl).toBe('https://new.example.com');
  });

  it('rewrites a same-id edit into a provider and aliases carrying the old fields', () => {
    const value = editValue({
      id: 'old',
      apiKey: 'sk-rotated',
      baseUrl: 'https://old2.example.com',
    });
    const { removeProviderId, patch } = planEditWrite(makeCurrent(), value, 'old');

    expect(removeProviderId).toBe('old');
    expect(patch.providers?.['old']?.apiKey).toBe('sk-rotated');
    expect(patch.providers?.['old']?.source).toStrictEqual({
      kind: 'registry',
      url: 'https://registry.example.com/api.json',
    });
    expect(patch.models?.['old/claude']?.maxOutputSize).toBe(64000);
    expect(patch.defaultModel).toBe('old/claude');
  });

  describe('clear semantics', () => {
    it('keeps the stored credential when the field is blank and clearing was not requested', () => {
      const { patch } = planEditWrite(makeCurrent(), editValue({ apiKey: '' }), 'old');
      expect(patch.providers?.['new']?.apiKey).toBe('sk-old');

      const current = makeCurrent();
      current.providers['old'] = { type: 'openai' };
      const { patch: withoutKey } = planEditWrite(current, editValue({ apiKey: '' }), 'old');
      expect('apiKey' in (withoutKey.providers?.['new'] ?? {})).toBe(false);
      expect('baseUrl' in (withoutKey.providers?.['new'] ?? {})).toBe(false);
    });

    it('writes an explicit empty apiKey when clearing is requested', () => {
      const { patch } = planEditWrite(makeCurrent(), editValue({ apiKey: '' }), 'old', {
        clearApiKey: true,
      });
      expect(patch.providers?.['new']?.apiKey).toBe('');
    });

    it('leaves the base URL as stored when the field is blank', () => {
      const { patch } = planEditWrite(makeCurrent(), editValue({ baseUrl: '' }), 'old');
      expect(patch.providers?.['new']?.baseUrl).toBe('https://old.example.com');
    });
  });
});

describe('validateProviderForm duplicate models', () => {
  it('reports modelDuplicate when the same model is listed twice', () => {
    const value = formValue({
      models: [
        modelRow({ model: 'gpt-4.1', maxContextSize: '128000' }),
        modelRow({ model: ' gpt-4.1 ', maxContextSize: '200000' }),
      ],
    });
    expect(validateProviderForm(value, { requireApiKey: true })).toBe('modelDuplicate');
  });

  it('reports a row error before the duplicate check', () => {
    const value = formValue({
      models: [
        modelRow({ model: 'gpt-4.1', maxContextSize: '0' }),
        modelRow({ model: 'gpt-4.1', maxContextSize: '128000' }),
      ],
    });
    expect(validateProviderForm(value, { requireApiKey: true })).toBe('contextSizeInvalid');
  });

  it('accepts distinct models', () => {
    const value = formValue({
      models: [modelRow({ model: 'gpt-4.1' }), modelRow({ model: 'gpt-4.1-mini' })],
    });
    expect(validateProviderForm(value, { requireApiKey: true })).toBeNull();
  });
});

describe('planEditWrite conflict detection', () => {
  it('reports the alias keys another provider already owns', () => {
    const current = makeCurrent();
    current.models = {
      ...current.models,
      'new/claude': { provider: 'other', model: 'claude', maxContextSize: 1000 },
      'new/gpt': { provider: 'other', model: 'gpt', maxContextSize: 2000 },
    };
    const { collisions } = planEditWrite(current, editValue(), 'old');
    expect(collisions).toEqual(['new/claude']);
  });

  it('reports no collisions when every alias key is free', () => {
    const { collisions } = planEditWrite(makeCurrent(), editValue(), 'old');
    expect(collisions).toEqual([]);
  });

  it('does not flag an alias the previous provider itself owns', () => {
    const { collisions } = planEditWrite(makeCurrent(), editValue({ id: 'old' }), 'old');
    expect(collisions).toEqual([]);
  });

  it('reports providerIdTaken only for an id another provider uses', () => {
    expect(planEditWrite(makeCurrent(), editValue({ id: 'new' }), 'old').providerIdTaken).toBe(
      false,
    );
    expect(planEditWrite(makeCurrent(), editValue({ id: 'other' }), 'old').providerIdTaken).toBe(
      true,
    );
    expect(planEditWrite(makeCurrent(), editValue({ id: 'old' }), 'old').providerIdTaken).toBe(
      false,
    );
  });
});

describe('planEditWrite boundaries', () => {
  it('keeps a provider-level defaultModel that is not a previousId alias', () => {
    const current: KimiConfig = {
      providers: { old: { type: 'anthropic', defaultModel: 'other/model' } },
      models: {},
    };
    const { patch } = planEditWrite(current, editValue(), 'old');
    expect(patch.providers?.['new']?.defaultModel).toBe('other/model');
  });

  it('does not throw when the previous provider entry is missing', () => {
    const current: KimiConfig = { providers: {}, models: {} };
    const result = planEditWrite(current, editValue(), 'ghost');
    expect(result.removeProviderId).toBe('ghost');
    expect(result.patch.providers?.['new']?.type).toBe('anthropic');
    expect(result.collisions).toEqual([]);
    expect(result.providerIdTaken).toBe(false);
  });
});
