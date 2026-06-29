import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const GUARDED_FILES = [
  'scheduler.ts',
  'persist.ts',
  'jitter.ts',
  'session-store.ts',
] as const;

describe('cron source clock guard', () => {
  it.each(GUARDED_FILES)('%s does not call Date.now()', (file) => {
    const source = readFileSync(new URL(`../../src/cron/tools/${file}`, import.meta.url), 'utf8');
    expect(stripComments(source)).not.toMatch(/\bDate\.now\s*\(/);
  });
});

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}
