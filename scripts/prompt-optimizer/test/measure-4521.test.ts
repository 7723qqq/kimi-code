import { describe, expect, test } from 'bun:test';

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../../..');
const PROMPT_DIR = join(ROOT, 'packages/agent-core-v2/src/app/agentProfileCatalog');
const SCRIPT = join(ROOT, 'scripts/prompt-optimizer/src/measure-4521.ts');

describe('the #4521 measurement harness', () => {
  test('reads both sides from published tags, not the working tree', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toContain("@moonshot-ai/kimi-code@2.4.0");
    expect(source).toContain("@moonshot-ai/kimi-code@2.4.1");
    // The before side cannot come from disk: those files no longer exist.
    expect(source).toContain('git');
  });

  test('assembles the 2.4.1 skeleton from its section files instead of reading it alone', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    for (const placeholder of ['coding_section', 'delivering_work_section', 'agents_section']) {
      expect(source).toContain(placeholder);
    }
    for (const file of ['coding.md', 'delivering-work.md', 'project-information.md']) {
      expect(source).toContain(file);
    }
  });

  test('measures tool descriptions as well as the system prompt', () => {
    // The reduction is almost entirely in the tool descriptions; a system-prompt
    // only figure would understate it by an order of magnitude.
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toContain('tool descriptions');
    expect(source).toContain('total prompt surface');
  });

  test('the section files it names all exist on disk', () => {
    for (const file of ['system.md', 'coding.md', 'delivering-work.md', 'project-information.md']) {
      expect(existsSync(join(PROMPT_DIR, file))).toBe(true);
    }
  });

  test('the tags it measures exist in this repository', () => {
    for (const tag of ['@moonshot-ai/kimi-code@2.4.0', '@moonshot-ai/kimi-code@2.4.1']) {
      const sha = execFileSync('git', ['-C', ROOT, 'rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim();
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});
