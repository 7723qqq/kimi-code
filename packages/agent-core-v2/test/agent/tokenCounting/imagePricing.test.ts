import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentProfileService } from '#/agent/profile/profile';
import { imagePricingForModel } from '#/llm-adapter/contract/modelFamily';
import { MEDIA_TOKEN_ESTIMATE } from '#/llm-adapter/contract/tokens';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';

import { createTestAgent, type TestAgentContext } from '../../harness';

type TestKimiConfig = {
  providers: Record<string, unknown>;
  models?: Record<string, Record<string, unknown>>;
};

const imageMessage = {
  role: 'user' as const,
  content: [{ type: 'image_url' as const, imageUrl: { url: 'data:image/png;base64,AAAA' } }],
  toolCalls: [],
};

function deepseekConfig(): TestKimiConfig {
  return {
    providers: {
      deepseek: {
        type: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://api.deepseek.test/v1',
      },
    },
    models: {
      ds: {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        maxContextSize: 1_000_000,
      },
    },
  };
}

function genericConfig(): TestKimiConfig {
  return {
    providers: {
      openai: {
        type: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://api.example.test/v1',
      },
    },
    models: {
      'some-alias': {
        provider: 'openai',
        model: 'gpt-4o',
        maxContextSize: 128_000,
      },
    },
  };
}

describe('family image pricing reaches the token counting service', () => {
  let ctx: TestAgentContext;
  let profile: IAgentProfileService;
  let tokenCounting: ISessionTokenCountingService;

  function boot(config: TestKimiConfig): void {
    ctx = createTestAgent({
      initialConfig: config as never,
    });
    profile = ctx.get(IAgentProfileService);
    tokenCounting = ctx.get(ISessionTokenCountingService);
  }

  afterEach(async () => {
    if (ctx !== undefined) await ctx.dispose();
  });

  it('exposes the wire name of the bound model', () => {
    boot(deepseekConfig());
    profile.update({ modelAlias: 'ds' });
    expect(profile.getModel()).toBe('ds');
    expect(profile.getModelWireName()).toBe('deepseek-v4-pro');
  });

  it('has no wire name when the bound model cannot be resolved', () => {
    boot(deepseekConfig());
    profile.update({ modelAlias: 'ghost/model' });
    expect(profile.getModelWireName()).toBeUndefined();
    expect(imagePricingForModel(profile.getModelWireName())).toBeUndefined();
  });

  it('prices deepseek image messages through the family pricing', () => {
    boot(deepseekConfig());
    profile.update({ modelAlias: 'ds' });
    const pricing = imagePricingForModel(profile.getModelWireName());
    expect(pricing).toBeDefined();
    expect(tokenCounting.estimateMessage(imageMessage, pricing)).toBe(
      tokenCounting.estimateText('user') + pricing!.fallbackTokens,
    );
  });

  it('keeps the fixed media estimate for a non-family model', () => {
    boot(genericConfig());
    profile.update({ modelAlias: 'some-alias' });
    const pricing = imagePricingForModel(profile.getModelWireName());
    expect(pricing).toBeUndefined();
    expect(tokenCounting.estimateMessage(imageMessage, pricing)).toBe(
      tokenCounting.estimateText('user') + MEDIA_TOKEN_ESTIMATE,
    );
  });

  it('prices message lists and request sizes consistently', () => {
    boot(deepseekConfig());
    profile.update({ modelAlias: 'ds' });
    const pricing = imagePricingForModel(profile.getModelWireName());
    const messages = [imageMessage, imageMessage];
    expect(tokenCounting.estimateMessages(messages, pricing)).toBe(
      tokenCounting.estimateMessage(imageMessage, pricing) * 2,
    );
    const withPricing = tokenCounting.requestSize(
      { systemPrompt: 'sys', tools: [], messages },
      pricing,
    );
    const withoutPricing = tokenCounting.requestSize(
      { systemPrompt: 'sys', tools: [], messages },
      undefined,
    );
    expect(withoutPricing - withPricing).toBe(2 * (MEDIA_TOKEN_ESTIMATE - pricing!.fallbackTokens));
  });
});
