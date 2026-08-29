import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadRuntimeConfigSafe: vi.fn(),
  resolveConfigPath: vi.fn(),
  resolveKimiHome: vi.fn(),
  createRunTurnOverride: vi.fn(),
}));

vi.mock('@moonshot-ai/kimi-code-sdk', () => ({
  loadRuntimeConfigSafe: mocks.loadRuntimeConfigSafe,
  resolveConfigPath: mocks.resolveConfigPath,
  resolveKimiHome: mocks.resolveKimiHome,
}));

vi.mock('@moonshot-ai/kimi-agent/rust-loop', () => ({
  createRunTurnOverride: mocks.createRunTurnOverride,
}));

/** Fresh module per test so the module-level rustTurnEngine cache resets. */
async function loadMaybeRustEngine() {
  vi.resetModules();
  const mod = await import('../../src/cli/rust-engine');
  return mod.maybeLoadRustEngine;
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    defaultModel: 'kimi-k2',
    providers: {
      kimi: { defaultModel: 'kimi-k2', type: 'kimi', apiKey: 'k', baseUrl: 'https://api.example.com/v1' },
      anthropic: { defaultModel: 'claude-x', type: 'anthropic', apiKey: 'a', baseUrl: 'https://api.anthropic.com/v1' },
      unsupported: { defaultModel: 'x', type: 'other', apiKey: 'x', baseUrl: 'https://x.example.com/v1' },
    },
    models: {
      'kimi-k2': { provider: 'kimi', model: 'kimi-k2', systemPrompt: 'default prompt' },
      'claude-x': { provider: 'anthropic', model: 'claude-x' },
    },
    agent: { engine: 'rust' },
    ...overrides,
  };
}

const okResult = { fileWarnings: [], envWarnings: [], fileError: undefined };

beforeEach(() => {
  mocks.loadRuntimeConfigSafe.mockReset();
  mocks.resolveConfigPath.mockReset().mockReturnValue('/home/u/config.toml');
  mocks.resolveKimiHome.mockReset().mockReturnValue('/home/u');
  mocks.createRunTurnOverride.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maybeLoadRustEngine', () => {
  it('returns undefined when the config file cannot be read', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: makeConfig(),
      fileError: new Error('unreadable'),
    });
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBeUndefined();
    expect(mocks.createRunTurnOverride).not.toHaveBeenCalled();
  });

  it('returns undefined when agent.engine is unset or js (JS engine default)', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig({ agent: {} }) });
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBeUndefined();

    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig({ agent: { engine: 'js' } }) });
    const maybeLoadRustEngine2 = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine2('/home/u')).resolves.toBeUndefined();
  });

  it('returns undefined when the rust adapter module has no createRunTurnOverride', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig() });
    mocks.createRunTurnOverride.mockReturnValue(undefined);
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBeUndefined();
  });

  it('wires the rust engine when agent.engine = "rust" and the adapter is available', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig() });
    const engine = vi.fn();
    mocks.createRunTurnOverride.mockReturnValue(engine);
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBe(engine);
    expect(mocks.createRunTurnOverride).toHaveBeenCalledTimes(1);
  });

  it('falls back to JS when createRunTurnOverride throws (adapter unavailable)', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig() });
    mocks.createRunTurnOverride.mockImplementation(() => {
      throw new Error('native addon missing');
    });
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBeUndefined();
  });

  it('passes a per-turn nativeLlm resolver that re-reads the config', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig() });
    const engine = vi.fn();
    let capturedOptions: { nativeLlm?: () => unknown } = {};
    mocks.createRunTurnOverride.mockImplementation((_providers, _root, options) => {
      capturedOptions = options ?? {};
      return engine;
    });
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBe(engine);

    // The nativeLlm callback re-reads the config file on each invocation so
    // TUI model switches are followed.
    expect(typeof capturedOptions.nativeLlm).toBe('function');
    mocks.loadRuntimeConfigSafe.mockClear();
    capturedOptions.nativeLlm?.();
    expect(mocks.loadRuntimeConfigSafe).toHaveBeenCalledTimes(1);
  });
});

describe('multiLlm / nativeLlm config extraction (through the adapter call)', () => {
  it('extracts the listed multiLlm providers into the adapter providers arg', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: makeConfig({
        agent: { engine: 'rust', multiLlm: ['kimi', 'anthropic'] },
      }),
    });
    const engine = vi.fn();
    let capturedProviders: unknown;
    mocks.createRunTurnOverride.mockImplementation((providers) => {
      capturedProviders = providers;
      return engine;
    });
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBe(engine);

    expect(capturedProviders).toEqual([
      { name: 'kimi', model: 'kimi-k2', system_prompt: 'default prompt' },
      { name: 'anthropic', model: 'claude-x', system_prompt: '' },
    ]);
  });

  it('resolves the native LLM from the default model provider, falling back to nativeLlmProvider', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig() });
    const engine = vi.fn();
    let capturedNativeLlm: unknown;
    mocks.createRunTurnOverride.mockImplementation((_providers, _root, options) => {
      capturedNativeLlm = options?.nativeLlm?.();
      return engine;
    });
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBe(engine);

    // defaultModel kimi-k2 → provider kimi → openai protocol with the
    // model alias's system prompt.
    expect(capturedNativeLlm).toEqual({
      protocol: 'openai',
      base_url: 'https://api.example.com/v1',
      api_key: 'k',
      model: 'kimi-k2',
    });
  });

  it('falls back to agent.nativeLlmProvider when the default model provider is unsupported', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: makeConfig({
        defaultModel: 'other-model',
        models: {
          'other-model': { provider: 'unsupported', model: 'other-model' },
          'kimi-k2': { provider: 'kimi', model: 'kimi-k2', systemPrompt: 'default prompt' },
        },
        agent: { engine: 'rust', nativeLlmProvider: 'kimi' },
      }),
    });
    const engine = vi.fn();
    let capturedNativeLlm: unknown;
    mocks.createRunTurnOverride.mockImplementation((_providers, _root, options) => {
      capturedNativeLlm = options?.nativeLlm?.();
      return engine;
    });
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBe(engine);

    expect(capturedNativeLlm).toEqual({
      protocol: 'openai',
      base_url: 'https://api.example.com/v1',
      api_key: 'k',
      model: 'kimi-k2',
    });
  });

  it('returns undefined nativeLlm when no provider has a static key/url', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: makeConfig({
        providers: {
          kimi: { defaultModel: 'kimi-k2', type: 'kimi' },
        },
        agent: { engine: 'rust', nativeLlmProvider: 'kimi' },
      }),
    });
    const engine = vi.fn();
    let capturedNativeLlm: unknown;
    mocks.createRunTurnOverride.mockImplementation((_providers, _root, options) => {
      capturedNativeLlm = options?.nativeLlm?.();
      return engine;
    });
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBe(engine);
    expect(capturedNativeLlm).toBeUndefined();
  });

  it('warns when multiLlm is set but engine is not rust (no-op)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: makeConfig({ agent: { engine: 'js', multiLlm: ['kimi'] } }),
    });
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('agent.multiLlm is set but agent.engine is not "rust"'),
    );
  });
});
