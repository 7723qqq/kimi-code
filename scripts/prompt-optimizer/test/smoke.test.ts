import { describe, expect, test } from 'bun:test';

import { join } from 'node:path';

import { loadConfig } from '../src/config';

describe('harness', () => {
  test('loadConfig returns the built-in defaults', () => {
    const config = loadConfig();
    expect(config.systemPromptPath).toEndWith(join('agentProfileCatalog', 'system.md'));
    expect(config.outputDir).toEndWith(join('scripts', 'prompt-optimizer', 'reports'));
    expect(config.concurrency).toBeGreaterThan(0);
  });

  test('loadConfig applies overrides', () => {
    expect(loadConfig({ concurrency: 7 }).concurrency).toBe(7);
  });
});
