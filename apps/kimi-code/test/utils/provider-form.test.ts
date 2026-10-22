import { type KimiConfig } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'bun:test';
import { CAPABILITY_NAMES } from '#/utils/provider-form';

import { EMPTY_EFFORT_LADDER, PROVIDER_WIRE_TYPES, badKeyValueEntry, buildAddPatch, defaultModelRow, formatEffortList, formatKeyValueList, normalizeBaseUrlForType, parseKeyValueList, planEditWrite, validateProviderForm, type ProviderFormModelRow, type ProviderFormValue } from '#/utils/provider-form';

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

  it('accepts a row that sets every optional field', () => {
    const value = formValue({
      models: [
        modelRow({
          capabilities: [...CAPABILITY_NAMES],
          maxInputSize: '1',
          maxOutputSize: '1',
          supportEfforts: 'low,high',
          defaultEffort: 'high',
          offEffort: 'none',
          adaptiveThinking: true,
        }),
      ],
    });
    expect(validateProviderForm(value, { requireApiKey: true })).toBeNull();
  });

  it('rejects a capability name the engine does not know', () => {
    const value = formValue({ models: [modelRow({ capabilities: ['tool_use', 'pdf'] })] });
    expect(validateProviderForm(value, { requireApiKey: true })).toBe('capabilityUnknown');
  });

  it('rejects a default effort the model does not declare', () => {
    // The SDK and the engine both drop a default that is not in the list, so
    // the form must refuse it rather than write a value nothing reads.
    const unsupported = formValue({
      models: [modelRow({ supportEfforts: 'low,high', defaultEffort: 'max' })],
    });
    expect(validateProviderForm(unsupported, { requireApiKey: true })).toBe(
      'defaultEffortNotSupported',
    );

    const withoutList = formValue({ models: [modelRow({ defaultEffort: 'high' })] });
    expect(validateProviderForm(withoutList, { requireApiKey: true })).toBe(
      'defaultEffortNotSupported',
    );

    const supported = formValue({
      models: [modelRow({ supportEfforts: ' low , high ', defaultEffort: ' low ' })],
    });
    expect(validateProviderForm(supported, { requireApiKey: true })).toBeNull();
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
  it('writes the provider and the model alias with the documented defaults', () => {
    const patch = buildAddPatch(formValue({ models: [modelRow({ displayName: 'GPT 4.1' })] }));

    expect(patch.providers).toStrictEqual({
      demo: { type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-demo' },
    });
    // `adaptive_thinking` is deliberately absent: forcing it made every
    // hand-added model declare adaptive thinking, which is wrong for
    // budget-style gateways. Omitting it lets the engine infer from the model
    // name, which is what the anthropic profile already does.
    expect(patch.models).toStrictEqual({
      'demo/gpt-4.1': {
        provider: 'demo',
        model: 'gpt-4.1',
        maxContextSize: 128000,
        displayName: 'GPT 4.1',
        capabilities: ['tool_use', 'thinking'],
      },
    });
  });

  it('writes the effort fields a row declares, keeping the declared order', () => {
    const patch = buildAddPatch(
      formValue({
        models: [
          modelRow({
            supportEfforts: ' low , high ,low,  max ',
            defaultEffort: 'high',
            offEffort: 'none',
          }),
        ],
      }),
    );

    // Order is semantic: the default effort is the middle entry and the
    // persistence ceiling is computed from the index, so a "nicer" sort would
    // change behaviour. Duplicates collapse; order does not change.
    expect(patch.models?.['demo/gpt-4.1']).toMatchObject({
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      offEffort: 'none',
    });
  });

  it('writes the context sub-limits and the capability list a row declares', () => {
    const patch = buildAddPatch(
      formValue({
        models: [
          modelRow({
            maxInputSize: ' 272000 ',
            maxOutputSize: '128000',
            capabilities: ['tool_use', 'pdf_in', 'image_in'],
          }),
        ],
      }),
    );

    expect(patch.models?.['demo/gpt-4.1']).toMatchObject({
      maxInputSize: 272000,
      maxOutputSize: 128000,
      capabilities: ['tool_use', 'pdf_in', 'image_in'],
    });
  });

  it('drops a key the user cleared instead of writing an empty value', () => {
    const current: KimiConfig = {
      providers: { demo: { type: 'openai', baseUrl: 'https://api.example.com/v1' } },
      models: {
        'demo/gpt-4.1': {
          provider: 'demo',
          model: 'gpt-4.1',
          maxContextSize: 128000,
          maxInputSize: 272000,
          maxOutputSize: 128000,
          supportEfforts: ['low', 'high'],
          defaultEffort: 'high',
          offEffort: 'none',
          adaptiveThinking: true,
          displayName: 'GPT 4.1',
        },
      },
    };
    const result = planEditWrite(
      current,
      formValue({
        models: [
          modelRow({
            displayName: 'GPT 4.1',
            maxInputSize: '',
            maxOutputSize: '   ',
            supportEfforts: '',
            defaultEffort: '',
            offEffort: '',
            // A toggle's "clear" is its own position now that `false` is a
            // declaration of its own; asking to drop the key says so explicitly.
            adaptiveThinking: 'clear',
          }),
        ],
      }),
      'demo',
    );

    const alias = result.patch.models?.['demo/gpt-4.1'];
    expect(alias).toBeDefined();
    expect('maxInputSize' in alias!).toBe(false);
    expect('maxOutputSize' in alias!).toBe(false);
    expect('supportEfforts' in alias!).toBe(false);
    expect('defaultEffort' in alias!).toBe(false);
    expect('offEffort' in alias!).toBe(false);
    expect('adaptiveThinking' in alias!).toBe(false);
    expect(alias!.maxContextSize).toBe(128000);
  });

  it('leaves a field the form does not present untouched when editing', () => {
    const current: KimiConfig = {
      providers: { demo: { type: 'openai', baseUrl: 'https://api.example.com/v1' } },
      models: {
        'demo/gpt-4.1': {
          provider: 'demo',
          model: 'gpt-4.1',
          maxContextSize: 128000,
          maxInputSize: 272000,
          supportEfforts: ['low', 'high'],
          defaultEffort: 'high',
          adaptiveThinking: true,
        },
      },
    };
    const result = planEditWrite(current, formValue(), 'demo');

    // Every new field is optional and `undefined` means "not presented here",
    // which must not be confused with "cleared".
    expect(result.patch.models?.['demo/gpt-4.1']).toMatchObject({
      maxInputSize: 272000,
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      adaptiveThinking: true,
    });
  });

  it('writes adaptive_thinking when the row asks for it', () => {
    const patch = buildAddPatch(formValue({ models: [modelRow({ adaptiveThinking: true })] }));
    expect(patch.models?.['demo/gpt-4.1']?.adaptiveThinking).toBe(true);
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

  it('describes the same write as complete sections for the one-write path', () => {
    const current = makeCurrent();
    const { patch, sections } = planEditWrite(current, editValue(), 'old');

    // `replaceConfigSections` replaces each named section wholesale, so the
    // sections have to be the whole post-write state: the records the patch
    // never mentions, plus the rebuilt ones it carries — and no trace of the
    // id the removal cascaded away.
    expect(Object.keys(sections.providers).toSorted()).toEqual(['new', 'other']);
    expect(sections.providers['other']).toEqual(current.providers['other']);
    expect(sections.providers['new']).toEqual(patch.providers?.['new'] as typeof sections.providers['new']);
    expect('old' in sections.providers).toBe(false);

    expect(Object.keys(sections.models).toSorted()).toEqual(['new/claude', 'other/gpt']);
    expect(sections.models['other/gpt']).toEqual(current.models?.['other/gpt']);
    expect(sections.models['new/claude']).toEqual(patch.models?.['new/claude'] as typeof sections.models['new/claude']);

    expect(sections.defaultModel).toBe(patch.defaultModel);
    expect(sections.defaultProvider).toBe(patch.defaultProvider);
  });

  it('names a default pointer with `undefined` to clear it, which a patch cannot', () => {
    const value = editValue({
      models: [modelRow({ model: 'claude-2', maxContextSize: '200000' })],
    });
    const { patch, sections } = planEditWrite(makeCurrent(), value, 'old');

    // The patch has no way to say this — `setConfig` skips an undefined domain,
    // so the two-call path leans on `removeProvider` having cleared the
    // pointer. The one-write path has to carry the clear itself, and
    // `replaceConfigSections` reads a named `undefined` section as exactly that.
    expect('defaultModel' in patch).toBe(false);
    expect('defaultModel' in sections).toBe(true);
    expect(sections.defaultModel).toBeUndefined();
    expect(sections.defaultProvider).toBe('new');
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

// ---------------------------------------------------------------------------
// The fields the manual form grew: the wire overrides, the two states a
// false/blank value could not previously express, and the provider-level
// records. Every case here is a decision the form makes about what reaches the
// record, so they are pinned at this layer rather than only through a front end.
// ---------------------------------------------------------------------------

describe('the fields the manual form grew', () => {
  it('writes an empty ladder for the `[]` literal and clears the key for a blank one', () => {
    const empty = buildAddPatch(
      formValue({ models: [modelRow({ supportEfforts: EMPTY_EFFORT_LADDER })] }),
    );
    expect(empty.models?.['demo/gpt-4.1']?.supportEfforts).toEqual([]);

    const cleared = buildAddPatch(formValue({ models: [modelRow({ supportEfforts: '' })] }));
    expect('supportEfforts' in (cleared.models?.['demo/gpt-4.1'] ?? {})).toBe(false);

    const laddered = buildAddPatch(
      formValue({ models: [modelRow({ supportEfforts: 'low, high, max' })] }),
    );
    expect(laddered.models?.['demo/gpt-4.1']?.supportEfforts).toEqual(['low', 'high', 'max']);
  });

  it('round-trips a stored empty ladder through the text the form shows', () => {
    const current: KimiConfig = {
      providers: { demo: { type: 'openai', baseUrl: 'https://api.example.com/v1' } },
      models: {
        'demo/gpt-4.1': {
          provider: 'demo',
          model: 'gpt-4.1',
          maxContextSize: 128000,
          supportEfforts: [],
        },
      },
    };

    // The declared-empty state has to survive the form's text field, or editing
    // an unrelated field would silently turn it into a cleared key.
    const shown = formatEffortList(current.models?.['demo/gpt-4.1']?.supportEfforts);
    expect(shown).toBe(EMPTY_EFFORT_LADDER);

    const result = planEditWrite(
      current,
      formValue({ models: [modelRow({ supportEfforts: shown })] }),
      'demo',
    );
    expect('supportEfforts' in (result.patch.models?.['demo/gpt-4.1'] ?? {})).toBe(true);
    expect(result.patch.models?.['demo/gpt-4.1']?.supportEfforts).toEqual([]);
  });

  it('separates a toggle\u2019s three positions', () => {
    const written = buildAddPatch(
      formValue({ models: [modelRow({ adaptiveThinking: false, betaApi: false })] }),
    );
    // `false` is a declaration, not a request to forget: the engine reads
    // `adaptiveThinking: false` as the budget-effort ladder.
    expect(written.models?.['demo/gpt-4.1']?.adaptiveThinking).toBe(false);
    expect(written.models?.['demo/gpt-4.1']?.betaApi).toBe(false);

    const cleared = planEditWrite(
      makeCurrent(),
      editValue({ models: [modelRow({ adaptiveThinking: 'clear', betaApi: 'clear' })] }),
      'old',
    );
    expect('adaptiveThinking' in (cleared.patch.models?.['new/claude'] ?? {})).toBe(false);
    expect('betaApi' in (cleared.patch.models?.['new/claude'] ?? {})).toBe(false);

    // The fixture stores `adaptiveThinking: false`, which a row that does not
    // present the field must carry through untouched.
    const kept = planEditWrite(makeCurrent(), editValue(), 'old');
    expect(kept.patch.models?.['new/claude']?.adaptiveThinking).toBe(false);
  });

  it('writes the per-model wire overrides and drops the protocol on an empty value', () => {
    const written = buildAddPatch(
      formValue({
        models: [
          modelRow({
            protocol: 'anthropic',
            betaApi: true,
            reasoningKey: 'reasoning_content',
            baseUrl: 'https://gw.example.com/anthropic',
          }),
        ],
      }),
    );
    expect(written.models?.['demo/gpt-4.1']).toMatchObject({
      protocol: 'anthropic',
      betaApi: true,
      reasoningKey: 'reasoning_content',
      baseUrl: 'https://gw.example.com/anthropic',
    });

    // `makeCurrent()`'s alias declares `protocol: 'anthropic'`; `''` is how the
    // form says "go back to the provider's own protocol".
    const dropped = planEditWrite(
      makeCurrent(),
      editValue({
        models: [modelRow({ model: 'claude', maxContextSize: '200000', protocol: '' })],
      }),
      'old',
    );
    expect('protocol' in (dropped.patch.models?.['new/claude'] ?? {})).toBe(false);
  });

  it('keeps stored overrides unless the row asks to drop them', () => {
    const current: KimiConfig = {
      providers: { demo: { type: 'openai', baseUrl: 'https://api.example.com/v1' } },
      models: {
        'demo/gpt-4.1': {
          provider: 'demo',
          model: 'gpt-4.1',
          maxContextSize: 128000,
          overrides: { maxContextSize: 400000, capabilities: ['image_in'] },
        },
      },
    };

    // The form cannot edit them, so a write that does not ask for it must leave
    // them exactly as they were rather than dropping a layer it cannot see.
    const kept = planEditWrite(current, formValue(), 'demo');
    expect(kept.patch.models?.['demo/gpt-4.1']?.overrides).toEqual({
      maxContextSize: 400000,
      capabilities: ['image_in'],
    });

    // And they have to be droppable: the engine spreads them over every field
    // the form does own, so a stale set silently defeats an edit.
    const dropped = planEditWrite(
      current,
      formValue({ models: [modelRow({ clearOverrides: true })] }),
      'demo',
    );
    expect('overrides' in (dropped.patch.models?.['demo/gpt-4.1'] ?? {})).toBe(false);
  });

  it('reads and writes the provider-level records the form owns', () => {
    const added = buildAddPatch(
      formValue({
        apiKey: '',
        apiKeyEnv: 'DEMO_KEY',
        defaultModel: 'gpt-4.1',
        customHeaders: 'x-tenant=acme, x-tier=gold',
        env: 'REGION=cn',
      }),
    );
    expect(added.providers?.['demo']).toMatchObject({
      apiKeyEnv: 'DEMO_KEY',
      defaultModel: 'demo/gpt-4.1',
      customHeaders: { 'x-tenant': 'acme', 'x-tier': 'gold' },
      env: { REGION: 'cn' },
    });
    expect('apiKey' in (added.providers?.['demo'] ?? {})).toBe(false);

    const current: KimiConfig = {
      providers: {
        demo: {
          type: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKeyEnv: 'OLD_KEY',
          defaultModel: 'demo/gpt-4.1',
          customHeaders: { 'x-tenant': 'old' },
          env: { REGION: 'us' },
        },
      },
      models: { 'demo/gpt-4.1': { provider: 'demo', model: 'gpt-4.1', maxContextSize: 128000 } },
    };

    // A blank value clears the field; an absent one would keep it, which is what
    // the CLI's omitted flags rely on.
    const cleared = planEditWrite(
      current,
      formValue({ apiKeyEnv: '', defaultModel: '', customHeaders: '', env: '' }),
      'demo',
    );
    const provider = cleared.patch.providers?.['demo'] ?? {};
    for (const key of ['apiKeyEnv', 'defaultModel', 'customHeaders', 'env']) {
      expect(key in provider).toBe(false);
    }

    const untouched = planEditWrite(current, formValue(), 'demo');
    expect(untouched.patch.providers?.['demo']).toMatchObject({
      apiKeyEnv: 'OLD_KEY',
      customHeaders: { 'x-tenant': 'old' },
      env: { REGION: 'us' },
    });
  });

  it('refuses the combinations the new fields make possible', () => {
    expect(
      validateProviderForm(formValue({ apiKeyEnv: 'DEMO_KEY' }), { requireApiKey: true }),
    ).toBe('apiKeyConflict');

    expect(validateProviderForm(formValue({ defaultModel: 'nope' }), { requireApiKey: true })).toBe(
      'defaultModelUnknown',
    );
    expect(
      validateProviderForm(formValue({ defaultModel: 'gpt-4.1' }), { requireApiKey: true }),
    ).toBeNull();

    // `betaApi` reaches the wire only through the Anthropic transport, so a row
    // that cannot reach it is refused rather than silently inert.
    expect(
      validateProviderForm(formValue({ models: [modelRow({ betaApi: true })] }), {
        requireApiKey: true,
      }),
    ).toBe('betaApiWithoutAnthropic');
    expect(
      validateProviderForm(
        formValue({ type: 'anthropic', models: [modelRow({ betaApi: true })] }),
        {
          requireApiKey: true,
        },
      ),
    ).toBeNull();
    expect(
      validateProviderForm(
        formValue({ models: [modelRow({ betaApi: true, protocol: 'anthropic' })] }),
        { requireApiKey: true },
      ),
    ).toBeNull();

    expect(
      validateProviderForm(formValue({ models: [modelRow({ baseUrl: 'gw.example.com' })] }), {
        requireApiKey: true,
      }),
    ).toBe('modelBaseUrlInvalid');

    expect(
      validateProviderForm(formValue({ customHeaders: 'x-tenant' }), { requireApiKey: true }),
    ).toBe('headerInvalid');
    expect(validateProviderForm(formValue({ env: '=acme' }), { requireApiKey: true })).toBe(
      'envInvalid',
    );
    expect(
      validateProviderForm(formValue({ models: [modelRow({ maxInputSize: '0' })] }), {
        requireApiKey: true,
      }),
    ).toBe('contextSizeInvalid');
    expect(
      validateProviderForm(formValue({ models: [modelRow({ maxInputSize: 'abc' })] }), {
        requireApiKey: true,
      }),
    ).toBe('contextSizeInvalid');
    expect(
      validateProviderForm(formValue({ models: [modelRow({ maxOutputSize: '0' })] }), {
        requireApiKey: true,
      }),
    ).toBe('contextSizeInvalid');
    expect(
      validateProviderForm(formValue({ models: [modelRow({ maxOutputSize: '-5' })] }), {
        requireApiKey: true,
      }),
    ).toBe('contextSizeInvalid');
  });

  it('parses and formats the flat records the two text fields carry', () => {
    expect(parseKeyValueList('x-tenant=acme, x-tier=gold')).toEqual({
      'x-tenant': 'acme',
      'x-tier': 'gold',
    });
    // A blank value keeps its `=`, or the text the form shows would come back
    // through its own parser as a malformed entry.
    expect(parseKeyValueList(formatKeyValueList({ A: '', B: 'b' }))).toEqual({ A: '', B: 'b' });
    expect(formatKeyValueList(undefined)).toBe('');

    expect(badKeyValueEntry('x-tenant')).toBe('x-tenant');
    expect(badKeyValueEntry('=acme')).toBe('=acme');
    expect(badKeyValueEntry('x-tenant=')).toBeUndefined();
    expect(badKeyValueEntry('')).toBeUndefined();
  });

  it('carries the new fields into the one-write sections', () => {
    const value = editValue({
      defaultModel: 'claude',
      customHeaders: 'x-tenant=acme, x-tier=gold',
      models: [
        modelRow({
          model: 'claude',
          maxContextSize: '200000',
          protocol: 'anthropic',
          betaApi: true,
          reasoningKey: 'reasoning_content',
          baseUrl: 'https://gw.example.com/anthropic',
          supportEfforts: EMPTY_EFFORT_LADDER,
        }),
      ],
    });

    const { patch, sections } = planEditWrite(makeCurrent(), value, 'old');

    // A host that replaces sections wholesale writes these records instead of
    // merging the patch, so every new field has to be present or the two write
    // shapes would disagree about what the file ends up saying.
    expect(sections.providers['new']).toEqual(patch.providers?.['new'] as typeof sections.providers['new']);
    expect(sections.models['new/claude']).toEqual(patch.models?.['new/claude'] as typeof sections.models['new/claude']);
    expect(sections.providers['new']).toMatchObject({
      defaultModel: 'new/claude',
      customHeaders: { 'x-tenant': 'acme', 'x-tier': 'gold' },
    });
    expect(sections.models['new/claude']).toMatchObject({
      protocol: 'anthropic',
      betaApi: true,
      reasoningKey: 'reasoning_content',
      baseUrl: 'https://gw.example.com/anthropic',
      supportEfforts: [],
    });
  });
});
