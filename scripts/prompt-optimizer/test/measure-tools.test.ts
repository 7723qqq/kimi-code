import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeMeasureTool, MEASURE_TOOLS } from '../src/measure/tools';

let tempHome: string | undefined;

afterEach(() => {
  if (tempHome !== undefined) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
});

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'measure-tools-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'src', 'alpha.ts'), 'export const alpha = 1;\nexport const beta = 2;\n');
  writeFileSync(join(root, 'src', 'beta.md'), '# Beta\n\nalpha mentions beta.\n');
  writeFileSync(join(root, 'node_modules', 'ignored.ts'), 'alpha\n');
  tempHome = root;
  return root;
}

describe('the measure tool set', () => {
  test('declares exactly the tools the production prompt grants', () => {
    expect(MEASURE_TOOLS.map((tool) => tool.name)).toEqual(['Read', 'Glob', 'Grep']);
  });
});

describe('Read', () => {
  test('returns the file with line numbers', async () => {
    const root = makeWorkspace();
    const output = await executeMeasureTool('Read', JSON.stringify({ path: 'src/alpha.ts' }), root);
    expect(output).toContain('1| export const alpha = 1;');
    expect(output).toContain('2| export const beta = 2;');
  });

  test('accepts an absolute path inside the working directory', async () => {
    const root = makeWorkspace();
    const output = await executeMeasureTool(
      'Read',
      JSON.stringify({ path: join(root, 'src', 'beta.md') }),
      root,
    );
    expect(output).toContain('# Beta');
  });

  test('refuses a path outside the working directory', async () => {
    const root = makeWorkspace();
    const output = await executeMeasureTool(
      'Read',
      JSON.stringify({ path: join(tmpdir(), 'elsewhere.ts') }),
      root,
    );
    expect(output).toContain('escapes the working directory');
  });

  test('names the missing parameter instead of guessing', async () => {
    const root = makeWorkspace();
    const output = await executeMeasureTool('Read', JSON.stringify({}), root);
    expect(output).toContain('requires a "path"');
  });
});

describe('Glob', () => {
  test('lists matching files as repo-relative posix paths', async () => {
    const root = makeWorkspace();
    const output = await executeMeasureTool(
      'Glob',
      JSON.stringify({ pattern: '*.ts', path: 'src' }),
      root,
    );
    expect(output).toBe('alpha.ts');
  });

  test('searches the working directory when no path is given', async () => {
    const root = makeWorkspace();
    const output = await executeMeasureTool('Glob', JSON.stringify({ pattern: '*.md' }), root);
    expect(output).toBe('src/beta.md');
  });

  test('says so when nothing matches', async () => {
    const root = makeWorkspace();
    const output = await executeMeasureTool(
      'Glob',
      JSON.stringify({ pattern: '*.rust', path: 'src' }),
      root,
    );
    expect(output).toBe('No files matched.');
  });
});

describe('Grep', () => {
  test('reports path, line number and the matching line', async () => {
    const root = makeWorkspace();
    const output = await executeMeasureTool(
      'Grep',
      JSON.stringify({ pattern: 'alpha', path: 'src' }),
      root,
    );
    expect(output).toContain('src/alpha.ts:1:export const alpha = 1;');
    expect(output).toContain('src/beta.md:3:alpha mentions beta.');
  });

  test('skips node_modules and dot directories', async () => {
    const root = makeWorkspace();
    const output = await executeMeasureTool('Grep', JSON.stringify({ pattern: 'alpha' }), root);
    expect(output).not.toContain('node_modules');
  });

  test('a glob narrows the search', async () => {
    const root = makeWorkspace();
    const output = await executeMeasureTool(
      'Grep',
      JSON.stringify({ pattern: 'alpha', path: 'src', glob: '*.md' }),
      root,
    );
    expect(output).not.toContain('alpha.ts');
    expect(output).toContain('beta.md');
  });

  test('an invalid expression is reported, not thrown', async () => {
    const root = makeWorkspace();
    const output = await executeMeasureTool(
      'Grep',
      JSON.stringify({ pattern: '(', path: 'src' }),
      root,
    );
    expect(output).toContain('invalid regular expression');
  });
});

describe('the tool boundary', () => {
  test('a malformed input is reported as the tool output', async () => {
    const root = makeWorkspace();
    const output = await executeMeasureTool('Read', '{not json', root);
    expect(output).toContain('not valid JSON');
  });

  test('an unknown tool lists what is available', async () => {
    const root = makeWorkspace();
    const output = await executeMeasureTool('Write', JSON.stringify({}), root);
    expect(output).toContain('Available: Read, Glob, Grep');
  });
});
