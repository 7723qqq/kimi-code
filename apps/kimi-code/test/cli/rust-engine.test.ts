import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadRuntimeConfigSafe: vi.fn(),
  resolveConfigPath: vi.fn(),
  resolveKimiHome: vi.fn(),
  createRunTurnOverride: vi.fn(),
  activeEngineMode: vi.fn(),
  probeHostEnvironment: vi.fn(),
  isRustEngineAvailable: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mocks.existsSync,
    readdirSync: mocks.readdirSync,
  };
});

vi.mock('@moonshot-ai/kimi-code-sdk', () => ({
  loadRuntimeConfigSafe: mocks.loadRuntimeConfigSafe,
  resolveConfigPath: mocks.resolveConfigPath,
  resolveKimiHome: mocks.resolveKimiHome,
}));

vi.mock('@moonshot-ai/agent-core-v2', () => ({
  probeHostEnvironment: mocks.probeHostEnvironment,
}));

vi.mock('@moonshot-ai/kimi-agent/rust-loop', () => ({
  createRunTurnOverride: mocks.createRunTurnOverride,
  isRustEngineAvailable: mocks.isRustEngineAvailable,
  activeEngineMode: mocks.activeEngineMode,
}));

import { normalizeBaseUrl } from '../../src/cli/rust-engine';

/** Fresh module per test so the module-level rustTurnEngine cache resets. */
async function loadMaybeRustEngine() {
  vi.resetModules();
  const mod = await import('../../src/cli/rust-engine');
  return mod.maybeLoadRustEngine;
}

/**
 * Same, plus the `/status` snapshot module the loader writes into and the
 * options object handed to the adapter, so the observer can be driven directly.
 */
async function loadEngineAndSnapshot() {
  vi.resetModules();
  let captured: Record<string, unknown> = {};
  mocks.createRunTurnOverride.mockImplementation((_providers, _root, options) => {
    captured = options ?? {};
    return vi.fn();
  });
  const mod = await import('../../src/cli/rust-engine');
  const snapshot = await import('../../src/utils/engine-execution');
  return {
    maybeLoadRustEngine: mod.maybeLoadRustEngine,
    snapshot,
    capturedOptions: () => captured,
  };
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
  mocks.activeEngineMode.mockReset().mockReturnValue('napi');
  mocks.probeHostEnvironment.mockReset().mockResolvedValue({ shellPath: undefined });
  mocks.isRustEngineAvailable.mockReset().mockReturnValue(false);
  // Bundle-present default: the rust-only gate requires a loadable bundle,
  // so the happy paths run against a loadable fixture; gate tests that pin
  // the missing-bundle error flip this back to false explicitly.
  mocks.existsSync.mockReset().mockReturnValue(true);
  mocks.readdirSync.mockReset().mockImplementation(() => {
    throw new Error('engine addon dir not present in this fixture');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maybeLoadRustEngine', () => {
  it('throws when the config file cannot be read and no bundle is present (TS engine disabled)', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: makeConfig(),
      fileError: new Error('unreadable'),
    });
    mocks.existsSync.mockReturnValue(false);
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    // An unreadable config cannot express an engine preference, so the gate
    // treats it as unset — and unset requires the rust bundle.
    await expect(maybeLoadRustEngine('/home/u')).rejects.toThrow('TS agent engine is disabled');
    expect(mocks.createRunTurnOverride).not.toHaveBeenCalled();
  });

  it('throws when the engine is unset and the bundle is missing (TS engine disabled)', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig({ agent: {} }) });
    mocks.existsSync.mockReturnValue(false);
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    // Unset defaults to rust, so the bundle-presence guard is consulted and
    // finds nothing in this fixture — a startup error, not a JS fallback.
    await expect(maybeLoadRustEngine('/home/u')).rejects.toThrow('TS agent engine is disabled');
    expect(mocks.existsSync).toHaveBeenCalled();
  });

  it('throws on explicit agent.engine = "rust" when the bundle is missing', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig() });
    mocks.existsSync.mockReturnValue(false);
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).rejects.toThrow('TS agent engine is disabled');
  });

  it('defaults to the engine when agent.engine is unset and the bundle is loadable', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig({ agent: {} }) });
    mocks.existsSync.mockReturnValue(true);
    const engine = vi.fn();
    mocks.createRunTurnOverride.mockReturnValue(engine);
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBe(engine);
    expect(mocks.createRunTurnOverride).toHaveBeenCalledTimes(1);
  });

  it('ignores agent.engine = "js": warned, then the bundle guard applies like unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: makeConfig({ agent: { engine: 'js' } }),
    });
    mocks.existsSync.mockReturnValue(false);
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    // No opt-out during the migration: "js" does not bypass the rust-only
    // gate, so a missing bundle still fails startup.
    await expect(maybeLoadRustEngine('/home/u')).rejects.toThrow('TS agent engine is disabled');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored'));
    expect(mocks.createRunTurnOverride).not.toHaveBeenCalled();
  });

  it('wires the engine even on explicit agent.engine = "js" when the bundle is loadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: makeConfig({ agent: { engine: 'js' } }),
    });
    const engine = vi.fn();
    mocks.createRunTurnOverride.mockReturnValue(engine);
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBe(engine);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored'));
  });

  it('records the rust engine even when the config says "js" (value ignored)', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: makeConfig({ agent: { engine: 'js' } }),
    });
    const { maybeLoadRustEngine, snapshot } = await loadEngineAndSnapshot();
    await maybeLoadRustEngine('/home/u');
    expect(snapshot.engineExecution()).toEqual({ rust: true });
  });

  it('hands the adapter an observer that records the last turn for /status', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig() });
    const { maybeLoadRustEngine, snapshot, capturedOptions } = await loadEngineAndSnapshot();

    await maybeLoadRustEngine('/home/u');
    // Wired but not yet run: the report must not invent a transport.
    expect(snapshot.engineExecution()).toEqual({ rust: true });

    const onTurnResult = capturedOptions()['onTurnResult'] as
      | ((result: unknown) => void)
      | undefined;
    expect(typeof onTurnResult).toBe('function');
    onTurnResult?.({
      stopReason: 'completed',
      steps: 1,
      usage: {},
      telemetry: {
        eventsEmitted: 4,
        llmRetries: 0,
        llmTransport: 'native-http',
        nativeToolCallCount: 2,
      },
    });
    expect(snapshot.engineExecution()).toEqual({
      rust: true,
      transport: 'napi',
      llmTransport: 'native-http',
      nativeToolCalls: 2,
    });
  });

  it('throws when the adapter yields no engine (broken install, TS engine disabled)', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig() });
    mocks.createRunTurnOverride.mockReturnValue(undefined);
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).rejects.toThrow('failed to initialize');
  });

  it('wires the rust engine when agent.engine = "rust" and the adapter is available', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig() });
    const engine = vi.fn();
    mocks.createRunTurnOverride.mockReturnValue(engine);
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).resolves.toBe(engine);
    expect(mocks.createRunTurnOverride).toHaveBeenCalledTimes(1);
  });

  it('surfaces createRunTurnOverride failures instead of falling back to JS', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({ ...okResult, config: makeConfig() });
    mocks.createRunTurnOverride.mockImplementation(() => {
      throw new Error('native addon missing');
    });
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await expect(maybeLoadRustEngine('/home/u')).rejects.toThrow('native addon missing');
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

  it('P64: provider customHeaders reach the native transport', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: makeConfig({
        providers: {
          kimi: {
            defaultModel: 'kimi-k2',
            type: 'kimi',
            apiKey: 'k',
            baseUrl: 'https://api.example.com',
            customHeaders: { 'x-org-id': 'acme' },
          },
        },
      }),
    });
    const engine = vi.fn();
    let capturedNativeLlm: unknown;
    mocks.createRunTurnOverride.mockImplementation((_providers, _root, options) => {
      capturedNativeLlm = options?.nativeLlm?.();
      return engine;
    });
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await maybeLoadRustEngine('/home/u');

    expect(capturedNativeLlm).toEqual({
      protocol: 'openai',
      base_url: 'https://api.example.com/v1',
      api_key: 'k',
      model: 'kimi-k2',
      custom_headers: { 'x-org-id': 'acme' },
    });
  });

  it('P64: a provider cannot duplicate the credential headers the engine sets', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: makeConfig({
        providers: {
          kimi: {
            defaultModel: 'kimi-k2',
            type: 'kimi',
            apiKey: 'k',
            baseUrl: 'https://api.example.com',
            customHeaders: { Authorization: 'Bearer other', 'x-trace': 'on' },
          },
        },
      }),
    });
    const engine = vi.fn();
    let capturedNativeLlm: { custom_headers?: Record<string, string> } | undefined;
    mocks.createRunTurnOverride.mockImplementation((_providers, _root, options) => {
      capturedNativeLlm = options?.nativeLlm?.();
      return engine;
    });
    const maybeLoadRustEngine = await loadMaybeRustEngine();
    await maybeLoadRustEngine('/home/u');

    expect(
      capturedNativeLlm?.custom_headers,
      'P64: reqwest appends headers, so a second authorization would send a broken credential',
    ).toEqual({ 'x-trace': 'on' });
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

  it('P62: the native-transport decline is recorded on the status snapshot, not stdout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: makeConfig({
        providers: {
          kimi: { defaultModel: 'kimi-k2', type: 'kimi' },
        },
        agent: { engine: 'rust', nativeLlmProvider: 'kimi' },
      }),
    });
    const { maybeLoadRustEngine, snapshot, capturedOptions } = await loadEngineAndSnapshot();
    await maybeLoadRustEngine('/home/u');

    const nativeLlm = capturedOptions()['nativeLlm'] as () => unknown;
    expect(nativeLlm()).toBeUndefined();

    expect(snapshot.engineExecution()).toEqual({
      rust: true,
      llmFallbackReason:
        'provider "kimi" has no static baseUrl + apiKey for the native transport',
    });
    expect(
      warn,
      'P62: this resolver runs every turn, so warning here prints into the TUI once per turn',
    ).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('honours multiLlm even when engine = "js" is configured (value ignored)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: makeConfig({ agent: { engine: 'js', multiLlm: ['kimi'] } }),
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
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored'));
  });
});

describe('normalizeBaseUrl', () => {
  it('appends /v1 to anthropic baseUrls that carry a path component', () => {
    expect(normalizeBaseUrl('anthropic', 'https://api.minimaxi.com/anthropic')).toBe(
      'https://api.minimaxi.com/anthropic/v1',
    );
  });

  it('passes bare-host anthropic baseUrls through unchanged', () => {
    expect(normalizeBaseUrl('anthropic', 'https://api.anthropic.com')).toBe(
      'https://api.anthropic.com',
    );
  });

  it('passes anthropic baseUrls with /v1 already through unchanged', () => {
    expect(normalizeBaseUrl('anthropic', 'https://api.anthropic.com/v1')).toBe(
      'https://api.anthropic.com/v1',
    );
  });

  it('appends /v1 to bare-host openai baseUrls', () => {
    expect(normalizeBaseUrl('openai', 'https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1',
    );
  });

  it('passes openai baseUrls with /vN already through unchanged', () => {
    expect(normalizeBaseUrl('openai', 'https://api.example.com/v1')).toBe(
      'https://api.example.com/v1',
    );
    expect(normalizeBaseUrl('openai', 'https://api.z.ai/api/paas/v4')).toBe(
      'https://api.z.ai/api/paas/v4',
    );
  });

  it('strips trailing slashes before normalization', () => {
    expect(normalizeBaseUrl('anthropic', 'https://api.minimaxi.com/anthropic/')).toBe(
      'https://api.minimaxi.com/anthropic/v1',
    );
    expect(normalizeBaseUrl('openai', 'https://api.deepseek.com/')).toBe(
      'https://api.deepseek.com/v1',
    );
  });
});

describe('nativeLlm config extraction with /v1 normalization', () => {
  it('injects /v1 for the minimax-cn-coding-plan anthropic reverse proxy', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: {
        defaultModel: 'minimax-cn-coding-plan/MiniMax-M3',
        providers: {
          'minimax-cn-coding-plan': {
            type: 'anthropic',
            apiKey: 'sk-test',
            baseUrl: 'https://api.minimaxi.com/anthropic',
          },
        },
        models: {
          'minimax-cn-coding-plan/MiniMax-M3': {
            provider: 'minimax-cn-coding-plan',
            model: 'MiniMax-M3',
          },
        },
        agent: { engine: 'rust' },
      },
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
      protocol: 'anthropic',
      base_url: 'https://api.minimaxi.com/anthropic/v1',
      api_key: 'sk-test',
      model: 'MiniMax-M3',
    });
  });

  it('appends /v1 to a bare-host openai provider (e.g. deepseek)', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      ...okResult,
      config: {
        defaultModel: 'deepseek-v4-flash',
        providers: {
          deepseek: {
            type: 'openai',
            apiKey: 'sk-deepseek',
            baseUrl: 'https://api.deepseek.com',
          },
        },
        models: {
          'deepseek-v4-flash': { provider: 'deepseek', model: 'deepseek-v4-flash' },
        },
        agent: { engine: 'rust' },
      },
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
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-deepseek',
      model: 'deepseek-v4-flash',
    });
  });
});
