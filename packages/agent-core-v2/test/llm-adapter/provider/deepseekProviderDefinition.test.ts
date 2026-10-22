import { describe, expect, it } from 'bun:test';

import {
  getProviderDefinition,
  getProviderDefinitions,
  registerProviderDefinitionIfAbsent,
} from '#/llm-adapter/provider/provider-definition';

describe('deepseek provider definition', () => {
  it('registers an openai-protocol definition on the official endpoint', () => {
    const definition = getProviderDefinition('deepseek', 'openai');
    expect(definition).toBeDefined();
    expect(definition?.baseProtocol).toBe('openai');
    expect(definition?.endpoint?.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
    expect(definition?.endpoint?.baseUrlEnv).toBe('DEEPSEEK_BASE_URL');
    expect(definition?.endpoint?.defaultBaseUrl).toBe('https://api.deepseek.com');
  });

  it('declares the family modalities and capabilities', () => {
    const definition = getProviderDefinition('deepseek', 'openai');
    const capability = definition?.capability?.('deepseek-v4.1-flash');
    expect(capability).toEqual({
      image_in: true,
      video_in: false,
      audio_in: false,
      thinking: true,
      tool_use: true,
      pdf_in: false,
    });
  });

  it('declares nothing for models outside the family', () => {
    const definition = getProviderDefinition('deepseek', 'openai');
    expect(definition?.capability?.('gpt-4o')).toBeUndefined();
    expect(definition?.capability?.('my-deepseek-clone')).toBeUndefined();
  });

  it('does not overwrite an existing definition', () => {
    const original = getProviderDefinition('deepseek', 'openai');
    expect(() =>
      registerProviderDefinitionIfAbsent({
        id: 'deepseek',
        baseProtocol: 'openai',
        endpoint: { apiKeyEnv: 'SHOULD_NOT_APPLY' },
      }),
    ).not.toThrow();
    expect(getProviderDefinition('deepseek', 'openai')).toBe(original);
  });

  it('registers no wire type beyond the openai protocol', () => {
    const definitions = getProviderDefinitions('deepseek');
    expect(definitions.length).toBe(1);
    expect(definitions.every((definition) => definition.baseProtocol === 'openai')).toBe(true);
  });

  it('registers no responses variant', () => {
    expect(getProviderDefinition('deepseek', 'openai_responses')).toBeUndefined();
  });
});
