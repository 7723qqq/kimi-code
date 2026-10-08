import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getConfigPath, resolveCredentials } from '../src/llm-caller';

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

const FIXTURE_UNKNOWN_PROVIDER = `
default_model = "ghost/some-model"

[providers.deepseek]
type = "openai"
api_key = "key-for-deepseek"
base_url = "https://api.deepseek.com"
`;

const savedHome = process.env['KIMI_CODE_HOME'];
const savedKeys = {
  KIMI_API_KEY: process.env['KIMI_API_KEY'],
  KIMI_MODEL_API_KEY: process.env['KIMI_MODEL_API_KEY'],
  KIMI_BASE_URL: process.env['KIMI_BASE_URL'],
  KIMI_MODEL_BASE_URL: process.env['KIMI_MODEL_BASE_URL'],
};
const tempHomes: string[] = [];

function useConfig(text: string): void {
  const home = mkdtempSync(join(tmpdir(), 'po-config-'));
  tempHomes.push(home);
  writeFileSync(join(home, 'config.toml'), text);
  process.env['KIMI_CODE_HOME'] = home;
  for (const key of Object.keys(savedKeys) as (keyof typeof savedKeys)[]) delete process.env[key];
}

afterEach(() => {
  if (savedHome === undefined) delete process.env['KIMI_CODE_HOME'];
  else process.env['KIMI_CODE_HOME'] = savedHome;
  for (const [key, value] of Object.entries(savedKeys)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const bare = { model: '', apiBaseUrl: '', apiKey: '', concurrency: 1 };

describe('resolveCredentials', () => {
  test('takes baseUrl and apiKey from the provider the model names', () => {
    useConfig(FIXTURE);
    const resolved = resolveCredentials(bare);
    expect(resolved.model).toBe('workbuddy/deepseek-v4.1-flash');
    expect(resolved.baseUrl).toBe('https://api.workbuddy.example/v1');
    expect(resolved.apiKey).toBe('key-for-workbuddy');
  });

  test('does not pair a workbuddy model with the deepseek baseUrl', () => {
    useConfig(FIXTURE);
    const resolved = resolveCredentials(bare);
    expect(resolved.baseUrl).not.toBe('https://api.deepseek.com');
  });

  test('an explicit --model selects its own provider', () => {
    useConfig(FIXTURE);
    const resolved = resolveCredentials({ ...bare, model: 'deepseek/deepseek-v4-pro' });
    expect(resolved.baseUrl).toBe('https://api.deepseek.com');
    expect(resolved.apiKey).toBe('key-for-deepseek');
  });

  test('throws naming the model and the known providers when the prefix is unknown', () => {
    useConfig(FIXTURE_UNKNOWN_PROVIDER);
    expect(() => resolveCredentials(bare)).toThrow(/ghost\/some-model/);
    expect(() => resolveCredentials(bare)).toThrow(/deepseek/);
  });

  test('throws rather than running with an empty model', () => {
    useConfig('[providers.deepseek]\nbase_url = "https://api.deepseek.com"\n');
    expect(() => resolveCredentials(bare)).toThrow(/No model to run/);
  });

  test('an explicit apiBaseUrl still wins over the provider block', () => {
    useConfig(FIXTURE);
    const resolved = resolveCredentials({ ...bare, apiBaseUrl: 'https://override.example/v1' });
    expect(resolved.baseUrl).toBe('https://override.example/v1');
  });

  test('getConfigPath follows KIMI_CODE_HOME', () => {
    useConfig(FIXTURE);
    expect(getConfigPath()).toBe(join(process.env['KIMI_CODE_HOME']!, 'config.toml'));
  });
});
