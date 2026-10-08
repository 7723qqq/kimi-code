import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { slugifyModel } from '../src/cli';
import { resolveModel } from '../src/llm-caller';

const savedHome = process.env['KIMI_CODE_HOME'];
const tempHomes: string[] = [];

function useConfig(text: string): void {
  const home = mkdtempSync(join(tmpdir(), 'po-model-'));
  tempHomes.push(home);
  writeFileSync(join(home, 'config.toml'), text);
  process.env['KIMI_CODE_HOME'] = home;
}

afterEach(() => {
  if (savedHome === undefined) delete process.env['KIMI_CODE_HOME'];
  else process.env['KIMI_CODE_HOME'] = savedHome;
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('resolveModel', () => {
  test('prefers an explicit model', () => {
    useConfig('default_model = "workbuddy/x"\n');
    expect(resolveModel('other/model')).toBe('other/model');
  });

  test('falls back to default_model from config.toml', () => {
    useConfig('default_model = "workbuddy/deepseek-v4.1-flash"\n');
    expect(resolveModel('')).toBe('workbuddy/deepseek-v4.1-flash');
    expect(resolveModel()).toBe('workbuddy/deepseek-v4.1-flash');
  });

  test('throws instead of running with an empty model', () => {
    useConfig('[providers.deepseek]\nbase_url = "https://api.deepseek.com"\n');
    expect(() => resolveModel('')).toThrow(/No model to run/);
    expect(() => resolveModel('   ')).toThrow(/No model to run/);
  });
});

describe('slugifyModel', () => {
  test('flattens the separator so the name is a single path segment', () => {
    expect(slugifyModel('workbuddy/deepseek-v4.1-flash')).toBe('workbuddy-deepseek-v4.1-flash');
    expect(slugifyModel('workbuddy/deepseek-v4.1-flash')).not.toContain('/');
  });

  test('handles other filename-hostile models', () => {
    expect(slugifyModel('kimi-code/kimi-for-coding')).toBe('kimi-code-kimi-for-coding');
    expect(slugifyModel('openrouter/z-ai/glm-5.2:free')).toBe('openrouter-z-ai-glm-5.2-free');
    expect(slugifyModel('阶跃/step-5-preview')).toBe('step-5-preview');
  });

  test('never returns an empty name', () => {
    expect(slugifyModel('')).toBe('model');
    expect(slugifyModel('///')).toBe('model');
  });

  test('a slug survives being joined into a report path', () => {
    const joined = join('/tmp/reports', `bench-${slugifyModel('workbuddy/deepseek-v4.1-flash')}-1.json`);
    expect(joined).toBe('/tmp/reports/bench-workbuddy-deepseek-v4.1-flash-1.json');
  });
});
