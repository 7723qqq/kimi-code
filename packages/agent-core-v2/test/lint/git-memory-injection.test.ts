import { describe, expect, it } from 'bun:test';

import {
  extractImportSpecifiers,
  findViolations,
} from '../../scripts/check-git-memory-injection.mjs';

describe('git memory injection gate', () => {
  it('extracts import specifiers', () => {
    const specifiers = extractImportSpecifiers(
      [
        "import { a } from '#/app/thing';",
        "import type { B } from '#/other/b';",
        "import 'side-effect';",
      ].join('\n'),
    );
    expect(specifiers).toContain('#/app/thing');
    expect(specifiers).toContain('#/other/b');
    expect(specifiers).toContain('side-effect');
  });

  it('accepts a module that only reads git objects', () => {
    const violations = findViolations(
      'projection.ts',
      [
        "import { GIT_MEMORY_WINDOW } from './types';",
        "import { readFile } from 'node:fs/promises';",
      ].join('\n'),
    );
    expect(violations).toEqual([]);
  });

  it('rejects a module that imports a provider client', () => {
    const violations = findViolations(
      'projection.ts',
      "import { createModel } from '#/llm-adapter/model/catalog';",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('projection.ts');
    expect(violations[0]?.specifier).toBe('#/llm-adapter/model/catalog');
  });

  it('rejects a module that imports the model requester', () => {
    const violations = findViolations(
      'gitMemoryService.ts',
      "import { requester } from '#/human/llm/model-requester';",
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('exempts the flag module', () => {
    const violations = findViolations(
      'flag.ts',
      "import { provider } from '#/llm-adapter/provider';",
    );
    expect(violations).toEqual([]);
  });

  it('ignores forbidden words outside import statements', () => {
    const violations = findViolations(
      'projection.ts',
      ['const label = "provider";', "import { x } from './types';"].join('\n'),
    );
    expect(violations).toEqual([]);
  });
});
