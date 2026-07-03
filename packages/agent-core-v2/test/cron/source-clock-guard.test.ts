import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const GUARDED_FILES = [
  { dir: 'session/cron', file: 'sessionCronServiceImpl.ts' },
  { dir: 'app/cron', file: 'jitter.ts' },
] as const;

describe('cron source clock guard', () => {
  it.each(GUARDED_FILES)('$file does not call Date.now()', ({ dir, file }) => {
    const source = readFileSync(new URL(`../../src/${dir}/${file}`, import.meta.url), 'utf8');
    expect(stripComments(source)).not.toMatch(/\bDate\.now\s*\(/);
  });
});

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}
