import { afterEach, describe, expect, it } from 'vitest';

import { IAgentProfileService } from '#/agent/profile/profile';
import { DEFAULT_AGENT_PROFILE_NAME } from '#/app/agentProfileCatalog/agentProfileCatalog';

import { createTestAgent, type TestAgentContext } from '../../harness';

const ENV_KEY = 'KIMI_MODEL_ADAPTATIONS';

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
  const originalEnv = process.env[ENV_KEY];

  afterEach(async () => {
    await ctx?.dispose();
    ctx = undefined;
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
  });

  it('keeps the deepseek system prompt minimal instead of embedding the adaptation', async () => {
    delete process.env[ENV_KEY];
    ctx = createTestAgent({
      autoConfigure: false,
      initialConfig: deepseekConfig('deepseek-v4-pro') as never,
    });
    const profile = ctx.get(IAgentProfileService);

    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'ds' });

    expect(profile.getModelWireName()).toBe('deepseek-v4-pro');
    const prompt = profile.getSystemPrompt();
    expect(prompt).toContain('helpful software engineer assistant');
    expect(prompt).not.toContain('# Model Adaptation');
    expect(prompt).not.toContain('# Tool use');
  });

  it('resolves the wire name even though the prompt stays minimal', async () => {
    delete process.env[ENV_KEY];
    ctx = createTestAgent({
      autoConfigure: false,
      initialConfig: deepseekConfig('deepseek-v3') as never,
    });
    const profile = ctx.get(IAgentProfileService);

    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'ds' });

    expect(profile.getModel()).toBe('ds');
    expect(profile.getModelWireName()).toBe('deepseek-v3');
    expect(profile.getSystemPrompt()).not.toContain('# Model Adaptation');
  });

  it('injects the alias opt-in adaptation for a family with no curated file', async () => {
    process.env[ENV_KEY] = '1';
    ctx = createTestAgent({
      autoConfigure: false,
      initialConfig: deepseekConfig('gpt-4o') as never,
    });
    const profile = ctx.get(IAgentProfileService);

    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME, model: 'ds' });

    expect(profile.getModelWireName()).toBe('gpt-4o');
    const prompt = profile.getSystemPrompt();
    expect(prompt).toContain('# Model Adaptation: gpt-4o');
    expect(prompt).toContain('reference data, not an');
  });

  it('injects nothing for a family with no curated file while the opt-in is off', async () => {
    delete process.env[ENV_KEY];
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
