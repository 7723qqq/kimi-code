import { describe, expect, test } from 'bun:test';

import { parseConfigText, providerNameForModel } from '../src/llm-caller';

const FIXTURE = `
default_model = "workbuddy/deepseek-v4.1-flash"

[providers.workbuddy]
type = "openai"
api_key = "key-for-workbuddy"
base_url = "https://api.workbuddy.example/v1"

[providers.deepseek]
type = "openai"
api_key = "key-for-deepseek"
base_url = "https://api.deepseek.com"
`;

describe('providerNameForModel', () => {
  test('takes the provider from the model id prefix', () => {
    expect(providerNameForModel('workbuddy/deepseek-v4.1-flash')).toBe('workbuddy');
    expect(providerNameForModel('opencode/laguna-s-2.1-free')).toBe('opencode');
  });

  test('returns undefined for a bare model id', () => {
    expect(providerNameForModel('gpt-4o')).toBeUndefined();
    expect(providerNameForModel('/leading')).toBeUndefined();
    expect(providerNameForModel('')).toBeUndefined();
  });
});

describe('parseConfigText', () => {
  test('reads default_model and each provider block', () => {
    const { providers, defaultModel } = parseConfigText(FIXTURE);
    expect(defaultModel).toBe('workbuddy/deepseek-v4.1-flash');
    expect(providers['workbuddy']?.baseUrl).toBe('https://api.workbuddy.example/v1');
    expect(providers['workbuddy']?.apiKey).toBe('key-for-workbuddy');
    expect(providers['deepseek']?.baseUrl).toBe('https://api.deepseek.com');
  });

  test('a provider block does not leak into the next section', () => {
    const { providers } = parseConfigText(`${FIXTURE}\n[models."workbuddy/x"]\nbase_url = "wrong"\n`);
    expect(providers['workbuddy']?.baseUrl).toBe('https://api.workbuddy.example/v1');
  });
});
