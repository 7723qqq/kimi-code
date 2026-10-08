import { describe, expect, test } from 'bun:test';

import { loadConfig } from '../src/config';

describe('harness', () => {
  test('loadConfig returns the built-in defaults', () => {
    const config = loadConfig();
    expect(config.systemPromptPath).toEndWith('agentProfileCatalog/system.md');
    expect(config.outputDir).toEndWith('scripts/prompt-optimizer/reports');
    expect(config.concurrency).toBeGreaterThan(0);
  });

  test('loadConfig applies overrides', () => {
    expect(loadConfig({ concurrency: 7 }).concurrency).toBe(7);
  });
});
