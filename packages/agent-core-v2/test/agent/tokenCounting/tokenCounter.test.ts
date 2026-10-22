import { expect, expectTypeOf, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe } from 'bun:test';

import {
  asyncTierCandidate,
  createAsyncTokenCounter,
  createHttpTokenCounter,
  createSidecarTokenCounter,
  createTokenCounter,
  createWasmTokenCounter,
  HEURISTIC_TOKEN_COUNTER,
  TokenCounterUnavailableError,
} from '#/agent/tokenCounting/tokenCounter';
import { estimateTokens } from '#/llm-adapter/contract/tokens';
import { prepareOpenAIRequest } from '#human/llm/requester/bases/openai/requester';

const EXPECTED_DEPENDENCIES = [
  '@antfu/utils',
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@google/genai',
  '@jsquash/webp',
  '@modelcontextprotocol/sdk',
  '@moonshot-ai/kimi-code-oauth',
  '@moonshot-ai/kimi-i18n',
  '@moonshot-ai/minidb',
  '@moonshot-ai/tree-sitter-bash',
  '@mozilla/readability',
  'ajv',
  'ajv-formats',
  'chokidar',
  'ignore',
  'immer',
  'jimp',
  'js-yaml',
  'linkedom',
  'openai',
  'pathe',
  'picomatch',
  'radashi',
  'retry',
  'semver',
  'smol-toml',
  'socks',
  'tar',
  'ulid',
  'undici',
  'xstate',
  'yauzl',
  'yazl',
  'zod',
];

describe('token counter fallback chain', () => {
  it('defaults to the heuristic counter, which is the estimator itself', () => {
    expect(HEURISTIC_TOKEN_COUNTER.count).toBe(estimateTokens);
    expect(createTokenCounter([]).source).toBe('heuristic');
  });

  it('accepts a wasm backend and reports its source', () => {
    const counter = createTokenCounter([
      {
        source: 'wasm',
        create: () =>
          createWasmTokenCounter(() => ({
            encode: (text) => Array.from({ length: text.length * 2 }, (_value, index) => index),
          })),
      },
    ]);
    expect(counter.source).toBe('wasm');
    expect(counter.count('abc')).toBe(6);
  });

  it('degrades to the heuristic when a backend fails to construct', () => {
    const counter = createTokenCounter([
      {
        source: 'wasm',
        create: () => {
          throw new Error('wasm binary missing');
        },
      },
    ]);
    expect(counter.source).toBe('heuristic');
    expect(counter.count('abc')).toBe(estimateTokens('abc'));
  });

  it('rejects a backend that counts nothing', () => {
    const counter = createTokenCounter([
      { source: 'wasm', create: () => ({ source: 'wasm', count: () => 0 }) },
    ]);
    expect(counter.source).toBe('heuristic');
  });

  it('rejects a backend that counts negative', () => {
    const counter = createTokenCounter([
      { source: 'wasm', create: () => ({ source: 'wasm', count: () => -1 }) },
    ]);
    expect(counter.source).toBe('heuristic');
  });
});

describe('async token counter tier', () => {
  it('refuses to run on the synchronous request path', () => {
    const candidate = asyncTierCandidate('sidecar', { countAsync: async () => 1 });
    expect(() => candidate.create()).toThrow(TokenCounterUnavailableError);
    expect(
      createTokenCounter([asyncTierCandidate('http', { countAsync: async () => 1 })]).source,
    ).toBe('heuristic');
  });

  it('still works offline through its async interface', async () => {
    const counter = createAsyncTokenCounter('http', { countAsync: async () => 7 });
    expect(counter.source).toBe('http');
    expect(await counter.countAsync('anything')).toBe(7);
  });

  it('exposes sidecar and http skeletons over a shared transport', async () => {
    const transport = { request: async (text: string) => text.length * 3 };
    const sidecar = createSidecarTokenCounter(transport);
    const http = createHttpTokenCounter(transport);
    expect(sidecar.source).toBe('sidecar');
    expect(http.source).toBe('http');
    expect(await sidecar.countAsync('abcd')).toBe(12);
    expect(await http.countAsync('abcd')).toBe(12);
  });

  it('keeps every async backend out of the synchronous chain', () => {
    const chain = createTokenCounter([
      asyncTierCandidate('sidecar', { countAsync: async () => 3 }),
      asyncTierCandidate('http', { countAsync: async () => 3 }),
    ]);
    expect(chain.source).toBe('heuristic');
  });

  it('keeps the request path synchronous', () => {
    expectTypeOf(prepareOpenAIRequest).returns.not.toEqualTypeOf<Promise<unknown>>();
  });
});

describe('runtime dependencies', () => {
  it('adds no new runtime dependency', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(EXPECTED_DEPENDENCIES);
  });
});
