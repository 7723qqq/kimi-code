import { describe, expect, it } from 'vitest';

import { ConfigRegistry } from '#/app/config/configService';
import { transformTomlData } from '#/app/config/toml';
import {
  MODEL_OVERRIDES_SECTION,
  ModelOverridesSchema,
} from '#/app/kosongConfig/configSection';

describe('modelOverrides config section', () => {
  it('registers the modelOverrides section with an empty default', () => {
    const registry = new ConfigRegistry();

    const section = registry.getSection(MODEL_OVERRIDES_SECTION);
    expect(section).toBeDefined();
    expect(section?.defaultValue).toEqual({});
  });

  it('validates temperature / topP / thinkingKeep / maxCompletionTokens', () => {
    expect(
      ModelOverridesSchema.parse({
        temperature: 0.3,
        topP: 0.95,
        thinkingKeep: 'all',
        maxCompletionTokens: 8192,
      }),
    ).toEqual({
      temperature: 0.3,
      topP: 0.95,
      thinkingKeep: 'all',
      maxCompletionTokens: 8192,
    });

    expect(ModelOverridesSchema.parse({ temperature: 0.3 })).toEqual({ temperature: 0.3 });
    expect(() => ModelOverridesSchema.parse({ temperature: 'hot' })).toThrow();
    expect(() => ModelOverridesSchema.parse({ maxCompletionTokens: 1.5 })).toThrow();
    expect(() => ModelOverridesSchema.parse({ maxCompletionTokens: 0 })).toThrow();
    expect(ModelOverridesSchema.parse({ bogus: 1 })).toEqual({});
  });

  it('round-trips [model_overrides] from TOML with snake_case keys', () => {
    const registry = new ConfigRegistry();
    const transformed = transformTomlData(
      {
        model_overrides: {
          temperature: 0.3,
          top_p: 0.95,
          thinking_keep: 'all',
          max_completion_tokens: 8192,
        },
      },
      registry,
    );

    expect(transformed[MODEL_OVERRIDES_SECTION]).toEqual({
      temperature: 0.3,
      topP: 0.95,
      thinkingKeep: 'all',
      maxCompletionTokens: 8192,
    });
  });
});
