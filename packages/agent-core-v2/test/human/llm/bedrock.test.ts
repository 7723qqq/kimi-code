import { describe, expect, it } from 'bun:test';

import { UNKNOWN_CAPABILITY } from '#human/llm/capability';
import { createBedrockAnthropicClient } from '#human/llm/provider/bedrock/anthropic';
import { createBedrockTokenProvider } from '#human/llm/provider/bedrock/credentials';
import {
  bedrockModelCapability,
  inferBedrockProtocol,
  resolveBedrockBaseUrl,
  stripBedrockInferenceProfilePrefix,
} from '#human/llm/provider/bedrock/routing';
import { getAnthropicModelCapability } from '#human/llm/requester/bases/anthropic/capability';

describe('Bedrock provider', () => {
  it('keeps token lifecycle, routing, and Anthropic authentication provider-local', async () => {
    expect(
      [
        'global.anthropic.claude-sonnet-4-6',
        'openai.gpt-oss-120b-1:0',
        'global.openai.gpt-6-astra',
        'global.moonshotai.kimi-k3',
        'meta.llama-4',
      ].map(inferBedrockProtocol),
    ).toEqual(['anthropic', 'openai', 'openai_responses', 'openai', undefined]);
    expect(stripBedrockInferenceProfilePrefix('apac.moonshotai.kimi-k3')).toBe(
      'moonshotai.kimi-k3',
    );
    expect(resolveBedrockBaseUrl('anthropic', { AWS_REGION: 'us-west-2' })).toBe(
      'https://bedrock-runtime.us-west-2.amazonaws.com/anthropic',
    );
    expect(resolveBedrockBaseUrl('openai', { AWS_DEFAULT_REGION: 'us-east-1' })).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1',
    );
    expect(bedrockModelCapability('global.anthropic.claude-sonnet-4-6')).toEqual(
      getAnthropicModelCapability('claude-sonnet-4-6'),
    );

    let now = 1_000_000;
    let calls = 0;
    let tokenConfig: unknown;
    const provider = createBedrockTokenProvider({
      region: 'us-west-2',
      profile: 'bedrock-test',
      now: () => now,
      createProvideToken: (config) => {
        tokenConfig = config;
        return async () => {
          calls += 1;
          return `bedrock-api-key-${calls}`;
        };
      },
    });
    const [first, concurrent] = await Promise.all([provider.resolve(), provider.resolve()]);
    expect(first).toEqual({ apiKey: 'bedrock-api-key-1' });
    expect(concurrent).toEqual(first);
    expect(calls).toBe(1);
    expect(tokenConfig).toEqual({
      region: 'us-west-2',
      profile: 'bedrock-test',
      expiresInSeconds: undefined,
    });
    now += 12 * 60 * 60 * 1000;
    await expect(provider.resolve()).resolves.toEqual({ apiKey: 'bedrock-api-key-2' });
    expect(provider.canRecover?.({ status: 401 })).toBe(true);
    expect(provider.canRecover?.({ status: 500 })).toBe(false);
    provider.invalidate?.();
    await expect(provider.resolve()).resolves.toEqual({ apiKey: 'bedrock-api-key-3' });
    expect(calls).toBe(3);

    let unavailable = true;
    const recovering = createBedrockTokenProvider({
      createProvideToken: () => async () => {
        if (unavailable) throw new Error('run aws sso login');
        return 'bedrock-api-key-recovered';
      },
    });
    await expect(recovering.resolve()).rejects.toThrow('run aws sso login');
    unavailable = false;
    await expect(recovering.resolve()).resolves.toEqual({
      apiKey: 'bedrock-api-key-recovered',
    });

    const requests: RequestInit[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'PONG' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const bedrock = createBedrockAnthropicClient({
        model: {
          provider: 'bedrock',
          model: 'claude-test',
          capability: UNKNOWN_CAPABILITY,
          apiKey: 'bedrock-api-key-transport',
          baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com/anthropic',
        },
      });
      await bedrock.messages.create({
        model: 'claude-test',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Reply with PONG' }],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const headers = new Headers(requests[0]?.headers);
    expect(headers.get('authorization')).toBe('Bearer bedrock-api-key-transport');
    expect(headers.get('x-api-key')).toBeNull();
  });
});
