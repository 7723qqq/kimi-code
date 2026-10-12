/**
 * `kimi provider` CLI unit tests. The handlers receive an injected `getHarness`
 * + capturing stdout/stderr. Registry imports use a real harness and temporary
 * config storage; upstream HTTP responses are stubbed.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resetModelsDevUpstreamForTest,
  setModelsDevUpstreamForTest,
} from '@moonshot-ai/agent-core-v2/app/kosongConfig/modelsDevUpstream';
import type { KimiConfig, KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { Command } from 'commander';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  handleCatalogAdd,
  handleCatalogList,
  handleProviderAdd,
  handleProviderCreate,
  handleProviderList,
  handleProviderRemove,
  handleProviderUpdate,
  registerProviderCommand,
  type ProviderDeps,
} from '#/cli/sub/provider';
import { t } from '#/i18n';
import { buildAddPatch, planEditWrite, type ProviderFormValue } from '#/utils/provider-form';

// Spy on the SDK harness factory so the default-deps construction can be
// asserted without booting a real engine. The real implementations stay in
// place for everything else the handlers use.
const harnessRouting = vi.hoisted(() => ({
  kimiHarnessConstructor: vi.fn(),
  harness: undefined as unknown,
}));

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    createKimiHarness: (...args: unknown[]) => {
      harnessRouting.kimiHarnessConstructor(...args);
      return harnessRouting.harness;
    },
  };
});

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`);
  }
}

interface FakeHarness {
  ensureConfigFile: () => Promise<void>;
  getConfig: () => Promise<KimiConfig>;
  setConfig: (patch: Partial<KimiConfig>) => Promise<KimiConfig>;
  removeProvider: (providerId: string) => Promise<KimiConfig>;
  supportsAtomicSectionReplace: () => boolean;
  replaceConfigSections: (sections: Record<string, unknown>) => Promise<void>;
  close: () => Promise<void>;
}

function makeHarness(
  initial: KimiConfig,
  options: { readonly atomicSections?: boolean } = {},
): {
  harness: FakeHarness;
  current: () => KimiConfig;
  setConfigCalls: Array<Partial<KimiConfig>>;
  removeCalls: string[];
  sectionCalls: Array<Record<string, unknown>>;
} {
  // `persisted` simulates the on-disk config; the real RPC's `removeProvider`
  // reads from / writes to disk on every call (see
  // `packages/agent-core-v2/src/llm-adapter/provider/provider-service.ts`
  // `ProviderService.delete`). Tests must
  // model this: anything the handler builds up in its in-memory `config`
  // object disappears unless it is flushed via `setConfig` BEFORE the next
  // `removeProvider`.
  let persisted: KimiConfig = structuredClone(initial);
  const atomicSections = options.atomicSections === true;
  const setConfigCalls: Array<Partial<KimiConfig>> = [];
  const removeCalls: string[] = [];
  const sectionCalls: Array<Record<string, unknown>> = [];
  const harness: FakeHarness = {
    ensureConfigFile: async () => {},
    getConfig: async () => structuredClone(persisted),
    setConfig: async (patch) => {
      setConfigCalls.push(structuredClone(patch));
      // Mirror the real `setKimiConfig`: every domain is merged and `undefined`
      // values are skipped (see
      // `packages/agent-core-v2/src/app/config/configPure.ts deepMerge`). Both
      // halves are load-bearing: `setConfig({defaultModel: undefined})` must NOT
      // wipe a key from disk — only `removeProvider` can — and a patch naming
      // one provider must leave the other providers' records alone.
      //
      // `providers` and `models` merge by KEY, the way the engine's own
      // registrations merge a section instead of replacing the document. A fake
      // that replaced whole sections here would drop every other provider, which
      // makes it useless for the one question the two write shapes have to
      // answer together: do they leave the same config?
      const next: Record<string, unknown> = { ...persisted };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        next[key] = value;
      }
      if (patch.providers !== undefined) {
        next['providers'] = { ...persisted.providers, ...patch.providers };
      }
      if (patch.models !== undefined) {
        next['models'] = { ...persisted.models, ...patch.models };
      }
      persisted = next as KimiConfig;
      return structuredClone(persisted);
    },
    removeProvider: async (providerId) => {
      removeCalls.push(providerId);
      const nextProviders = { ...persisted.providers };
      delete nextProviders[providerId];
      const nextModels = { ...persisted.models };
      let removedDefault = false;
      for (const [alias, model] of Object.entries(nextModels)) {
        if (model.provider === providerId) {
          delete nextModels[alias];
          if (persisted.defaultModel === alias) removedDefault = true;
        }
      }
      // The real cascade lands both sections in one replace and clears a
      // dangling pointer by deleting it, so the fake drops the key too rather
      // than leaving an `undefined` behind for the next assertion to trip on.
      const nextConfig: Record<string, unknown> = {
        ...persisted,
        providers: nextProviders,
        models: nextModels,
      };
      if (removedDefault) delete nextConfig['defaultModel'];
      persisted = nextConfig as KimiConfig;
      return structuredClone(persisted);
    },
    supportsAtomicSectionReplace: () => atomicSections,
    // Mirror `configService.replaceSections`: a named section is replaced
    // wholesale, and `undefined` CLEARS it — the opposite of `setConfig`'s
    // "skip an undefined domain". A fake that merged here would keep passing
    // while the real v2 host dropped a dangling pointer the write meant to
    // clear.
    replaceConfigSections: async (sections) => {
      sectionCalls.push(structuredClone(sections));
      const next = structuredClone(persisted) as Record<string, unknown>;
      for (const [domain, value] of Object.entries(sections)) {
        if (value === undefined) {
          delete next[domain];
        } else {
          next[domain] = structuredClone(value);
        }
      }
      persisted = next as KimiConfig;
    },
    close: async () => {},
  };
  return {
    harness,
    current: () => persisted,
    setConfigCalls,
    removeCalls,
    sectionCalls,
  };
}

function makeDeps(
  harness: FakeHarness,
  overrides: Partial<ProviderDeps> = {},
): {
  deps: ProviderDeps;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const deps: ProviderDeps = {
    getHarness: () =>
      harness as unknown as ProviderDeps extends { getHarness: () => infer R } ? R : never,
    stdout: {
      write: (chunk: string) => {
        stdout.push(chunk);
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr.push(chunk);
        return true;
      },
    },
    env: {},
    exit: ((code: number) => {
      exitCodes.push(code);
      throw new ExitCalled(code);
    }) as ProviderDeps['exit'],
    ...overrides,
  };
  return { deps, stdout, stderr, exitCodes };
}

async function tryRun<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ExitCalled) return undefined;
    throw error;
  }
}

/**
 * Whether the record itself carries the key. The difference matters here: a
 * deleted key and a key written as `undefined` read the same through `?.`, but
 * only the first is what "clear" means.
 */
function hasKey(record: object | undefined, key: string): boolean {
  return record !== undefined && Object.hasOwn(record, key);
}

const REGISTRY_URL = 'https://registry.example.test/v1/models/api.json';
const REGISTRY_BODY = {
  kohub: {
    id: 'kohub',
    name: 'KoHub Anthropic',
    api: 'https://registry.example.test',
    type: 'anthropic',
    models: {
      'claude-opus-4-7': { id: 'claude-opus-4-7', name: 'Claude Opus 4-7', tool_call: true },
    },
  },
  'kohub-responses': {
    id: 'kohub-responses',
    name: 'KoHub Responses',
    api: 'https://registry.example.test/v1',
    type: 'openai_responses',
    models: {
      'gpt-5.5': { id: 'gpt-5.5', name: 'GPT 5.5', reasoning: true },
    },
  },
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

const registryHarnesses: KimiHarness[] = [];

async function makeRegistryHarness(initial: KimiConfig) {
  const { createKimiHarness } = await vi.importActual<typeof import('@moonshot-ai/kimi-code-sdk')>(
    '@moonshot-ai/kimi-code-sdk',
  );
  const homeDir = await mkdtemp(join(tmpdir(), 'registry-cli-'));
  const harness = createKimiHarness({
    homeDir,
    identity: { productName: 'registry-test', version: '0.0.0-test', platform: 'test' },
  });
  registryHarnesses.push(harness);
  await harness.setConfig(initial);
  return { harness, current: () => harness.getConfig({ reload: true }) };
}

afterEach(async () => {
  for (const harness of registryHarnesses.splice(0)) {
    await harness.close();
    await rm(harness.homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }
  resetModelsDevUpstreamForTest();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockRegistryFetch(body: unknown = REGISTRY_BODY, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  setModelsDevUpstreamForTest({ fetchImpl: globalThis.fetch });
  return fetchMock;
}

const CATALOG_BODY = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    npm: '@ai-sdk/anthropic',
    api: 'https://api.anthropic.com',
    env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-opus-4-7': {
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7',
        limit: { context: 200_000, output: 64_000 },
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        limit: { context: 200_000, output: 16_000 },
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    npm: '@ai-sdk/openai',
    api: 'https://api.openai.com/v1',
    env: ['OPENAI_API_KEY'],
    models: {
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT 5.5',
        limit: { context: 1_048_576, output: 128_000 },
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    },
  },
};

describe('kimi provider add', () => {
  it('imports providers and models from a custom registry, persisting source on each provider', async () => {
    const fetchMock = mockRegistryFetch();
    const { harness, current } = await makeRegistryHarness({ providers: {} } as KimiConfig);
    const { deps, stdout, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderAdd(deps, REGISTRY_URL, { apiKey: 'sk-test-token' }));

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    expect(fetchMock).toHaveBeenCalledWith(
      REGISTRY_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test-token' }),
      }),
    );

    const finalConfig = await current();
    expect(Object.keys(finalConfig.providers).toSorted()).toEqual(['kohub', 'kohub-responses']);
    const kohub = finalConfig.providers['kohub']!;
    expect(kohub.type).toBe('anthropic');
    expect(kohub.baseUrl).toBe('https://registry.example.test');
    expect(kohub.apiKey).toBe('sk-test-token');
    expect(kohub.source).toEqual({
      kind: 'apiJson',
      url: REGISTRY_URL,
      apiKey: 'sk-test-token',
    });

    expect(finalConfig.models?.['kohub/claude-opus-4-7']).toMatchObject({
      provider: 'kohub',
      model: 'claude-opus-4-7',
    });
    expect(finalConfig.models?.['kohub-responses/gpt-5.5']).toMatchObject({
      provider: 'kohub-responses',
      model: 'gpt-5.5',
    });

    const output = stdout.join('');
    expect(output).toContain('Imported 2 providers (2 models)');
    expect(output).toContain('- kohub');
    expect(output).toContain('- kohub-responses');
  });

  it('persists registry removals and clears dangling defaults', async () => {
    mockRegistryFetch();
    const initial: KimiConfig = {
      providers: {
        kohub: {
          type: 'anthropic',
          baseUrl: 'https://registry.example.test',
          apiKey: 'old',
          source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'old' },
        },
        gone: {
          type: 'openai',
          baseUrl: 'https://registry.example.test/gone',
          apiKey: 'old',
          source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'old' },
        },
      },
      models: {
        'gone/m1': { provider: 'gone', model: 'm1', maxContextSize: 1024, capabilities: [] },
      },
      defaultModel: 'gone/m1',
      thinking: { enabled: false },
    } as unknown as KimiConfig;
    const { harness, current } = await makeRegistryHarness(initial);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderAdd(deps, REGISTRY_URL, {}));

    expect(exitCodes).toEqual([]);
    expect((await current()).providers['gone']).toBeUndefined();
    expect((await current()).models?.['gone/m1']).toBeUndefined();
    expect((await current()).defaultModel).toBeUndefined();
    expect((await current()).thinking?.enabled).toBeUndefined();
  });

  it('reads the api key from KIMI_REGISTRY_API_KEY when --api-key is omitted', async () => {
    const fetchMock = mockRegistryFetch();
    const { harness } = await makeRegistryHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness, {
      env: { KIMI_REGISTRY_API_KEY: 'sk-env-token' },
    });

    await tryRun(() => handleProviderAdd(deps, REGISTRY_URL, {}));

    expect(exitCodes).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      REGISTRY_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-env-token' }),
      }),
    );
  });

  it('does not change the config when the registry has no usable providers', async () => {
    mockRegistryFetch({});
    const initial: KimiConfig = {
      providers: {
        kohub: {
          type: 'openai',
          baseUrl: 'https://registry.example.test/v1',
          apiKey: 'sk-old',
          source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'sk-old' },
        },
      },
      models: {
        'kohub/m1': { provider: 'kohub', model: 'm1', maxContextSize: 1024 },
      },
      defaultModel: 'kohub/m1',
    } as unknown as KimiConfig;
    const { harness, current } = await makeRegistryHarness(initial);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderAdd(deps, REGISTRY_URL, {}));

    expect(exitCodes).toEqual([1]);
    expect(await current()).toMatchObject(initial);
  });

  it('exits 1 when the registry fetch fails with an HTTP error', async () => {
    mockRegistryFetch({ message: 'invalid token' }, 401);
    const { harness } = await makeRegistryHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderAdd(deps, REGISTRY_URL, { apiKey: 'sk-bad' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toMatch(/HTTP 401/);
  });

  it('reuses the stored registry key when a re-import passes no key', async () => {
    const fetchMock = mockRegistryFetch();
    const initial: KimiConfig = {
      providers: {
        kohub: {
          type: 'anthropic',
          baseUrl: 'https://registry.example.test',
          apiKey: 'sk-stored',
          source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'sk-stored' },
        },
      },
    } as unknown as KimiConfig;
    const { harness } = await makeRegistryHarness(initial);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderAdd(deps, REGISTRY_URL, {}));

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    expect(fetchMock).toHaveBeenCalledWith(
      REGISTRY_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-stored' }),
      }),
    );
  });
});

describe('kimi provider remove', () => {
  it('removes a provider and reports success', async () => {
    const initial: KimiConfig = {
      providers: {
        kohub: { type: 'anthropic', baseUrl: 'https://x', apiKey: 'k' },
      },
      models: {
        'kohub/m': {
          provider: 'kohub',
          model: 'm',
          maxContextSize: 1024,
          capabilities: [],
        },
      },
    } as unknown as KimiConfig;
    const { harness, removeCalls, current } = makeHarness(initial);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderRemove(deps, 'kohub'));

    expect(exitCodes).toEqual([]);
    expect(removeCalls).toEqual(['kohub']);
    expect(current().providers['kohub']).toBeUndefined();
    expect(stdout.join('')).toContain('Removed provider "kohub"');
  });

  it('exits 1 when the provider id does not exist', async () => {
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderRemove(deps, 'nope'));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Provider "nope" not found');
  });
});

describe('kimi provider list', () => {
  const config: KimiConfig = {
    providers: {
      kohub: {
        type: 'anthropic',
        baseUrl: 'https://x',
        apiKey: 'k',
        source: { kind: 'apiJson', url: REGISTRY_URL, apiKey: 'k' },
      },
      'managed:kimi-code': {
        type: 'kimi',
        baseUrl: 'https://api.kimi.com/coding/v1',
        oauth: { storage: 'file', key: 'oauth/kimi-code' },
      },
      manual: { type: 'openai', baseUrl: 'https://y', apiKey: 'm' },
    },
    models: {
      'kohub/a': {
        provider: 'kohub',
        model: 'a',
        maxContextSize: 1024,
        capabilities: [],
      },
      'kohub/b': {
        provider: 'kohub',
        model: 'b',
        maxContextSize: 1024,
        capabilities: [],
      },
      'manual/x': {
        provider: 'manual',
        model: 'x',
        maxContextSize: 1024,
        capabilities: [],
      },
    },
    defaultModel: 'kohub/a',
  } as unknown as KimiConfig;

  it('renders one row per provider with counts and source labels', async () => {
    const { harness } = makeHarness(config);
    const { deps, stdout } = makeDeps(harness);

    await tryRun(() => handleProviderList(deps, { json: false }));

    const out = stdout.join('');
    expect(out).toMatch(/kohub\s+type=anthropic\s+models=2\s+source=apiJson\(/);
    expect(out).toMatch(/managed:kimi-code\s+type=kimi\s+models=0\s+source=oauth/);
    expect(out).toMatch(/manual\s+type=openai\s+models=1\s+source=inline/);
    expect(out).toContain('Default model: kohub/a');
  });

  it('prints a friendly message when nothing is configured', async () => {
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout } = makeDeps(harness);

    await tryRun(() => handleProviderList(deps, { json: false }));

    expect(stdout.join('')).toContain('No providers configured');
  });

  it('emits parseable JSON with --json', async () => {
    const { harness } = makeHarness(config);
    const { deps, stdout } = makeDeps(harness);

    await tryRun(() => handleProviderList(deps, { json: true }));

    const parsed = JSON.parse(stdout.join('')) as {
      providers: Record<string, Record<string, unknown>>;
      models: Record<string, unknown>;
    };
    expect(Object.keys(parsed.providers).toSorted()).toEqual([
      'kohub',
      'managed:kimi-code',
      'manual',
    ]);
    expect(Object.keys(parsed.models)).toContain('kohub/a');
    // apiKey must never leak to stdout
    for (const p of Object.values(parsed.providers)) {
      expect(p['apiKey']).toBeUndefined();
    }
  });
});

describe('registerProviderCommand', () => {
  it('describes the user-facing subcommand and routes flags through commander', async () => {
    const fetchMock = mockRegistryFetch();
    const { harness, current } = await makeRegistryHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes, stdout } = makeDeps(harness);

    const program = new Command('kimi');
    registerProviderCommand(program, deps);

    const providerCmd = program.commands.find((c) => c.name() === 'provider');
    expect(providerCmd?.description()).toMatch(/Manage LLM providers/i);

    await tryRun(() =>
      program.parseAsync(['node', 'kimi', 'provider', 'add', REGISTRY_URL, '--api-key', 'sk-cli'], {
        from: 'node',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      REGISTRY_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-cli' }),
      }),
    );
    expect(Object.keys((await current()).providers).toSorted()).toEqual([
      'kohub',
      'kohub-responses',
    ]);
    expect(stdout.join('')).toContain('Imported 2 providers');
  });

  it('reports write failures on stderr and exits 1 instead of crashing', async () => {
    const { harness } = makeHarness({
      providers: { kimi: { type: 'kimi' } },
    } as unknown as KimiConfig);
    // Simulate the strict write path rejecting because config.toml is invalid.
    harness.removeProvider = async () => {
      throw new Error(
        'Cannot change settings while config.toml is invalid — fix it first (run `kimi doctor` for details).',
      );
    };
    const { deps, stderr, exitCodes } = makeDeps(harness);

    const program = new Command('kimi');
    registerProviderCommand(program, deps);

    await tryRun(() =>
      program.parseAsync(['node', 'kimi', 'provider', 'remove', 'kimi'], { from: 'node' }),
    );

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Cannot change settings');
    expect(stderr.join('')).not.toContain('    at '); // no stack trace dump
  });
});

describe('kimi provider catalog list', () => {
  it('lists catalog providers with wire/model counts, sorted by id', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogList(deps, undefined, { json: false }));

    expect(exitCodes).toEqual([]);
    const out = stdout.join('');
    expect(out).toMatch(/^anthropic\s+wire=anthropic\s+models=2\s+Anthropic\n/);
    expect(out).toMatch(/openai\s+wire=openai\s+models=1\s+OpenAI/);
    // anthropic before openai (alphabetical).
    expect(out.indexOf('anthropic')).toBeLessThan(out.indexOf('openai'));
  });

  it('filters case-insensitively by id and name substring', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout } = makeDeps(harness);

    await tryRun(() => handleCatalogList(deps, undefined, { json: false, filter: 'open' }));

    const out = stdout.join('');
    expect(out).toContain('openai');
    expect(out).not.toContain('anthropic');
  });

  it('drills into a specific providerId and lists its models with capabilities', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout } = makeDeps(harness);

    await tryRun(() => handleCatalogList(deps, 'anthropic', { json: false }));

    const out = stdout.join('');
    expect(out).toMatch(/^Anthropic \(anthropic\)/);
    expect(out).toMatch(/claude-opus-4-7\s+ctx=200000.*tool_use.*thinking.*image_in/);
    expect(out).toMatch(/claude-haiku-4-5\s+ctx=200000.*tool_use/);
  });

  it('exits 1 when the requested providerId is missing from the catalog', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogList(deps, 'unknown', { json: false }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Provider "unknown" not found in catalog');
  });

  it('emits parseable JSON for the providerId view', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout } = makeDeps(harness);

    await tryRun(() => handleCatalogList(deps, 'openai', { json: true }));

    const parsed = JSON.parse(stdout.join('')) as {
      providerId: string;
      models: Array<{ id: string }>;
    };
    expect(parsed.providerId).toBe('openai');
    expect(parsed.models.map((m) => m.id)).toEqual(['gpt-5.5']);
  });

  it('honors --url override when supplied', async () => {
    const fetchMock = mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogList(deps, undefined, { json: true, url: 'https://example.test/catalog.json' }),
    );

    expect(fetchMock).toHaveBeenCalledWith('https://example.test/catalog.json', expect.any(Object));
  });
});

describe('kimi provider catalog add', () => {
  it('imports a provider from the catalog without changing the default model', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const initial: KimiConfig = {
      providers: {
        other: { type: 'kimi', baseUrl: 'https://x', apiKey: 'k' },
      },
      models: {
        'other/main': {
          provider: 'other',
          model: 'main',
          maxContextSize: 1024,
          capabilities: [],
        },
      },
      defaultModel: 'other/main',
      thinking: { enabled: true },
    } as unknown as KimiConfig;
    const { harness, current, setConfigCalls } = makeHarness(initial);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'anthropic', { apiKey: 'sk-ant-token' }));

    expect(exitCodes).toEqual([]);
    const finalConfig = current();
    expect(finalConfig.providers['anthropic']).toMatchObject({
      type: 'anthropic',
      apiKey: 'sk-ant-token',
    });
    // Catalog import populates the model aliases.
    expect(finalConfig.models?.['anthropic/claude-opus-4-7']).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
    });
    expect(finalConfig.models?.['anthropic/claude-haiku-4-5']).toBeDefined();
    // The unrelated provider's model survives, and remains the default.
    expect(finalConfig.models?.['other/main']).toBeDefined();
    expect(finalConfig.defaultModel).toBe('other/main');
    expect(finalConfig.thinking?.enabled).toBe(true);
    // The patch sent over `setConfig` must explicitly carry the preserved default.
    expect(setConfigCalls[0]?.defaultModel).toBe('other/main');
    expect(stdout.join('')).toContain('Imported Anthropic (anthropic)');
  });

  it('sets default_model when --default-model is supplied and the model exists', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness, current, setConfigCalls } = makeHarness({
      providers: {},
    } as KimiConfig);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'anthropic', {
        apiKey: 'sk-ant-token',
        defaultModel: 'claude-opus-4-7',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().defaultModel).toBe('anthropic/claude-opus-4-7');
    expect(setConfigCalls[0]?.defaultModel).toBe('anthropic/claude-opus-4-7');
    expect(stdout.join('')).toContain('Default model set to anthropic/claude-opus-4-7');
  });

  it('rejects an unknown --default-model with a helpful hint', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'anthropic', {
        apiKey: 'sk-ant-token',
        defaultModel: 'does-not-exist',
      }),
    );

    expect(exitCodes).toEqual([1]);
    const err = stderr.join('');
    expect(err).toContain('"does-not-exist" is not in provider "anthropic"');
    expect(err).toContain('kimi provider catalog list anthropic');
  });

  it('preserves an existing default_model when re-importing the same provider without --default-model', async () => {
    // Regression test for the codex P2: `removeProvider` clears
    // `defaultModel` if it pointed at one of the provider's aliases. The
    // handler must capture the previous default BEFORE calling
    // `removeProvider`, otherwise rotating the api key on an already-
    // configured provider would silently wipe the user's chosen default.
    mockRegistryFetch(CATALOG_BODY);
    const initial: KimiConfig = {
      providers: {
        anthropic: {
          type: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-old',
        },
      },
      models: {
        'anthropic/claude-opus-4-7': {
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          maxContextSize: 200_000,
          capabilities: ['tool_use', 'thinking', 'image_in'],
        },
      },
      defaultModel: 'anthropic/claude-opus-4-7',
      thinking: { enabled: true },
    } as unknown as KimiConfig;
    const { harness, current } = makeHarness(initial);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'anthropic', { apiKey: 'sk-rotated' }));

    expect(exitCodes).toEqual([]);
    expect(current().providers['anthropic']?.apiKey).toBe('sk-rotated');
    // Previous default and thinking flag must survive the re-import.
    expect(current().defaultModel).toBe('anthropic/claude-opus-4-7');
    expect(current().thinking?.enabled).toBe(true);
  });

  it('preserves thinking.enabled when --default-model is supplied to a thinking-capable model', async () => {
    // Regression test for the codex P2: `applyCatalogProvider` always
    // assigns `thinking.enabled` from `options.thinking`. Hardcoding `false`
    // silently disabled thinking even when the user previously had it on
    // and is just importing a known provider. The handler now threads the
    // previous value through.
    mockRegistryFetch(CATALOG_BODY);
    const initial: KimiConfig = {
      providers: {},
      thinking: { enabled: true },
    } as unknown as KimiConfig;
    const { harness, current, setConfigCalls } = makeHarness(initial);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'anthropic', {
        apiKey: 'sk-ant',
        defaultModel: 'claude-opus-4-7',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().defaultModel).toBe('anthropic/claude-opus-4-7');
    expect(current().thinking?.enabled).toBe(true);
    expect(setConfigCalls[0]?.thinking?.enabled).toBe(true);
  });

  it('does not persist thinking.enabled=false for first-time setup with --default-model', async () => {
    // Regression test for codex P2 follow-up: previously the handler fell
    // back to `false` when `thinking.enabled` was unset, but
    // `resolveThinkingEffort` treats `thinking.enabled === false` as an
    // explicit "off" request. A fresh `kimi provider catalog add
    // anthropic --default-model claude-opus-4-7` must NOT silently disable
    // thinking — it should leave `thinking.enabled` unset so the runtime
    // uses the per-model default.
    mockRegistryFetch(CATALOG_BODY);
    // Note: `thinking.enabled` is omitted on purpose to model a fresh user.
    const { harness, current, setConfigCalls } = makeHarness({
      providers: {},
    } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'anthropic', {
        apiKey: 'sk-ant',
        defaultModel: 'claude-opus-4-7',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().defaultModel).toBe('anthropic/claude-opus-4-7');
    // Must NOT be `false`. `undefined` lets the runtime resolver pick the
    // per-model default; `false` would force `'off'`.
    expect(current().thinking?.enabled).toBeUndefined();
    expect(setConfigCalls[0]?.thinking?.enabled).toBeUndefined();
  });

  it('drops a stale default_model when the catalog refresh no longer contains it', async () => {
    // Regression test for codex P2: when the user previously chose
    // `anthropic/legacy` as default and a refresh of the same provider no
    // longer ships that model, restoring the previous default would point
    // `default_model` at a non-existent alias and break the next session.
    // The handler now checks whether the alias still resolves and clears
    // it otherwise.
    mockRegistryFetch(CATALOG_BODY);
    const initial: KimiConfig = {
      providers: {
        anthropic: {
          type: 'anthropic',
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'sk-old',
        },
      },
      models: {
        'anthropic/legacy-claude': {
          provider: 'anthropic',
          model: 'legacy-claude',
          maxContextSize: 200_000,
          capabilities: [],
        },
      },
      defaultModel: 'anthropic/legacy-claude',
    } as unknown as KimiConfig;
    const { harness, current } = makeHarness(initial);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'anthropic', { apiKey: 'sk-rotated' }));

    expect(exitCodes).toEqual([]);
    // The legacy alias must have been replaced by the catalog's models.
    expect(current().models?.['anthropic/legacy-claude']).toBeUndefined();
    expect(current().models?.['anthropic/claude-opus-4-7']).toBeDefined();
    // The dangling default must NOT have been restored — it would point at
    // a non-existent alias. The handler clears it instead.
    expect(current().defaultModel).toBeUndefined();
  });

  it('falls back to KIMI_REGISTRY_API_KEY when --api-key is omitted', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness, {
      env: { KIMI_REGISTRY_API_KEY: 'sk-env' },
    });

    await tryRun(() => handleCatalogAdd(deps, 'openai', {}));

    expect(exitCodes).toEqual([]);
    expect(current().providers['openai']).toMatchObject({ apiKey: 'sk-env' });
  });

  it('lets --base-url override the catalog-declared endpoint', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'openai', {
        apiKey: 'sk-o',
        baseUrl: 'https://proxy.example.test/v1',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().providers['openai']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://proxy.example.test/v1',
    });
  });

  it('strips a trailing /v1 from --base-url for Anthropic-wire imports', async () => {
    mockRegistryFetch({
      'claude-gateway': {
        id: 'claude-gateway',
        name: 'Claude Gateway',
        npm: '@custom/claude-gateway',
        models: { 'claude-x': { id: 'claude-x', limit: { context: 1000 } } },
      },
    });
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'claude-gateway', {
        apiKey: 'sk-gw',
        baseUrl: 'https://claude-gateway.example.test/v1',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().providers['claude-gateway']).toMatchObject({
      type: 'anthropic',
      // The Anthropic SDK appends /v1/messages itself — persisting the /v1
      // would double it (/v1/v1/messages).
      baseUrl: 'https://claude-gateway.example.test',
    });
  });

  it('rejects an empty --base-url instead of persisting a blank endpoint', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'openai', { apiKey: 'sk-o', baseUrl: '   ' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('--base-url cannot be empty');
    await expect(harness.getConfig().then((c) => c.providers['openai'])).resolves.toBeUndefined();
  });

  it('requires --base-url for a non-official Anthropic-compatible vendor without one', async () => {
    mockRegistryFetch({
      'claude-gateway': {
        id: 'claude-gateway',
        name: 'Claude Gateway',
        npm: '@custom/claude-gateway',
        models: { 'claude-x': { id: 'claude-x', limit: { context: 1000 } } },
      },
    });
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'claude-gateway', { apiKey: 'sk-gw' }));
    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('--base-url');

    await tryRun(() =>
      handleCatalogAdd(deps, 'claude-gateway', {
        apiKey: 'sk-gw',
        baseUrl: 'https://claude-gateway.example.test',
      }),
    );
    expect(current().providers['claude-gateway']).toMatchObject({
      type: 'anthropic',
      baseUrl: 'https://claude-gateway.example.test',
    });
  });

  it('exits 1 when the api key is missing and skips the network', async () => {
    const fetchMock = mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'anthropic', {}));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toMatch(/missing api key/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exits 1 when the providerId is missing from the catalog', async () => {
    mockRegistryFetch(CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'no-such-id', { apiKey: 'sk-x' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Provider "no-such-id" not found in catalog');
  });

  const GUESS_CATALOG_BODY = {
    xai: {
      id: 'xai',
      name: 'xAI',
      npm: '@ai-sdk/xai',
      env: ['XAI_API_KEY'],
      models: {
        'grok-4': {
          id: 'grok-4',
          limit: { context: 256_000 },
          reasoning: true,
          reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }],
        },
      },
    },
    bedrock: {
      id: 'amazon-bedrock',
      name: 'Amazon Bedrock',
      npm: '@ai-sdk/amazon-bedrock',
      models: { 'claude-x': { id: 'claude-x', limit: { context: 1000 } } },
    },
    azure: {
      id: 'azure',
      name: 'Azure',
      npm: '@ai-sdk/azure',
      env: ['AZURE_API_KEY'],
      models: { 'gpt-x': { id: 'gpt-x', limit: { context: 1000 } } },
    },
  };

  it('guesses openai for a vendor-specific SDK and requires --base-url', async () => {
    mockRegistryFetch(GUESS_CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'xai', { apiKey: 'sk-xai' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('--base-url');
    await expect(harness.getConfig().then((c) => c.providers['xai'])).resolves.toBeUndefined();
  });

  it('imports a guessed vendor with --base-url, carrying off_effort and a guess note', async () => {
    mockRegistryFetch(GUESS_CATALOG_BODY);
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleCatalogAdd(deps, 'xai', { apiKey: 'sk-xai', baseUrl: 'https://api.x.ai/v1' }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().providers['xai']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: 'sk-xai',
    });
    expect(current().models?.['xai/grok-4']).toMatchObject({
      supportEfforts: ['low', 'medium', 'high'],
      offEffort: 'none',
    });
    expect(stdout.join('')).toContain('guessed "openai"');
  });

  it('refuses a proprietary SDK (bedrock) instead of guessing', async () => {
    mockRegistryFetch(GUESS_CATALOG_BODY);
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'bedrock', { apiKey: 'sk-x' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('proprietary');
  });

  it('requires --base-url for a vendor with no catalog endpoint (azure shape)', async () => {
    mockRegistryFetch(GUESS_CATALOG_BODY);
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleCatalogAdd(deps, 'azure', { apiKey: 'sk-az' }));
    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('--base-url');

    await tryRun(() =>
      handleCatalogAdd(deps, 'azure', {
        apiKey: 'sk-az',
        baseUrl: 'https://res.example.test/openai/v1',
      }),
    );
    expect(current().providers['azure']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://res.example.test/openai/v1',
    });
  });
});

describe('kimi provider engine routing', () => {
  beforeEach(() => {
    harnessRouting.kimiHarnessConstructor.mockClear();
    harnessRouting.harness = makeHarness({ providers: {} } as KimiConfig).harness;
  });

  function registerWithDefaultHarness(program: Command): void {
    registerProviderCommand(program, {
      stdout: { write: () => true },
      stderr: { write: () => true },
      env: {},
      exit: ((code: number) => {
        throw new ExitCalled(code);
      }) as ProviderDeps['exit'],
    });
  }

  it('builds the harness through the SDK factory', async () => {
    const program = new Command('kimi');
    registerWithDefaultHarness(program);

    await program.parseAsync(['node', 'kimi', 'provider', 'list'], { from: 'node' });

    expect(harnessRouting.kimiHarnessConstructor).toHaveBeenCalledTimes(1);
  });
});

const CREATE_FLAGS = {
  id: 'demo',
  type: 'openai',
  apiKey: 'sk-x',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-4.1',
  maxContextSize: '128000',
};

/** The form value `CREATE_FLAGS` must produce, in the shared module's shape. */
function demoFormValue(overrides: Partial<ProviderFormValue> = {}): ProviderFormValue {
  return {
    id: 'demo',
    type: 'openai',
    apiKey: 'sk-x',
    baseUrl: 'https://api.example.com/v1',
    models: [{ model: 'gpt-4.1', maxContextSize: '128000', displayName: '' }],
    ...overrides,
  };
}

/** A config whose demo provider carries fields the flags never touch. */
function makeRenameInitial(): KimiConfig {
  return {
    providers: {
      demo: {
        type: 'openai',
        apiKey: 'sk-x',
        baseUrl: 'https://api.example.com/v1',
        customHeaders: { 'x-tenant': 'acme' },
      },
      other: { type: 'anthropic', baseUrl: 'https://other.example.com' },
    },
    models: {
      'demo/gpt-4.1': {
        provider: 'demo',
        model: 'gpt-4.1',
        maxContextSize: 128_000,
        displayName: 'GPT 4.1',
        capabilities: ['tool_use'],
        maxOutputSize: 8192,
        maxInputSize: 272_000,
        supportEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        offEffort: 'none',
        adaptiveThinking: true,
      },
      'other/claude': { provider: 'other', model: 'claude', maxContextSize: 200_000 },
    },
    defaultModel: 'demo/gpt-4.1',
    defaultProvider: 'demo',
  } as unknown as KimiConfig;
}

describe('kimi provider create', () => {
  it('writes [providers.demo] and [models."demo/gpt-4.1"] under a temporary home', async () => {
    const { harness, current } = await makeRegistryHarness({ providers: {} } as KimiConfig);
    const { deps, stdout, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS }));

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    const config = await current();
    expect(config.providers['demo']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-x',
    });
    expect(config.models?.['demo/gpt-4.1']).toMatchObject({
      provider: 'demo',
      model: 'gpt-4.1',
      maxContextSize: 128_000,
      capabilities: ['tool_use', 'thinking'],
    });
    // The row is new and no flag named an optional field, so none of them is
    // written: `undefined` reads as "not presented", not as "cleared".
    expect(config.models?.['demo/gpt-4.1']?.maxInputSize).toBeUndefined();
    expect(config.models?.['demo/gpt-4.1']?.adaptiveThinking).toBeUndefined();
    expect(config.defaultModel).toBeUndefined();

    const toml = await readFile(join(harness.homeDir, 'config.toml'), 'utf8');
    expect(toml).toContain('[providers.demo]');
    expect(toml).toContain('[models."demo/gpt-4.1"]');

    const output = stdout.join('');
    expect(output).toContain('Provider "demo" added.');
    expect(output).toContain('  - demo/gpt-4.1');
    expect(output).not.toContain('sk-x');
  });

  it('writes every optional model field the flags name', async () => {
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderCreate(deps, {
        ...CREATE_FLAGS,
        maxInputSize: '64000',
        maxOutputSize: '8000',
        capabilities: ' tool_use,image_in , pdf_in ',
        supportEfforts: ' low,high ,low ',
        defaultEffort: 'high',
        offEffort: 'none',
        adaptiveThinking: true,
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().models?.['demo/gpt-4.1']).toMatchObject({
      maxInputSize: 64_000,
      maxOutputSize: 8000,
      capabilities: ['tool_use', 'image_in', 'pdf_in'],
      // parseEffortList trims and de-duplicates without reordering.
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      offEffort: 'none',
      adaptiveThinking: true,
    });
  });

  it('takes an explicitly blank optional flag as "clear this key"', async () => {
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderCreate(deps, {
        ...CREATE_FLAGS,
        capabilities: '',
        maxInputSize: '',
        supportEfforts: '',
      }),
    );

    expect(exitCodes).toEqual([]);
    // A blank `--capabilities` beats the shared default too: the row declares
    // nothing instead of `['tool_use', 'thinking']`.
    expect(current().models?.['demo/gpt-4.1']?.capabilities).toBeUndefined();
    expect(current().models?.['demo/gpt-4.1']?.maxInputSize).toBeUndefined();
    expect(current().models?.['demo/gpt-4.1']?.supportEfforts).toBeUndefined();
  });

  it('writes the per-model overrides the flags name', async () => {
    const { harness, current, setConfigCalls } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderCreate(deps, {
        ...CREATE_FLAGS,
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        protocol: 'anthropic',
        betaApi: true,
        reasoningKey: 'reasoning_content',
        modelBaseUrl: 'https://api.anthropic.com/beta',
      }),
    );

    expect(exitCodes).toEqual([]);
    // The patch is what the write layer hands the harness: pinning it fixes the
    // alias the row produced along with the config it leaves behind.
    expect(setConfigCalls[0]?.models?.['demo/gpt-4.1']).toMatchObject({
      protocol: 'anthropic',
      betaApi: true,
      reasoningKey: 'reasoning_content',
      baseUrl: 'https://api.anthropic.com/beta',
    });
    expect(current().models?.['demo/gpt-4.1']).toMatchObject({
      protocol: 'anthropic',
      betaApi: true,
      reasoningKey: 'reasoning_content',
      baseUrl: 'https://api.anthropic.com/beta',
    });
  });

  it('takes --protocol none as "fall back to the provider\'s type"', async () => {
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS, protocol: 'none' }));

    expect(exitCodes).toEqual([]);
    expect(hasKey(current().models?.['demo/gpt-4.1'], 'protocol')).toBe(false);
  });

  it('refuses a --protocol the alias schema cannot store', async () => {
    const { harness, setConfigCalls } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS, protocol: 'gemini' }));

    expect(exitCodes).toEqual([1]);
    // The option's own description enumerates the accepted values, the way
    // `--type`'s does.
    expect(stderr.join('')).toContain(t('cli.optionDescriptions.providerCreateProtocol'));
    expect(setConfigCalls).toEqual([]);
  });

  it('refuses --beta-api unless the row reaches the Anthropic transport', async () => {
    const { harness, current, setConfigCalls } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS, betaApi: true }));
    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain(t('tui.dialogs.providerForm.error.betaApiWithoutAnthropic'));
    expect(setConfigCalls).toEqual([]);

    // `--protocol` is enough: the transport is chosen per row, not only per
    // provider type.
    await tryRun(() =>
      handleProviderCreate(deps, { ...CREATE_FLAGS, betaApi: true, protocol: 'anthropic' }),
    );
    expect(exitCodes).toEqual([1]);
    expect(current().models?.['demo/gpt-4.1']?.betaApi).toBe(true);
  });

  it('declares an empty effort ladder for --support-efforts [] and clears the key on blank', async () => {
    const { harness: ladderHarness, current: ladderCurrent } = makeHarness({
      providers: {},
    } as KimiConfig);
    const { deps: ladderDeps, exitCodes: ladderExits } = makeDeps(ladderHarness);

    await tryRun(() => handleProviderCreate(ladderDeps, { ...CREATE_FLAGS, supportEfforts: '[]' }));

    expect(ladderExits).toEqual([]);
    // `[]` is the declared-empty ladder the engine reads differently from a
    // missing key, not an empty list to normalise away.
    expect(hasKey(ladderCurrent().models?.['demo/gpt-4.1'], 'supportEfforts')).toBe(true);
    expect(ladderCurrent().models?.['demo/gpt-4.1']?.supportEfforts).toEqual([]);

    const { harness: clearHarness, current: clearCurrent } = makeHarness({
      providers: {},
    } as KimiConfig);
    const { deps: clearDeps, exitCodes: clearExits } = makeDeps(clearHarness);

    await tryRun(() => handleProviderCreate(clearDeps, { ...CREATE_FLAGS, supportEfforts: '' }));

    expect(clearExits).toEqual([]);
    expect(hasKey(clearCurrent().models?.['demo/gpt-4.1'], 'supportEfforts')).toBe(false);
  });

  it('writes the provider-level fields the flags name', async () => {
    const { harness, current, setConfigCalls } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderCreate(deps, {
        ...CREATE_FLAGS,
        providerDefaultModel: 'gpt-4.1',
        customHeader: ['x-tenant=acme', 'x-src=cli'],
        env: ['FOO=bar', 'BAZ=qux'],
      }),
    );

    expect(exitCodes).toEqual([]);
    // Repeats are collected in the order typed, joined the way the shared
    // parser reads them.
    expect(setConfigCalls[0]?.providers?.['demo']).toMatchObject({
      defaultModel: 'demo/gpt-4.1',
      customHeaders: { 'x-tenant': 'acme', 'x-src': 'cli' },
      env: { FOO: 'bar', BAZ: 'qux' },
    });
    expect(current().providers['demo']).toMatchObject({
      defaultModel: 'demo/gpt-4.1',
      customHeaders: { 'x-tenant': 'acme', 'x-src': 'cli' },
      env: { FOO: 'bar', BAZ: 'qux' },
    });
  });

  it('accepts an env-var credential in place of --api-key and refuses both together', async () => {
    const { harness, current, setConfigCalls } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    const { apiKey: _omitted, ...withoutApiKey } = CREATE_FLAGS;
    await tryRun(() => handleProviderCreate(deps, { ...withoutApiKey, apiKeyEnv: 'DEMO_API_KEY' }));

    expect(exitCodes).toEqual([]);
    expect(current().providers['demo']?.apiKeyEnv).toBe('DEMO_API_KEY');
    expect(hasKey(current().providers['demo'], 'apiKey')).toBe(false);

    // The engine keeps the two credential sources apart, so a value setting
    // both is refused rather than resolved to one of them.
    await tryRun(() =>
      handleProviderCreate(deps, { ...CREATE_FLAGS, id: 'demo2', apiKeyEnv: 'DEMO_API_KEY' }),
    );

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain(t('tui.dialogs.providerForm.error.apiKeyConflict'));
    expect(setConfigCalls).toHaveLength(1);
  });

  it('refuses a provider default that names no row and a malformed header or env pair', async () => {
    const { harness, setConfigCalls } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderCreate(deps, { ...CREATE_FLAGS, providerDefaultModel: 'nope' }),
    );
    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS, customHeader: ['x-tenant'] }));
    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS, env: ['FOO'] }));

    expect(exitCodes).toEqual([1, 1, 1]);
    const err = stderr.join('');
    expect(err).toContain(t('tui.dialogs.providerForm.error.defaultModelUnknown'));
    expect(err).toContain(t('tui.dialogs.providerForm.error.headerInvalid'));
    expect(err).toContain(t('tui.dialogs.providerForm.error.envInvalid'));
    expect(setConfigCalls).toEqual([]);
  });

  it('refuses a capability or a default effort the shared rules reject', async () => {
    const { harness, setConfigCalls } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderCreate(deps, { ...CREATE_FLAGS, capabilities: 'tool_use,pdf' }),
    );
    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain(t('tui.dialogs.providerForm.error.capabilityUnknown'));

    await tryRun(() =>
      handleProviderCreate(deps, {
        ...CREATE_FLAGS,
        supportEfforts: 'low,high',
        defaultEffort: 'max',
      }),
    );
    expect(exitCodes).toEqual([1, 1]);
    expect(stderr.join('')).toContain(
      t('tui.dialogs.providerForm.error.defaultEffortNotSupported'),
    );
    expect(setConfigCalls).toEqual([]);
  });

  it('refuses a token budget that is not a positive integer', async () => {
    const { harness, setConfigCalls } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS, maxInputSize: '64k' }));
    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS, maxOutputSize: '0' }));

    expect(exitCodes).toEqual([1, 1]);
    expect(stderr.join('')).toContain(t('tui.dialogs.providerForm.error.contextSizeInvalid'));
    expect(setConfigCalls).toEqual([]);
  });

  it('writes exactly the patch buildAddPatch produces for the same form value', async () => {
    const { harness, current, setConfigCalls } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS, default: true }));

    expect(exitCodes).toEqual([]);
    expect(setConfigCalls).toEqual([
      { ...buildAddPatch(demoFormValue()), defaultModel: 'demo/gpt-4.1' },
    ]);
    expect(current().defaultModel).toBe('demo/gpt-4.1');
  });

  it('leaves default_model alone unless --default is passed', async () => {
    const { harness, current } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS }));

    expect(exitCodes).toEqual([]);
    expect(current().defaultModel).toBeUndefined();
  });

  it('emits a parseable, sanitized config over --json', async () => {
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS, json: true }));

    expect(exitCodes).toEqual([]);
    expect(stdout.join('')).not.toContain('sk-x');
    const parsed = JSON.parse(stdout.join('')) as {
      providers: Record<string, Record<string, unknown>>;
      models: Record<string, unknown>;
    };
    expect(parsed.providers['demo']?.['apiKey']).toBeUndefined();
    expect(parsed.providers['demo']?.['type']).toBe('openai');
    expect(Object.keys(parsed.models)).toEqual(['demo/gpt-4.1']);
  });

  it('keeps --json sanitized while showing the new provider and row fields', async () => {
    const { harness } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stdout, exitCodes } = makeDeps(harness);

    const { apiKey: _omitted, ...withoutApiKey } = CREATE_FLAGS;
    await tryRun(() =>
      handleProviderCreate(deps, {
        ...withoutApiKey,
        type: 'anthropic',
        apiKeyEnv: 'DEMO_API_KEY',
        providerDefaultModel: 'gpt-4.1',
        customHeader: ['x-tenant=acme'],
        env: ['FOO=bar'],
        protocol: 'anthropic',
        betaApi: true,
        json: true,
      }),
    );

    expect(exitCodes).toEqual([]);
    // No credential material leaves the process, inline or otherwise.
    expect(stdout.join('')).not.toContain('sk-');
    const parsed = JSON.parse(stdout.join('')) as {
      providers: Record<string, Record<string, unknown>>;
      models: Record<string, Record<string, unknown>>;
    };
    expect(parsed.providers['demo']?.['apiKey']).toBeUndefined();
    expect(parsed.providers['demo']?.['apiKeyEnv']).toBe('DEMO_API_KEY');
    expect(parsed.providers['demo']?.['defaultModel']).toBe('demo/gpt-4.1');
    expect(parsed.providers['demo']?.['customHeaders']).toEqual({ 'x-tenant': 'acme' });
    expect(parsed.providers['demo']?.['env']).toEqual({ FOO: 'bar' });
    expect(parsed.models['demo/gpt-4.1']).toMatchObject({
      protocol: 'anthropic',
      betaApi: true,
    });
  });

  it('exits 1 without writing when --type is not one of the six wire types', async () => {
    const { harness, current, setConfigCalls } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS, type: 'nope' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('openai_responses');
    expect(setConfigCalls).toEqual([]);
    expect(current().providers).toEqual({});
    expect(current().models).toBeUndefined();
  });

  it('exits 1 without writing when --model is missing', async () => {
    const { harness, current, setConfigCalls } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    const { model: _omitted, ...withoutModel } = CREATE_FLAGS;
    await tryRun(() => handleProviderCreate(deps, withoutModel));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('At least one model is required.');
    expect(setConfigCalls).toEqual([]);
    expect(current().providers).toEqual({});
  });

  it('exits 1 without writing when --max-context-size is missing', async () => {
    const { harness, current, setConfigCalls } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    const { maxContextSize: _omitted, ...withoutContext } = CREATE_FLAGS;
    await tryRun(() => handleProviderCreate(deps, withoutContext));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Context size is required.');
    expect(setConfigCalls).toEqual([]);
    expect(current().providers).toEqual({});
  });

  it('exits 1 without writing on a context size the shared rules reject', async () => {
    const { harness, setConfigCalls } = makeHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS, maxContextSize: '0' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Context size must be a positive integer.');
    expect(setConfigCalls).toEqual([]);
  });

  it('refuses an id that already exists instead of merging over it', async () => {
    const { harness, current, setConfigCalls } = makeHarness(makeRenameInitial());
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderCreate(deps, { ...CREATE_FLAGS }));

    expect(exitCodes).toEqual([1]);
    const err = stderr.join('');
    expect(err).toContain(t('tui.dialogs.providerForm.error.idTaken'));
    expect(err).toContain('demo');
    expect(setConfigCalls).toEqual([]);
    // The stored provider keeps every field the flags would have overwritten.
    expect(current().providers['demo']?.['apiKey']).toBe('sk-x');
    expect(current().providers['demo']?.['baseUrl']).toBe('https://api.example.com/v1');
    expect(current().providers['demo']?.['customHeaders']).toEqual({ 'x-tenant': 'acme' });
    expect(current().models?.['demo/gpt-4.1']?.['maxOutputSize']).toBe(8192);
  });
});

describe('kimi provider update', () => {
  it('renames under a temporary home: old key gone, alias prefix migrated, fields kept', async () => {
    const { harness, current } = await makeRegistryHarness(makeRenameInitial());
    const { deps, stdout, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', {
        newId: 'demo2',
        baseUrl: 'https://api2.example.com/v1',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    const config = await current();
    expect(config.providers['demo']).toBeUndefined();
    expect(config.providers['demo2']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://api2.example.com/v1',
      apiKey: 'sk-x',
      customHeaders: { 'x-tenant': 'acme' },
    });
    expect(config.models?.['demo/gpt-4.1']).toBeUndefined();
    expect(config.models?.['demo2/gpt-4.1']).toMatchObject({
      provider: 'demo2',
      model: 'gpt-4.1',
      maxContextSize: 128_000,
      displayName: 'GPT 4.1',
      capabilities: ['tool_use'],
      maxOutputSize: 8192,
      // The rename names no model row, so every row is written back from its
      // stored alias and the optional fields survive untouched.
      maxInputSize: 272_000,
      supportEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      offEffort: 'none',
      adaptiveThinking: true,
    });
    expect(config.models?.['other/claude']).toBeDefined();
    expect(config.providers['other']).toMatchObject({ type: 'anthropic' });
    expect(config.defaultModel).toBe('demo2/gpt-4.1');

    const toml = await readFile(join(harness.homeDir, 'config.toml'), 'utf8');
    expect(toml).not.toContain('"demo/gpt-4.1"');
    expect(toml).toContain('"demo2/gpt-4.1"');
    expect(stdout.join('')).toContain('Provider "demo2" updated.');
  });

  it('writes exactly the planEditWrite patch, after removing the old provider', async () => {
    const initial = makeRenameInitial();
    const { harness, current, setConfigCalls, removeCalls } = makeHarness(initial);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', {
        newId: 'demo2',
        baseUrl: 'https://api2.example.com/v1',
      }),
    );

    // Every optional field of the stored alias is carried into the row the
    // handler builds, and the stored API key into the value — repeating it
    // there is what lets a new `--api-key-env` meet the shared conflict rule.
    // This pins the prefill along with the patch.
    const expectedValue: ProviderFormValue = {
      id: 'demo2',
      type: 'openai',
      apiKey: 'sk-x',
      baseUrl: 'https://api2.example.com/v1',
      models: [
        {
          model: 'gpt-4.1',
          maxContextSize: '128000',
          displayName: 'GPT 4.1',
          capabilities: ['tool_use'],
          maxInputSize: '272000',
          maxOutputSize: '8192',
          supportEfforts: 'low, medium, high',
          defaultEffort: 'medium',
          offEffort: 'none',
          adaptiveThinking: true,
        },
      ],
    };
    const plan = planEditWrite(initial, expectedValue, 'demo');
    expect(plan.providerIdTaken).toBe(false);
    expect(plan.collisions).toEqual([]);
    // Assigning the value the spread already carried leaves the provider record
    // exactly as a blank `--api-key` used to leave it.
    expect(plan.patch.providers?.['demo2']?.apiKey).toBe('sk-x');
    expect(exitCodes).toEqual([]);
    expect(removeCalls).toEqual(['demo']);
    expect(setConfigCalls).toEqual([plan.patch]);
    expect(current().providers['demo2']?.['apiKey']).toBe('sk-x');
    expect(current().models?.['demo2/gpt-4.1']).toBeDefined();
    expect(current().defaultProvider).toBe('demo2');
  });

  it('lands the rename as one atomic section replace when the host can', async () => {
    const { harness, current, setConfigCalls, removeCalls, sectionCalls } = makeHarness(
      makeRenameInitial(),
      { atomicSections: true },
    );
    const { deps, stdout, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', {
        newId: 'demo2',
        baseUrl: 'https://api2.example.com/v1',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    // One write, and neither half of the two-call pairing — a process exit can
    // no longer land between the removal and the record that replaces it.
    expect(sectionCalls).toHaveLength(1);
    expect(removeCalls).toEqual([]);
    expect(setConfigCalls).toEqual([]);

    const config = current();
    expect(config.providers['demo']).toBeUndefined();
    expect(config.providers['demo2']).toMatchObject({
      type: 'openai',
      baseUrl: 'https://api2.example.com/v1',
      apiKey: 'sk-x',
      customHeaders: { 'x-tenant': 'acme' },
    });
    expect(config.models?.['demo/gpt-4.1']).toBeUndefined();
    expect(config.models?.['demo2/gpt-4.1']).toBeDefined();
    // Another provider's aliases and the renamed default pointer survive the
    // wholesale section replace.
    expect(config.models?.['other/claude']).toBeDefined();
    expect(config.defaultModel).toBe('demo2/gpt-4.1');
    expect(stdout.join('')).toContain('"demo2"');
  });

  it('lands the same config whichever write shape the host takes', async () => {
    const run = async (atomicSections: boolean) => {
      const { harness, current } = makeHarness(makeRenameInitial(), { atomicSections });
      const { deps } = makeDeps(harness);
      await tryRun(() =>
        handleProviderUpdate(deps, 'demo', {
          newId: 'demo2',
          baseUrl: 'https://api2.example.com/v1',
        }),
      );
      return current();
    };

    // The split changes how many writes land, never what the file ends up
    // saying. Both shapes start from the same config so any drift fails here
    // rather than on a user's machine mid-write.
    expect(await run(true)).toEqual(await run(false));
  });

  it('keeps the stored api key when --api-key is omitted and replaces it when given', async () => {
    const { harness, current } = makeHarness(makeRenameInitial());
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', { baseUrl: 'https://api3.example.com/v1' }),
    );
    expect(exitCodes).toEqual([]);
    expect(current().providers['demo']?.['apiKey']).toBe('sk-x');
    expect(current().providers['demo']?.['baseUrl']).toBe('https://api3.example.com/v1');
    // The fake merges `providers`/`models` by key the way the engine does, so a
    // patch naming this provider leaves the other provider's records where they
    // were — the same guarantee the temporary-home rename case above asserts
    // against the real harness.
    expect(current().models?.['demo/gpt-4.1']).toBeDefined();
    expect(current().models?.['other/claude']).toBeDefined();
    expect(current().providers['other']).toBeDefined();

    await tryRun(() => handleProviderUpdate(deps, 'demo', { apiKey: 'sk-y' }));
    expect(current().providers['demo']?.['apiKey']).toBe('sk-y');
  });

  it("clears the stored api key when --api-key '' is passed", async () => {
    const { harness, current, setConfigCalls } = makeHarness(makeRenameInitial());
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderUpdate(deps, 'demo', { apiKey: '' }));

    expect(exitCodes).toEqual([]);
    expect(current().providers['demo']?.['apiKey']).toBe('');
    // Every field the flags do not name keeps its stored value.
    expect(current().providers['demo']?.['baseUrl']).toBe('https://api.example.com/v1');
    expect(current().providers['demo']?.['customHeaders']).toEqual({ 'x-tenant': 'acme' });
    expect(current().models?.['demo/gpt-4.1']?.['maxOutputSize']).toBe(8192);
    const patch = setConfigCalls.at(-1);
    expect(patch?.providers?.['demo']?.['apiKey']).toBe('');
  });

  it('refuses --api-key-env against a stored inline key unless --api-key blanks it', async () => {
    // The value repeats the STORED key, which is what makes the shared rules see
    // both credential sources. Without it the write would spread the stored key
    // back in beside the new env name and land the ambiguous record
    // `apiKeyConflict` exists to refuse.
    const { harness, current, setConfigCalls } = makeHarness(makeRenameInitial());
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderUpdate(deps, 'demo', { apiKeyEnv: 'DEMO_KEY' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain(t('tui.dialogs.providerForm.error.apiKeyConflict'));
    expect(setConfigCalls).toEqual([]);
    expect(hasKey(current().providers['demo'], 'apiKeyEnv')).toBe(false);
    expect(current().providers['demo']?.['apiKey']).toBe('sk-x');
  });

  it('switches to env auth when the same command blanks the stored key', async () => {
    // `--api-key ''` goes through the existing `clearApiKey` path, which writes
    // an explicitly EMPTY `apiKey` rather than deleting the key — so the record
    // ends up carrying `api_key = ""` beside `api_key_env`, not a missing key.
    const { harness, current, setConfigCalls } = makeHarness(makeRenameInitial());
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderUpdate(deps, 'demo', { apiKey: '', apiKeyEnv: 'DEMO_KEY' }));

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    expect(current().providers['demo']?.['apiKeyEnv']).toBe('DEMO_KEY');
    expect(current().providers['demo']?.['apiKey']).toBe('');
    expect(hasKey(current().providers['demo'] ?? {}, 'apiKey')).toBe(true);
    expect(setConfigCalls).toHaveLength(1);
  });

  it('upserts the --model row and keeps the rows it does not name', async () => {
    const { harness, current } = makeHarness(makeRenameInitial());
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', {
        model: 'gpt-4.2',
        maxContextSize: '64000',
        displayName: 'GPT 4.2',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().models?.['demo/gpt-4.2']).toMatchObject({
      provider: 'demo',
      model: 'gpt-4.2',
      maxContextSize: 64_000,
      displayName: 'GPT 4.2',
      capabilities: ['tool_use', 'thinking'],
    });
    // A brand-new model id has no stored alias to inherit from and no flag
    // named the optional fields, so nothing is written for them.
    expect(current().models?.['demo/gpt-4.2']?.adaptiveThinking).toBeUndefined();
    expect(current().models?.['demo/gpt-4.2']?.maxInputSize).toBeUndefined();
    // The row the command did not name keeps its own optional fields.
    expect(current().models?.['demo/gpt-4.1']).toMatchObject({
      displayName: 'GPT 4.1',
      maxInputSize: 272_000,
      supportEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      offEffort: 'none',
      adaptiveThinking: true,
    });
  });

  it('writes the optional fields the flags name on the upserted row', async () => {
    const { harness, current } = makeHarness(makeRenameInitial());
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', {
        model: 'gpt-4.2',
        maxContextSize: '64000',
        maxInputSize: '32000',
        maxOutputSize: '4000',
        capabilities: 'image_in,tool_use',
        supportEfforts: 'low,high',
        defaultEffort: 'high',
        offEffort: '',
        adaptiveThinking: true,
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().models?.['demo/gpt-4.2']).toMatchObject({
      maxInputSize: 32_000,
      maxOutputSize: 4000,
      capabilities: ['image_in', 'tool_use'],
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      adaptiveThinking: true,
    });
    // `--off-effort ''` asked for the key to be gone.
    expect(current().models?.['demo/gpt-4.2']?.offEffort).toBeUndefined();
  });

  it('inherits every stored optional field when --model names an existing row', async () => {
    const { harness, current } = makeHarness(makeRenameInitial());
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', { model: 'gpt-4.1', maxContextSize: '131072' }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().models?.['demo/gpt-4.1']).toMatchObject({
      maxContextSize: 131_072,
      displayName: 'GPT 4.1',
      capabilities: ['tool_use'],
      maxInputSize: 272_000,
      maxOutputSize: 8192,
      supportEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      offEffort: 'none',
      adaptiveThinking: true,
    });
  });

  it('clears the optional fields an explicitly blank flag names', async () => {
    const { harness, current } = makeHarness(makeRenameInitial());
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', {
        model: 'gpt-4.1',
        maxInputSize: '',
        maxOutputSize: '',
        capabilities: '',
        supportEfforts: '',
        defaultEffort: '',
        offEffort: '',
        // The deletion has its own flag: `--no-adaptive-thinking` writes the
        // explicit `false` the engine reads as the budget-effort ladder.
        clearAdaptiveThinking: true,
      }),
    );

    expect(exitCodes).toEqual([]);
    const alias = current().models?.['demo/gpt-4.1'];
    expect(alias?.maxInputSize).toBeUndefined();
    expect(alias?.maxOutputSize).toBeUndefined();
    expect(alias?.capabilities).toBeUndefined();
    expect(alias?.supportEfforts).toBeUndefined();
    expect(alias?.defaultEffort).toBeUndefined();
    expect(alias?.offEffort).toBeUndefined();
    expect(alias?.adaptiveThinking).toBeUndefined();
    // Fields no blank flag named keep their stored value.
    expect(alias?.maxContextSize).toBe(128_000);
    expect(alias?.displayName).toBe('GPT 4.1');
  });

  it('keeps the stored states a row cannot write back', async () => {
    // `capabilities = []`, `support_efforts = []` and an empty effort name are
    // each a state of their own, and the row leaves them out: presenting them
    // would flatten each one into a deletion on the next write. A stored
    // `adaptive_thinking = false` is the exception — a row writes that boolean
    // verbatim now — and it round-trips all the same.
    const initial: KimiConfig = {
      providers: {
        demo: { type: 'openai', apiKey: 'sk-x', baseUrl: 'https://api.example.com/v1' },
      },
      models: {
        'demo/gpt-4.1': {
          provider: 'demo',
          model: 'gpt-4.1',
          maxContextSize: 128_000,
          displayName: 'GPT 4.1',
          capabilities: [],
          maxInputSize: 272_000,
          supportEfforts: [],
          defaultEffort: '',
          offEffort: '',
          adaptiveThinking: false,
        },
      },
      defaultModel: 'demo/gpt-4.1',
    } as unknown as KimiConfig;
    const { harness, current } = makeHarness(initial);
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderUpdate(deps, 'demo', { newId: 'demo2' }));

    expect(exitCodes).toEqual([]);
    const alias = current().models?.['demo2/gpt-4.1'];
    expect(alias?.capabilities).toEqual([]);
    expect(alias?.supportEfforts).toEqual([]);
    expect(alias?.defaultEffort).toBe('');
    expect(alias?.offEffort).toBe('');
    expect(alias?.adaptiveThinking).toBe(false);
    // The fields whose stored value a row can carry still round-trip.
    expect(alias?.maxInputSize).toBe(272_000);
  });

  /**
   * A provider whose stored alias declares every per-model override the flags
   * can name, plus the two provider-level text records and an env credential.
   */
  function makeOverrideInitial(): KimiConfig {
    return {
      providers: {
        demo: {
          type: 'anthropic',
          apiKeyEnv: 'DEMO_API_KEY',
          baseUrl: 'https://api.example.com',
          customHeaders: { 'x-tenant': 'acme' },
          env: { FOO: 'bar' },
        },
      },
      models: {
        'demo/claude-x': {
          provider: 'demo',
          model: 'claude-x',
          maxContextSize: 200_000,
          protocol: 'anthropic',
          betaApi: true,
          reasoningKey: 'reasoning_content',
          baseUrl: 'https://api.example.com/beta',
          adaptiveThinking: true,
          overrides: { supportEfforts: ['low', 'high'] },
        },
        // A second row with overrides of its own, so `--clear-overrides` can be
        // shown to be row-scoped.
        'demo/claude-y': {
          provider: 'demo',
          model: 'claude-y',
          maxContextSize: 100_000,
          overrides: { maxInputSize: 4096 },
        },
      },
    } as unknown as KimiConfig;
  }

  it('writes the per-model overrides the flags name and drops the one --protocol none names', async () => {
    const { harness, current } = makeHarness(makeOverrideInitial());
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', {
        model: 'claude-x',
        protocol: 'openai_responses',
        reasoningKey: 'reasoning',
        modelBaseUrl: 'https://api.example.com/responses',
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().models?.['demo/claude-x']).toMatchObject({
      protocol: 'openai_responses',
      reasoningKey: 'reasoning',
      baseUrl: 'https://api.example.com/responses',
      // A field no flag named keeps the stored declaration.
      betaApi: true,
    });

    // `none` drops the stored override, so the alias is rebuilt from the
    // provider's type.
    await tryRun(() => handleProviderUpdate(deps, 'demo', { model: 'claude-x', protocol: 'none' }));
    expect(hasKey(current().models?.['demo/claude-x'], 'protocol')).toBe(false);

    // Blank clears the two plain strings.
    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', {
        model: 'claude-x',
        reasoningKey: '',
        modelBaseUrl: '',
      }),
    );
    expect(exitCodes).toEqual([]);
    expect(hasKey(current().models?.['demo/claude-x'], 'reasoningKey')).toBe(false);
    expect(hasKey(current().models?.['demo/claude-x'], 'baseUrl')).toBe(false);

    // A per-model endpoint has to be one, or the transport cannot open it.
    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', { model: 'claude-x', modelBaseUrl: 'api.example.com' }),
    );
    expect(stderr.join('')).toContain(t('tui.dialogs.providerForm.error.modelBaseUrlInvalid'));
  });

  it('keeps, writes and deletes the beta_api toggle', async () => {
    const { harness, current } = makeHarness(makeOverrideInitial());
    const { deps, exitCodes } = makeDeps(harness);

    // Absent keeps the stored `true`.
    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', { model: 'claude-x', maxContextSize: '100000' }),
    );
    expect(current().models?.['demo/claude-x']?.betaApi).toBe(true);

    // `--no-beta-api` writes the explicit `false` and keeps the key.
    await tryRun(() => handleProviderUpdate(deps, 'demo', { model: 'claude-x', betaApi: false }));
    expect(current().models?.['demo/claude-x']?.betaApi).toBe(false);
    expect(hasKey(current().models?.['demo/claude-x'], 'betaApi')).toBe(true);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', { model: 'claude-x', clearBetaApi: true }),
    );
    expect(exitCodes).toEqual([]);
    expect(hasKey(current().models?.['demo/claude-x'], 'betaApi')).toBe(false);
  });

  it('writes --no-adaptive-thinking as false and --clear-adaptive-thinking as a deletion', async () => {
    const { harness, current } = makeHarness(makeOverrideInitial());
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', { model: 'claude-x', maxContextSize: '100000' }),
    );
    expect(current().models?.['demo/claude-x']?.adaptiveThinking).toBe(true);

    // The negated flag is a declaration of its own — `false` is the budget-effort
    // ladder — and writing it is what makes that state reachable from the CLI.
    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', { model: 'claude-x', adaptiveThinking: false }),
    );
    expect(current().models?.['demo/claude-x']?.adaptiveThinking).toBe(false);
    expect(hasKey(current().models?.['demo/claude-x'], 'adaptiveThinking')).toBe(true);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', { model: 'claude-x', clearAdaptiveThinking: true }),
    );
    expect(exitCodes).toEqual([]);
    expect(hasKey(current().models?.['demo/claude-x'], 'adaptiveThinking')).toBe(false);
  });

  it('lets a --clear-* flag win over the flag writing the same toggle', async () => {
    const { harness, current } = makeHarness(makeOverrideInitial());
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', {
        model: 'claude-x',
        adaptiveThinking: true,
        clearAdaptiveThinking: true,
        betaApi: true,
        clearBetaApi: true,
      }),
    );

    expect(exitCodes).toEqual([]);
    expect(hasKey(current().models?.['demo/claude-x'], 'adaptiveThinking')).toBe(false);
    expect(hasKey(current().models?.['demo/claude-x'], 'betaApi')).toBe(false);
  });

  it('deletes the stored overrides of the row --model names, and only that row', async () => {
    const { harness, current, setConfigCalls } = makeHarness(makeOverrideInitial());
    const { deps, stderr, exitCodes } = makeDeps(harness);

    expect(hasKey(current().models?.['demo/claude-x'], 'overrides')).toBe(true);
    expect(hasKey(current().models?.['demo/claude-y'], 'overrides')).toBe(true);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', { model: 'claude-x', clearOverrides: true }),
    );

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    // The shared write layer drops the key (`buildModelAlias`), so the engine
    // stops applying the stored `overrides` over the fields the row just wrote.
    expect(hasKey(current().models?.['demo/claude-x'], 'overrides')).toBe(false);
    expect(current().models?.['demo/claude-x']?.maxContextSize).toBe(200_000);
    // The row `--model` did not name keeps its overrides.
    expect(hasKey(current().models?.['demo/claude-y'], 'overrides')).toBe(true);
    expect(current().models?.['demo/claude-y']?.overrides).toEqual({ maxInputSize: 4096 });

    // It is a model-row flag: without `--model` it names no row.
    await tryRun(() => handleProviderUpdate(deps, 'demo', { clearOverrides: true }));
    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain(t('cli.optionDescriptions.providerCreateModel'));
    expect(setConfigCalls).toHaveLength(1);
  });

  it('keeps, replaces and clears the provider-level records the flags name', async () => {
    const { harness, current } = makeHarness(makeOverrideInitial());
    const { deps, exitCodes } = makeDeps(harness);

    // Omitted flags keep everything, including the env credential.
    await tryRun(() => handleProviderUpdate(deps, 'demo', { baseUrl: 'https://api2.example.com' }));
    expect(exitCodes).toEqual([]);
    expect(current().providers['demo']).toMatchObject({
      apiKeyEnv: 'DEMO_API_KEY',
      customHeaders: { 'x-tenant': 'acme' },
      env: { FOO: 'bar' },
    });

    // The repeatable flags replace the whole record, in the order typed.
    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', {
        apiKeyEnv: 'OTHER_KEY',
        customHeader: ['x-src=cli', 'x-mode=test'],
        env: ['BAZ=qux'],
      }),
    );
    expect(current().providers['demo']).toMatchObject({
      apiKeyEnv: 'OTHER_KEY',
      customHeaders: { 'x-src': 'cli', 'x-mode': 'test' },
      env: { BAZ: 'qux' },
    });

    // `--clear-*` empties a record, and an explicit blank drops the env name.
    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', {
        apiKeyEnv: '',
        clearCustomHeaders: true,
        clearEnv: true,
      }),
    );
    expect(exitCodes).toEqual([]);
    expect(hasKey(current().providers['demo'], 'apiKeyEnv')).toBe(false);
    expect(hasKey(current().providers['demo'], 'customHeaders')).toBe(false);
    expect(hasKey(current().providers['demo'], 'env')).toBe(false);
  });

  it('writes, keeps and clears the provider-level default pointer', async () => {
    const { harness, current } = makeHarness(makeOverrideInitial());
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderUpdate(deps, 'demo', { providerDefaultModel: 'claude-x' }));
    expect(exitCodes).toEqual([]);
    expect(current().providers['demo']?.defaultModel).toBe('demo/claude-x');

    // An unrelated provider-level edit keeps the pointer.
    await tryRun(() => handleProviderUpdate(deps, 'demo', { baseUrl: 'https://api2.example.com' }));
    expect(current().providers['demo']?.defaultModel).toBe('demo/claude-x');

    // An explicit blank drops it.
    await tryRun(() => handleProviderUpdate(deps, 'demo', { providerDefaultModel: '' }));
    expect(hasKey(current().providers['demo'], 'defaultModel')).toBe(false);

    // A pointer naming no row of this provider is refused, so no edit can leave
    // one nothing resolves behind.
    await tryRun(() => handleProviderUpdate(deps, 'demo', { providerDefaultModel: 'nope' }));
    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain(t('tui.dialogs.providerForm.error.defaultModelUnknown'));
  });

  it('refuses a model-row flag that names no model', async () => {
    const { harness, current, setConfigCalls, removeCalls } = makeHarness(makeRenameInitial());
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderUpdate(deps, 'demo', { capabilities: 'tool_use' }));
    await tryRun(() => handleProviderUpdate(deps, 'demo', { displayName: 'Renamed' }));
    await tryRun(() => handleProviderUpdate(deps, 'demo', { protocol: 'anthropic' }));
    await tryRun(() => handleProviderUpdate(deps, 'demo', { clearOverrides: true }));

    expect(exitCodes).toEqual([1, 1, 1, 1]);
    expect(stderr.join('')).toContain(t('cli.optionDescriptions.providerCreateModel'));
    expect(setConfigCalls).toEqual([]);
    expect(removeCalls).toEqual([]);
    expect(current().models?.['demo/gpt-4.1']?.['displayName']).toBe('GPT 4.1');
  });

  it('points default_model at the renamed alias when --default is passed', async () => {
    const { harness, current } = makeHarness(makeRenameInitial());
    const { deps, exitCodes } = makeDeps(harness);

    await tryRun(() =>
      handleProviderUpdate(deps, 'demo', { newId: 'demo2', default: true, model: 'gpt-4.1' }),
    );

    expect(exitCodes).toEqual([]);
    expect(current().defaultModel).toBe('demo2/gpt-4.1');
  });

  it('emits a parseable, sanitized config over --json', async () => {
    const { harness } = makeHarness(makeRenameInitial());
    const { deps, stdout, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderUpdate(deps, 'demo', { newId: 'demo2', json: true }));

    expect(exitCodes).toEqual([]);
    expect(stdout.join('')).not.toContain('sk-x');
    const parsed = JSON.parse(stdout.join('')) as {
      providers: Record<string, Record<string, unknown>>;
      models: Record<string, unknown>;
    };
    expect(parsed.providers['demo']).toBeUndefined();
    expect(parsed.providers['demo2']?.['apiKey']).toBeUndefined();
    expect(Object.keys(parsed.models)).toContain('demo2/gpt-4.1');
  });

  it('exits 1 without writing when the provider does not exist', async () => {
    const { harness, setConfigCalls, removeCalls } = makeHarness(makeRenameInitial());
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderUpdate(deps, 'nope', { baseUrl: 'https://x.example.com' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Provider "nope" not found.');
    expect(setConfigCalls).toEqual([]);
    expect(removeCalls).toEqual([]);
  });

  it('refuses a rename onto a provider id another provider uses', async () => {
    const { harness, current, setConfigCalls, removeCalls } = makeHarness(makeRenameInitial());
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderUpdate(deps, 'demo', { newId: 'other' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain(t('tui.dialogs.providerForm.error.idTaken'));
    expect(stderr.join('')).toContain('other');
    expect(setConfigCalls).toEqual([]);
    expect(removeCalls).toEqual([]);
    expect(current().providers['demo']).toBeDefined();
    expect(current().providers['other']).toBeDefined();
  });

  it('refuses a rename onto an alias another provider owns', async () => {
    const initial = makeRenameInitial();
    initial.models = {
      ...initial.models,
      'demo2/gpt-4.1': { provider: 'other', model: 'gpt-4.1', maxContextSize: 4096 },
    };
    const { harness, current, setConfigCalls, removeCalls } = makeHarness(initial);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderUpdate(deps, 'demo', { newId: 'demo2' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain(t('tui.dialogs.providerForm.error.aliasConflict'));
    expect(stderr.join('')).toContain('demo2/gpt-4.1');
    expect(setConfigCalls).toEqual([]);
    expect(removeCalls).toEqual([]);
    expect(current().providers['demo']).toBeDefined();
    expect(current().models?.['demo2/gpt-4.1']?.['provider']).toBe('other');
  });

  it('exits 1 without writing when a new model row has no usable context size', async () => {
    const { harness, setConfigCalls, removeCalls } = makeHarness(makeRenameInitial());
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleProviderUpdate(deps, 'demo', { model: 'gpt-4.2' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Context size is required.');
    expect(setConfigCalls).toEqual([]);
    expect(removeCalls).toEqual([]);
  });
});

describe('kimi provider create/update routing', () => {
  it('registers both subcommands and routes their flags through commander', async () => {
    const { harness, current } = await makeRegistryHarness({ providers: {} } as KimiConfig);
    const { deps, stdout, stderr, exitCodes } = makeDeps(harness);

    const program = new Command('kimi');
    registerProviderCommand(program, deps);
    const providerCmd = program.commands.find((command) => command.name() === 'provider');
    expect(providerCmd?.commands.map((command) => command.name()).toSorted()).toEqual([
      'add',
      'catalog',
      'create',
      'list',
      'remove',
      'update',
    ]);

    await tryRun(() =>
      program.parseAsync(
        [
          'node',
          'kimi',
          'provider',
          'create',
          '--id',
          'demo',
          '--type',
          'openai',
          '--api-key',
          'sk-x',
          '--base-url',
          'https://api.example.com/v1',
          '--model',
          'gpt-4.1',
          '--max-context-size',
          '128000',
          '--max-input-size',
          '64000',
          '--capabilities',
          'tool_use,image_in',
          '--adaptive-thinking',
          '--provider-default-model',
          'gpt-4.1',
          '--custom-header',
          'x-tenant=acme',
          '--env',
          'FOO=bar',
        ],
        { from: 'node' },
      ),
    );

    expect(exitCodes).toEqual([]);
    expect((await current()).providers['demo']).toMatchObject({
      defaultModel: 'demo/gpt-4.1',
      customHeaders: { 'x-tenant': 'acme' },
      env: { FOO: 'bar' },
    });
    expect((await current()).models?.['demo/gpt-4.1']).toMatchObject({
      maxInputSize: 64_000,
      capabilities: ['tool_use', 'image_in'],
      adaptiveThinking: true,
    });
    expect(stdout.join('')).toContain('Provider "demo" added.');

    // This parse runs on the SAME Command: a repeatable option's default is the
    // very same array instance every time, so routing a second `k=v` record
    // through it pins that one parse's entries cannot accumulate into the next.
    await tryRun(() =>
      program.parseAsync(
        [
          'node',
          'kimi',
          'provider',
          'update',
          'demo',
          '--new-id',
          'demo2',
          '--model',
          'gpt-4.1',
          '--max-output-size',
          '8000',
          // `--no-adaptive-thinking` writes the explicit `false`; dropping the
          // key is what `--clear-adaptive-thinking` is for.
          '--no-adaptive-thinking',
          '--custom-header',
          'x-src=cli',
          '--clear-env',
        ],
        { from: 'node' },
      ),
    );

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    const config = await current();
    expect(config.providers['demo']).toBeUndefined();
    expect(config.providers['demo2']).toBeDefined();
    expect(Object.keys(config.models ?? {})).toEqual(['demo2/gpt-4.1']);
    expect(config.models?.['demo2/gpt-4.1']).toMatchObject({
      maxInputSize: 64_000,
      maxOutputSize: 8000,
      capabilities: ['tool_use', 'image_in'],
      adaptiveThinking: false,
    });
    // The header map holds this parse's entry only, and `--clear-env` dropped
    // the record the create parse wrote. Neither flag touched the default
    // pointer, which followed the rename instead.
    expect(config.providers['demo2']?.customHeaders).toEqual({ 'x-src': 'cli' });
    expect(hasKey(config.providers['demo2'], 'env')).toBe(false);
    expect(config.providers['demo2']?.defaultModel).toBe('demo2/gpt-4.1');
    expect(stdout.join('')).toContain('Provider "demo2" updated.');

    // The remaining attribute names, plus the per-model protocol that makes
    // `--beta-api` legal on this openai-typed provider.
    await tryRun(() =>
      program.parseAsync(
        [
          'node',
          'kimi',
          'provider',
          'update',
          'demo2',
          '--model',
          'gpt-4.1',
          '--protocol',
          'anthropic',
          '--beta-api',
          '--reasoning-key',
          'reasoning_content',
          '--model-base-url',
          'https://api.example.com/anthropic',
          '--clear-adaptive-thinking',
        ],
        { from: 'node' },
      ),
    );

    expect(exitCodes).toEqual([]);
    expect(stderr.join('')).toBe('');
    const overridden = (await current()).models?.['demo2/gpt-4.1'];
    expect(overridden).toMatchObject({
      protocol: 'anthropic',
      betaApi: true,
      reasoningKey: 'reasoning_content',
      baseUrl: 'https://api.example.com/anthropic',
    });
    expect(hasKey(overridden, 'adaptiveThinking')).toBe(false);
  });

  it('exits 1 through commander on an unknown --type and writes nothing', async () => {
    const { harness, current } = await makeRegistryHarness({ providers: {} } as KimiConfig);
    const { deps, stderr, exitCodes } = makeDeps(harness);

    const program = new Command('kimi');
    registerProviderCommand(program, deps);

    await tryRun(() =>
      program.parseAsync(
        [
          'node',
          'kimi',
          'provider',
          'create',
          '--id',
          'demo',
          '--type',
          'nope',
          '--api-key',
          'sk-x',
          '--base-url',
          'https://api.example.com/v1',
          '--model',
          'gpt-4.1',
          '--max-context-size',
          '128000',
        ],
        { from: 'node' },
      ),
    );

    // The injected `exit` throws so the test can continue; `runAction`'s
    // boundary then reports the same failure once more. Production
    // `process.exit` never returns, so the user sees one message and one code.
    expect(exitCodes).toEqual([1, 1]);
    expect(stderr.join('')).toContain('openai_responses');
    expect((await current()).providers).toEqual({});
  });
});
