import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const GUARDED_FILES = [
  'cronService.ts',
  'jitter.ts',
] as const;

describe('cron source clock guard', () => {
  it.each(GUARDED_FILES)('%s does not call Date.now()', (file) => {
    const source = readFileSync(new URL(`../../src/agent/cron/${file}`, import.meta.url), 'utf8');
    expect(stripComments(source)).not.toMatch(/\bDate\.now\s*\(/);
  });
});

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}
