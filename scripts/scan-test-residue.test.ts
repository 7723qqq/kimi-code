/**
 * Regression suite for `scan-test-residue.mjs`.
 *
 * The scanner is the only mechanical proof that no Node or vitest semantics are
 * left in the tree, so a blind spot in it is worse than a violation it misses:
 * the report still says zero. Each case below pins one blind spot that existed
 * and was fixed, and fails if the fix is undone.
 *
 * Run: bun test --isolate scripts/scan-test-residue.test.mjs
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

const SCANNER = join(import.meta.dirname, 'scan-test-residue.mjs');

// Assembled at runtime so this suite's own source never contains a literal the
// scanner would report. The scanner's rules read module specifiers verbatim, so
// a fixture written inline would show up as a real violation of the repo scan.
const NODE_TEST = ['node', 'test'].join(':');
const NODE_ASSERT = [NODE_TEST.replace('test', 'assert'), 'strict'].join('/');
const VITEST = 'vite' + 'st';
const BUN_LACKS_POLL = ['Bun', 'has', 'no', '`expect.poll`'].join(' ');
const VI_IMPORT = ['expect', 'v' + 'i'].join(', ');
const VI_CALL = 'v' + 'i.fn()';

function fixture(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scan-residue-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {} }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(rel: string, contents: string): Promise<void> {
  const target = join(root, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function scan(args: string[] = []): Promise<{ code: number; report: any; text: string }> {
  const proc = Bun.spawn(['bun', SCANNER, `--root=${root}`, ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  let report: any = undefined;
  if (args.includes('--json')) {
    try {
      report = JSON.parse(text.slice(text.indexOf('{')));
    } catch {
      report = undefined;
    }
  }
  return { code: proc.exitCode ?? -1, report, text };
}

function hits(report: any, ruleId: string): string[] {
  return report.rules.find((rule: any) => rule.id === ruleId)?.hits ?? [];
}

describe('scan-test-residue', () => {
  it('scans tools/ and plugins/, which were outside the walk', async () => {
    await write('tools/review/check.mjs', fixture(`import { test } from '${NODE_TEST}';`));
    await write('plugins/official/x/bin/x.mjs', "#!/usr/bin/env node\n");

    const { report } = await scan(['--json']);
    expect(report.scannedRoots).toContain('tools');
    expect(report.scannedRoots).toContain('plugins');
    expect(hits(report, 'node-test-import')).toContain('tools/review/check.mjs');
    expect(hits(report, 'node-shebang')).toContain('plugins/official/x/bin/x.mjs');
  });

  it('sees a require() form of the assert module, not only the import form', async () => {
    await write(
      'packages/a/test/require-form.cjs',
      fixture(`const assert = require("${NODE_ASSERT}");`),
    );

    const { report } = await scan(['--json']);
    expect(hits(report, 'node-assert')).toContain('packages/a/test/require-form.cjs');
  });

  it('reads a module specifier even though it is a string literal', async () => {
    await write('packages/a/test/import-form.test.ts', fixture(`import { expect } from '${VITEST}';`));

    const { report } = await scan(['--json']);
    expect(hits(report, 'vitest-import')).toContain('packages/a/test/import-form.test.ts');
  });

  it('does not let a URL in a string open a comment that hides the rest of the file', async () => {
    const manifest = {
      name: 'fixture',
      scripts: { url: 'echo https://example.test/x', later: 'node scripts/later.cjs' },
    };
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest, null, 2));

    const { report } = await scan(['--json']);
    expect(hits(report, 'node-package-script')).toContain('package.json');
  });

  it('scans the repository root manifest', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { run: 'node scripts/run.cjs' } }, null, 2),
    );

    const { report } = await scan(['--json']);
    expect(hits(report, 'node-package-script')).toContain('package.json');
  });

  it('matches a shim marker that only appears in a comment', async () => {
    await write(
      'packages/a/test/shim.test.ts',
      fixture(`// ${BUN_LACKS_POLL}, so this polls by hand.`, 'export const value = 1;'),
    );

    const { report } = await scan(['--json']);
    expect(hits(report, 'handwritten-vitest-shim')).toContain('packages/a/test/shim.test.ts');
  });

  it('accepts a baselined hit only when it carries a reason', async () => {
    await write('packages/a/test/keep.test.ts', fixture(`import { expect } from '${VITEST}';`));
    await writeFile(
      join(root, '.baseline.json'),
      JSON.stringify({ 'vitest-import': { 'packages/a/test/keep.test.ts': 'cannot be changed' } }),
    );

    const withReason = await scan(['--json', '--baseline=.baseline.json']);
    expect(withReason.code).toBe(0);
    const accepted = withReason.report.rules.find((rule: any) => rule.id === 'vitest-import').accepted;
    expect(accepted).toEqual([
      { path: 'packages/a/test/keep.test.ts', reason: 'cannot be changed' },
    ]);

    await writeFile(
      join(root, '.baseline.json'),
      JSON.stringify({ 'vitest-import': { 'packages/a/test/keep.test.ts': '   ' } }),
    );
    const withoutReason = await scan(['--json', '--baseline=.baseline.json']);
    expect(withoutReason.code).toBe(1);
    expect(withoutReason.report.missingBaselineReasons.length).toBe(1);
  });

  it('fails the run on an error-level hit and passes when there is none', async () => {
    await write('packages/a/test/clean.test.ts', "import { expect } from 'bun:test';\n");
    expect((await scan()).code).toBe(0);

    await write(
      'packages/a/test/dirty.test.ts',
      fixture(`import { ${VI_IMPORT} } from 'bun:test';`, `${VI_CALL};`),
    );
    expect((await scan()).code).toBe(1);
  });
});
