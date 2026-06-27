/**
 * Tests for the API-layer latency optimizations in `anthropic.ts`:
 *
 * 1. `cacheControlTtl` option is accepted on the provider and threaded
 *    into the wire bytes for the system prompt, last message block,
 *    and last tool breakpoint.
 * 2. The converted `AnthropicToolParam[]` is memoized across calls so
 *    the Anthropic tools prefix stays byte-identical, preserving the
 *    server-side prompt cache.
 */

import { AnthropicChatProvider } from '#/providers/anthropic';
import type { Tool } from '#/tool';
import { describe, expect, it } from 'vitest';

const SHARED_TOOLS: Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file from the local filesystem.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List a directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
];

function createProvider(ttl?: 'ephemeral' | '5m' | '1h'): AnthropicChatProvider {
  return new AnthropicChatProvider({
    model: 'k25',
    apiKey: 'test-key',
    defaultMaxTokens: 1024,
    stream: false,
    cacheControlTtl: ttl,
  });
}

// Reach into private fields. `as unknown as` keeps the test
// independent of refactors that rename the field.
function toolsCache(provider: AnthropicChatProvider): {
  fingerprint: string;
  tools: unknown[];
} | null {
  return (provider as unknown as { _toolsCache: { fingerprint: string; tools: unknown[] } | null })
    ._toolsCache;
}

function cacheTtl(provider: AnthropicChatProvider): string {
  return (provider as unknown as { _cacheControlTtl: string })._cacheControlTtl;
}

describe('AnthropicChatProvider cacheControlTtl option', () => {
  it('defaults to ephemeral when the option is omitted', () => {
    const provider = new AnthropicChatProvider({
      model: 'k25',
      apiKey: 'test-key',
      defaultMaxTokens: 1024,
      stream: false,
    });
    expect(cacheTtl(provider)).toBe('ephemeral');
  });

  it('accepts the 5m ttl hint', () => {
    expect(cacheTtl(createProvider('5m'))).toBe('5m');
  });

  it('accepts the 1h ttl hint', () => {
    expect(cacheTtl(createProvider('1h'))).toBe('1h');
  });
});

describe('AnthropicChatProvider tool array memoization', () => {
  it('starts empty before any call', () => {
    expect(toolsCache(createProvider())).toBeNull();
  });

  it('produces a stable fingerprint regardless of input order', () => {
    const provider = createProvider();
    // Same tool set, different registration order — should hash to the
    // same fingerprint and reuse the cached wire array.
    const swapped: Tool[] = [SHARED_TOOLS[1]!, SHARED_TOOLS[0]!];

    type WithBuilder = AnthropicChatProvider & {
      _getOrBuildToolsParam: (tools: readonly Tool[]) => unknown[];
    };
    const builder = (provider as unknown as WithBuilder)._getOrBuildToolsParam.bind(provider);

    builder(SHARED_TOOLS);
    const firstFingerprint = toolsCache(provider)?.fingerprint;

    // Reset only the cache (not the provider) to simulate a second
    // call with the same tools but in a different order.
    (provider as unknown as { _toolsCache: null })._toolsCache = null;
    builder(swapped);
    const swappedFingerprint = toolsCache(provider)?.fingerprint;

    expect(firstFingerprint).toBe(swappedFingerprint);
    expect(firstFingerprint).not.toBe('[]');
  });

  it('reuses the same AnthropicToolParam[] reference across calls', () => {
    const provider = createProvider();

    // Bind the private method to the provider so `this` resolves
    // correctly inside `_getOrBuildToolsParam`. Without `bind`,
    // extracting the method would leave `this === undefined` and
    // the cache lookup would crash.
    type WithBuilder = AnthropicChatProvider & {
      _getOrBuildToolsParam: (tools: readonly Tool[]) => unknown[];
    };
    const withBuilder = provider as unknown as WithBuilder;
    const builder = withBuilder._getOrBuildToolsParam.bind(provider);

    builder(SHARED_TOOLS);
    const firstTools = toolsCache(provider)?.tools;

    builder(SHARED_TOOLS);
    const secondTools = toolsCache(provider)?.tools;

    expect(secondTools).toBe(firstTools);
  });

  it('drops the cache when the tool set changes', () => {
    const provider = createProvider();

    const extraTool: Tool = {
      name: 'write_file',
      description: 'Write a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    };

    type WithBuilder = AnthropicChatProvider & {
      _getOrBuildToolsParam: (tools: readonly Tool[]) => unknown[];
    };
    const builder = (provider as unknown as WithBuilder)._getOrBuildToolsParam.bind(provider);

    builder(SHARED_TOOLS);
    const fpBefore = toolsCache(provider)?.fingerprint;

    builder([...SHARED_TOOLS, extraTool]);
    const fpAfter = toolsCache(provider)?.fingerprint;

    expect(fpAfter).not.toBe(fpBefore);
  });

  it('stamps cache_control on the last tool when tools are present', () => {
    const provider = createProvider('ephemeral');

    type WithBuilder = AnthropicChatProvider & {
      _getOrBuildToolsParam: (tools: readonly Tool[]) => { cache_control?: { type: string } }[];
    };
    const builder = (provider as unknown as WithBuilder)._getOrBuildToolsParam.bind(provider);
    const result = builder(SHARED_TOOLS);

    const lastTool = result[result.length - 1]!;
    expect(lastTool.cache_control).toBeDefined();
    expect(lastTool.cache_control?.type).toBe('ephemeral');
  });

  it('does not stamp cache_control when no tools are present', () => {
    const provider = createProvider();

    type WithBuilder = AnthropicChatProvider & {
      _getOrBuildToolsParam: (tools: readonly Tool[]) => unknown[];
    };
    const builder = (provider as unknown as WithBuilder)._getOrBuildToolsParam.bind(provider);
    const result = builder([]);

    expect(result).toEqual([]);
  });
});
