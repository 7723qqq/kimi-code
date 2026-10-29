import { afterEach, describe, expect, it } from 'bun:test';

import { IAgentProfileService } from '#/agent/profile/profile';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';

import { createTestAgent, type TestAgentContext } from '../../harness';

function deepseekConfig(model: string): {
  providers: Record<string, unknown>;
  models: Record<string, Record<string, unknown>>;
} {
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
        model,
        maxContextSize: 1_000_000,
      },
    },
  };
}

describe('model adaptation lookup follows the wire name', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
  });

  it('embeds the deepseek adaptation in the global system prompt', async () => {
    ctx = createTestAgent({
      autoConfigure: false,
      initialConfig: deepseekConfig('deepseek-v4-pro') as never,
    });
    const profile = ctx.get(IAgentProfileService);

    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'ds' });

    expect(profile.getModelWireName()).toBe('deepseek-v4-pro');
    const prompt = profile.getSystemPrompt();
    expect(prompt).toContain('# Working contract');
    expect(prompt).toContain('# Model Adaptation: deepseek-v4-pro');
    expect(prompt).toContain('## Reasoning history');
    expect(prompt).toContain('## Token budget');
  });

  it('resolves the wire name and carries the adaptation for it', async () => {
    ctx = createTestAgent({
      autoConfigure: false,
      initialConfig: deepseekConfig('deepseek-v3') as never,
    });
    const profile = ctx.get(IAgentProfileService);

    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'ds' });

    expect(profile.getModel()).toBe('ds');
    expect(profile.getModelWireName()).toBe('deepseek-v3');
    expect(profile.getSystemPrompt()).toContain('# Model Adaptation: deepseek-v3');
  });

  it('injects nothing for a family with no curated guidance', async () => {
    ctx = createTestAgent({
      autoConfigure: false,
      initialConfig: deepseekConfig('gpt-4o') as never,
    });
    const profile = ctx.get(IAgentProfileService);

    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'ds' });

    expect(profile.getModelWireName()).toBe('gpt-4o');
    expect(profile.getSystemPrompt()).not.toContain('# Model Adaptation');
  });
});
