import { describe, expect, it } from 'bun:test';
/**
 * The four layers that used to fail silently.
 *
 * Each of these was verified broken before the fix, so each case below would have
 * passed against the old code only by asserting the wrong thing:
 *
 * - `--only bogus` changed nothing and exited 0
 * - `vitest.config.ts` was deleted with "needs no project config", losing setup
 *   files, the jsdom environment and coverage
 * - `node: gap` detection was a text regex that fired on comments and strings
 * - the CI workflow block iterated a file list that never contained a `.yml`
 *
 * A suite that only asserts the new behaviour would not prove the old behaviour
 * was wrong. Where it is cheap, the case also asserts the symptom (exit code, the
 * absence of a swallowed step) rather than only the shape of the output.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectRequireBindings, parse } from '../src/ast.mjs';
import { UsageError, parseArgs } from '../src/cli.mjs';
import { createJournal } from '../src/journal.mjs';
import { applyConfigLayer, rewriteScript, rewriteTestRunnerScript } from '../src/layers/config.mjs';
import { applyNodeGapLayer } from '../src/layers/node-gaps.mjs';
import { applyPackageLayer, portVitestConfig, TIMEOUT_PRELOAD } from '../src/layers/packages.mjs';
import { activeGaps, findMissingUsages } from '../src/node-gaps.mjs';
import { loadProject } from '../src/project.mjs';

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'silent-'));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  if (files['package.json'] === undefined) {
    writeFileSync(join(root, 'package.json'), '{"name":"p","version":"1.0.0"}\n', 'utf8');
  }
  return root;
}

function applyAll(root, layers) {
  const loaded = loadProject(root);
  const journal = createJournal(layers);
  if (layers.includes('config')) applyConfigLayer(loaded, journal);
  if (layers.includes('packages')) applyPackageLayer(loaded, journal);
  if (layers.includes('source')) applyNodeGapLayer(loaded, journal);
  return { journal, loaded };
}

describe('a bad --only is a usage error, not an empty run', () => {
  it('rejects an unknown layer by name', () => {
    let caught;
    try {
      parseArgs(['scan', '--only', 'bogus']);
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof UsageError).toBe(true);
    expect(caught.message).toContain('bogus');
    expect(caught.message).toContain('config');
  });

  it('rejects a missing value instead of consuming the next flag', () => {
    let caught;
    try {
      parseArgs(['scan', '--only', '--root', '.']);
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof UsageError).toBe(true);
  });

  it('rejects an empty value', () => {
    expect(() => parseArgs(['scan', '--only', ''])).toThrow(UsageError);
    expect(() => parseArgs(['scan', '--only', '   '])).toThrow(UsageError);
  });

  it('rejects --root with no value', () => {
    expect(() => parseArgs(['scan', '--root'])).toThrow(UsageError);
  });

  it('rejects an unknown long option', () => {
    expect(() => parseArgs(['scan', '--nope'])).toThrow(UsageError);
  });

  /**
   * A positional after a flag used to be consumed as the command: measured,
   * `bun cli.mjs --json revert journal.json` ran `scan` on the working
   * directory with `--json`, exited 0, and the journal was never read. The
   * command must come first, and only `revert` takes a positional at all.
   */
  it('rejects a positional argument that arrives after a flag', () => {
    expect(() => parseArgs(['--json', 'revert', 'journal.json'])).toThrow(UsageError);
    expect(() => parseArgs(['scan', 'journal.json'])).toThrow(UsageError);
    expect(() => parseArgs(['apply', 'extra'])).toThrow(UsageError);
    const ok = parseArgs(['revert', 'journal.json']);
    expect(ok.command).toBe('revert');
    expect(ok.target).toBe('journal.json');
  });

  it('treats --help as a request for help, not as a scan', () => {
    const options = parseArgs(['--help']);
    expect(options.help).toBe(true);
    expect(options.command).toBe('scan');
  });

  it('rejects an unknown command instead of scanning', () => {
    expect(() => parseArgs(['aplly'])).toThrow(UsageError);
  });

  it('requires a journal path for revert', () => {
    expect(() => parseArgs(['revert'])).toThrow(UsageError);
    expect(() => parseArgs(['revert', 'a.json', 'b.json'])).toThrow(UsageError);
  });

  it('accepts a valid list, trims it and removes duplicates', () => {
    const options = parseArgs(['scan', '--only', ' config , source ,config']);
    expect(JSON.stringify(options.layers)).toBe('["config","source"]');
  });

  it('leaves --no-source untouched', () => {
    expect(JSON.stringify(parseArgs(['scan', '--no-source']).layers)).toBe(
      '["config","packages","tests"]',
    );
  });
});

describe('vitest config is ported, not discarded', () => {
  it('turns setupFiles into preload and coverage into coverage = true', () => {
    const ported = portVitestConfig(
      "export default { test: { setupFiles: ['./test/setup.ts'], coverage: { provider: 'v8' } } };",
    );
    const lines = ported.settings.map((setting) => setting.line);
    expect(lines.some((line) => line.includes('preload = ["./test/setup.ts"]'))).toBe(true);
    expect(lines.some((line) => line.includes('coverage = true'))).toBe(true);
  });

  it('names what it could not port instead of dropping it silently', () => {
    const ported = portVitestConfig(
      "export default { test: { environment: 'jsdom', globals: true, resolve: { alias: {} } } };",
    );
    const joined = ported.unported.join(' | ');
    expect(joined.includes('jsdom')).toBe(true);
    expect(joined.includes('globals')).toBe(true);
    expect(joined.includes('alias')).toBe(true);
  });

  it('reads the array form of setupFiles', () => {
    const ported = portVitestConfig("setupFiles: ['./a.ts', './b.ts']");
    const line = ported.settings.find((setting) => setting.key === 'preload')?.line;
    expect(line).toBe('preload = ["./a.ts", "./b.ts"]');
  });

  it('the whole layer writes a parseable bunfig and removes the config', () => {
    const root = project({
      'vitest.config.ts':
        "export default { test: { setupFiles: ['./test/setup.ts'], coverage: { provider: 'v8' } } };",
    });
    try {
      const { journal } = applyAll(root, ['packages']);
      const bunfig = journal.changes.findLast((change) => change.file === 'bunfig.toml');
      expect(bunfig).toBeDefined();
      const parsed = Bun.TOML.parse(bunfig.after);
      expect(JSON.stringify(parsed.test.preload)).toBe('["../test/setup.ts"]'.replace('..', '.'));
      expect(parsed.test.coverage).toBe(true);
      const removal = journal.removals.find((item) => item.file === 'vitest.config.ts');
      expect(removal).toBeDefined();
      expect(String(removal.detail).includes('preload')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * `testTimeout` and `maxWorkers` used to be reported as "set them per test or with
 * --timeout", which was advice, not a migration. Both have a verified mechanism and
 * a suite that silently loses either behaves differently without saying so:
 *
 * - `bunfig.toml` has no timeout key. Measured on Bun 1.4.4, `[test] timeout = 50`
 *   is accepted and a 300 ms test still passes. `setDefaultTimeout(ms)` loaded
 *   through `[test] preload` does apply — a 400 ms test fails with "this test timed
 *   out after 100ms", and a slow `beforeEach` fails with the hook message.
 * - `bunfig.toml` has no worker-count key either. Measured, `[test] parallel = 4` is
 *   accepted and four files that each sleep 500 ms still take 2.2 s. `bun test
 *   --parallel=4` takes 1.0 s, so the script is the only place the number can live.
 */
describe('testTimeout is migrated into a preload, not merely reported', () => {
  it('reads a literal testTimeout', () => {
    const ported = portVitestConfig('export default { test: { testTimeout: 10000 } };');
    expect(ported.files.length).toBe(1);
    expect(ported.files[0].path).toBe(TIMEOUT_PRELOAD);
    expect(ported.files[0].content).toContain('setDefaultTimeout(10000)');
    expect(ported.notes.join(' ')).toContain('setDefaultTimeout(10000)');
  });

  it('lists the generated preload so bunfig actually loads it', () => {
    const ported = portVitestConfig('export default { test: { testTimeout: 2500 } };');
    const preload = ported.settings.find((setting) => setting.key === 'preload');
    expect(preload.line).toContain(TIMEOUT_PRELOAD);
  });

  it('migrates hookTimeout when it agrees with testTimeout', () => {
    const ported = portVitestConfig(
      'export default { test: { testTimeout: 5000, hookTimeout: 5000 } };',
    );
    expect(ported.files[0].content).toContain('setDefaultTimeout(5000)');
    expect(ported.unported.length).toBe(0);
  });

  it('refuses to pick one when testTimeout and hookTimeout disagree', () => {
    const ported = portVitestConfig(
      'export default { test: { testTimeout: 5000, hookTimeout: 30000 } };',
    );
    expect(ported.files.length).toBe(0);
    expect(ported.unported.join(' ')).toContain('differ');
    expect(ported.unported.join(' ')).toContain('setDefaultTimeout');
  });

  it('reports a computed timeout instead of guessing a number', () => {
    const ported = portVitestConfig('export default { test: { testTimeout: TIMEOUT } };');
    expect(ported.files.length).toBe(0);
  });

  it('keeps the existing setupFiles entry alongside the generated preload', () => {
    const ported = portVitestConfig(
      "export default { test: { setupFiles: ['./setup.ts'], testTimeout: 8000 } };",
    );
    const preload = ported.settings.find((setting) => setting.key === 'preload');
    expect(preload.line).toContain('./setup.ts');
    expect(preload.line).toContain(TIMEOUT_PRELOAD);
  });

  /**
   * `preload` is one array key, so two ported configs cannot each write their own
   * line: `mergeBunfig` keeps the last value and the earlier list disappears.
   * Each config's setup files have to survive in the single list.
   */
  it('merges preload entries from every ported config instead of keeping the last one', () => {
    const root = project({
      'vitest.config.ts': "export default { test: { setupFiles: ['./a.ts'] } };",
      'vitest.workspace.ts': "export default { test: { setupFiles: ['./b.ts'] } };",
      'a.ts': '',
      'b.ts': '',
    });
    try {
      const { journal } = applyAll(root, ['packages']);
      const bunfig = journal.changes.findLast((change) => change.file === 'bunfig.toml');
      expect(bunfig).toBeDefined();
      const parsed = Bun.TOML.parse(bunfig.after);
      const preload = parsed.test.preload.join(',');
      expect(preload).toContain('./a.ts');
      expect(preload).toContain('./b.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not list the same preload twice when two configs name it', () => {
    const root = project({
      'vitest.config.ts': "export default { test: { setupFiles: ['./test/setup.ts'] } };",
      'vitest.workspace.ts': "export default { test: { setupFiles: ['./test/setup.ts'] } };",
      'test/setup.ts': '',
    });
    try {
      const { journal } = applyAll(root, ['packages']);
      const bunfig = journal.changes.findLast((change) => change.file === 'bunfig.toml');
      const preload = Bun.TOML.parse(bunfig.after).test.preload;
      expect(preload.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * A project that already lists preloads must keep loading them. Measured before
   * this was handled, `preload = ["./my-own-setup.ts"]` in an existing `bunfig.toml`
   * came out as `preload = ["./bun-migrate.timeout.ts"]` — the project's own setup
   * file stopped running and the migration report said nothing about it.
   */
  it('keeps the preloads an existing bunfig.toml already lists', () => {
    const root = project({
      'bunfig.toml': '[test]\npreload = ["./my-own-setup.ts"]\nsmol = true\n',
      'my-own-setup.ts': '',
      'vitest.config.ts': 'export default { test: { testTimeout: 500 } };',
    });
    try {
      const { journal } = applyAll(root, ['packages']);
      const bunfig = journal.changes.findLast((change) => change.file === 'bunfig.toml');
      const parsed = Bun.TOML.parse(bunfig.after);
      expect(parsed.test.preload.join(',')).toBe(`./my-own-setup.ts,./${TIMEOUT_PRELOAD}`);
      expect(parsed.test.smol).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * A wrapped array is one value spanning several lines. Replacing only its first
   * line left the rest behind as orphan text, which is not valid TOML — measured, the
   * output was the new one-line `preload` followed by a dangling `"./a.ts",` and `]`,
   * and `Bun.TOML.parse` rejected it.
   */
  it('replaces a wrapped preload array instead of leaving its tail behind', () => {
    const root = project({
      'bunfig.toml': '[test]\npreload = [\n  "./a.ts",\n  "./b.ts",\n]\nsmol = true\n',
      'a.ts': '',
      'b.ts': '',
      'vitest.config.ts': 'export default { test: { testTimeout: 500 } };',
    });
    try {
      const { journal } = applyAll(root, ['packages']);
      const bunfig = journal.changes.findLast((change) => change.file === 'bunfig.toml');
      const parsed = Bun.TOML.parse(bunfig.after);
      expect(parsed.test.preload.join(',')).toBe(`./a.ts,./b.ts,./${TIMEOUT_PRELOAD}`);
      expect(parsed.test.smol).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads a single-quoted preload array', () => {
    const root = project({
      'bunfig.toml': "[test]\npreload = ['./a.ts']\n",
      'a.ts': '',
      'vitest.config.ts': 'export default { test: { testTimeout: 500 } };',
    });
    try {
      const { journal } = applyAll(root, ['packages']);
      const bunfig = journal.changes.findLast((change) => change.file === 'bunfig.toml');
      expect(Bun.TOML.parse(bunfig.after).test.preload.join(',')).toBe(
        `./a.ts,./${TIMEOUT_PRELOAD}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the generated preload makes the migrated suite enforce the timeout', () => {
    const root = project({
      'vitest.config.ts': "export default { test: { testTimeout: 100, include: ['*.test.ts'] } };",
      'slow.test.ts':
        "import { it, expect } from 'bun:test';\nit('slow', async () => { await Bun.sleep(400); expect(1).toBe(1); });\n",
    });
    try {
      const { journal } = applyAll(root, ['packages']);
      for (const change of journal.changes) {
        if (change.kind !== 'edit' && change.kind !== 'create') continue;
        writeFileSync(join(root, change.file), change.after, 'utf8');
      }
      const result = Bun.spawnSync(['bun', 'test'], { cwd: root });
      const output = `${result.stdout.toString()}${result.stderr.toString()}`;
      expect(output).toContain('timed out after 100ms');
      expect(result.exitCode).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('maxWorkers becomes --parallel in the test script', () => {
  it('reads a literal maxWorkers', () => {
    expect(portVitestConfig('export default { test: { maxWorkers: 4 } };').parallel).toBe(4);
  });

  it('adds the flag to a migrated bun test script', () => {
    const root = project({
      'package.json': '{"name":"p","version":"1.0.0","scripts":{"test":"vitest run"}}\n',
      'vitest.config.ts': 'export default { test: { maxWorkers: 4 } };',
    });
    try {
      const { journal } = applyAll(root, ['config', 'packages']);
      const manifest = journal.changes.findLast((change) => change.file === 'package.json');
      expect(manifest).toBeDefined();
      expect(manifest.after).toContain('bun test --parallel=4');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not stack the flag on a second run', () => {
    const root = project({
      'package.json': '{"name":"p","version":"1.0.0","scripts":{"test":"vitest run"}}\n',
      'vitest.config.ts': 'export default { test: { maxWorkers: 2 } };',
    });
    try {
      const { journal } = applyAll(root, ['config', 'packages']);
      const staged = journal.changes.findLast((change) => change.file === 'package.json');
      writeFileSync(join(root, 'package.json'), staged.after, 'utf8');
      const second = applyAll(root, ['packages']);
      const again = second.journal.changes.filter((change) => change.file === 'package.json');
      expect(again.length).toBe(0);
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('bun test --parallel=2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a pool setting, which has no bun equivalent', () => {
    const ported = portVitestConfig("export default { test: { pool: 'forks' } };");
    expect(ported.unported.join(' ')).toContain('pool');
  });

  it('names a test setting it does not know instead of deleting it silently', () => {
    const ported = portVitestConfig("export default { test: { exclude: ['**/e2e/**'] } };");
    expect(ported.unported.join(' ')).toContain('exclude');
  });

  it('reports a computed setupFiles or timeout rather than dropping it', () => {
    const setup = portVitestConfig(
      "const setup = './setup.ts';\nexport default { test: { setupFiles: setup } };",
    );
    expect(setup.unported.join(' ')).toContain('setupFiles');
    const timeout = portVitestConfig('export default { test: { testTimeout: TIMEOUT } };');
    expect(timeout.unported.join(' ')).toContain('testTimeout');
  });

  it('carries the unknown setting into the removal reason', () => {
    const root = project({
      'vitest.config.ts': "export default { test: { exclude: ['**/e2e/**'] } };",
    });
    try {
      const { journal } = applyAll(root, ['packages']);
      const removal = journal.changes.find(
        (item) => item.file === 'vitest.config.ts' && item.kind === 'remove',
      );
      expect(removal).toBeDefined();
      expect(removal.detail).toContain('exclude');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('monorepo vitest configs are rebased and reconciled', () => {
  it('rewrites each package setupFiles relative to the root and reports per-package timeouts', () => {
    const root = project({
      'packages/a/vitest.config.ts':
        "export default { test: { setupFiles: ['test/setup.ts'], testTimeout: 15000 } };",
      'packages/a/test/setup.ts': 'export {};\n',
      'packages/b/vitest.config.ts':
        "export default { test: { setupFiles: ['./test/setup.ts'], testTimeout: 30000 } };",
      'packages/b/test/setup.ts': 'export {};\n',
    });
    try {
      const { journal } = applyAll(root, ['packages']);
      const bunfig = journal.changes.find(
        (item) => item.file === 'bunfig.toml' && item.kind === 'edit',
      );
      const preload = Bun.TOML.parse(bunfig.after).test.preload;
      expect(preload).toContain('./packages/a/test/setup.ts');
      expect(preload).toContain('./packages/b/test/setup.ts');
      expect(preload).not.toContain('./bun-migrate.timeout.ts');
      expect(journal.changes.some((item) => item.file === 'bun-migrate.timeout.ts')).toBe(false);
      const skipped = journal.layers().flatMap((layer) => layer.skipped);
      expect(
        skipped.some(
          (item) =>
            item.reason.includes('15000') && item.reason.includes('no global timeout was set'),
        ),
      ).toBe(true);
      expect(
        skipped.some(
          (item) =>
            item.reason.includes('30000') && item.reason.includes('no global timeout was set'),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('workspace member scripts are rewritten like the root', () => {
  it('rewrites a member test script and leaves a non-member fixture alone', () => {
    const root = project({
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'packages/a/package.json': JSON.stringify({
        name: 'a',
        version: '1.0.0',
        scripts: { test: 'vitest run', build: 'pnpm run compile' },
      }),
      'packages/a/src/x.ts': 'export const x = 1;\n',
      'packages/a/test/fixtures/pkg/package.json': JSON.stringify({
        name: 'fixture',
        scripts: { test: 'vitest run' },
      }),
      'packages/a/test/fixtures/pkg/fixture.ts': 'export const f = 1;\n',
    });
    try {
      const { journal } = applyAll(root, ['config']);
      const member = journal.changes.find(
        (item) => item.file === 'packages/a/package.json' && item.kind === 'edit',
      );
      const parsed = JSON.parse(member.after);
      expect(parsed.scripts.test).toBe('bun test');
      expect(parsed.scripts.build).toBe('bun run compile');
      expect(
        journal.changes.some((item) => item.file === 'packages/a/test/fixtures/pkg/package.json'),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('package imports are mirrored into tsconfig paths', () => {
  it('adds the mapping to an existing tsconfig and preserves its comments', () => {
    const root = project({
      'packages/a/package.json': JSON.stringify({ name: 'a', imports: { '#/*': './src/*.ts' } }),
      'packages/a/tsconfig.json':
        '{\n  // keep me\n  "compilerOptions": {\n    "strict": true\n  }\n}\n',
      'packages/a/src/foo.ts': 'export const x = 1;\n',
    });
    try {
      const { journal } = applyAll(root, ['packages']);
      const change = journal.changes.find((item) => item.file === 'packages/a/tsconfig.json');
      expect(change).toBeDefined();
      const parsed = Bun.JSONC.parse(change.after);
      expect(parsed.compilerOptions.baseUrl).toBe('.');
      expect(parsed.compilerOptions.paths['#/*']).toEqual(['./src/*.ts']);
      expect(parsed.compilerOptions.strict).toBe(true);
      expect(change.after).toContain('keep me');
      journal.commit(root);

      const second = applyAll(root, ['packages']);
      expect(second.journal.changes.some((item) => item.file === 'packages/a/tsconfig.json')).toBe(
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a tsconfig for a nested package boundary with its own imports', () => {
    const root = project({
      'packages/a/package.json': JSON.stringify({ name: 'a', imports: { '#/*': './src/*.ts' } }),
      'packages/a/tsconfig.json': '{"compilerOptions":{}}\n',
      'packages/a/src/human/package.json': JSON.stringify({ imports: { '#/*': './*.ts' } }),
      'packages/a/src/human/x.ts': 'export const x = 1;\n',
    });
    try {
      const { journal } = applyAll(root, ['packages']);
      const created = journal.changes.find(
        (item) => item.file === 'packages/a/src/human/tsconfig.json',
      );
      expect(created).toBeDefined();
      const parsed = Bun.JSONC.parse(created.after);
      expect(parsed.compilerOptions.paths['#/*']).toEqual(['./*.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports an existing paths block instead of overwriting it', () => {
    const root = project({
      'packages/a/package.json': JSON.stringify({ name: 'a', imports: { '#/*': './src/*.ts' } }),
      'packages/a/tsconfig.json':
        '{"compilerOptions":{"baseUrl":".","paths":{"#already/*":["./already/*.ts"]}}}\n',
      'packages/a/src/foo.ts': 'export const x = 1;\n',
    });
    try {
      const { journal } = applyAll(root, ['packages']);
      const skipped = journal.layers().flatMap((layer) => layer.skipped);
      expect(
        skipped.some((item) => item.reason.includes('compilerOptions.paths already exists')),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('pnpm workspace keys are translated or reported', () => {
  it('keeps the file and names an untranslated key', () => {
    const root = project({
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\nonlyBuiltDependencies:\n  - esbuild\n",
    });
    try {
      const { journal } = applyAll(root, ['packages']);
      expect(
        journal.changes.some(
          (item) => item.file === 'pnpm-workspace.yaml' && item.kind === 'remove',
        ),
      ).toBe(false);
      const skipped = journal.layers().flatMap((layer) => layer.skipped);
      expect(skipped.some((item) => item.reason.includes('onlyBuiltDependencies'))).toBe(true);
      const manifest = journal.changes.find(
        (item) => item.file === 'package.json' && item.kind === 'edit',
      );
      expect(JSON.parse(manifest.after).workspaces.packages).toEqual(['packages/*']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('node: gap detection resolves a binding instead of matching text', () => {
  const gaps = activeGaps();

  const detect = (source) => findMissingUsages(source, gaps, parse('probe.ts', source));

  it('ignores a mention in a comment', () => {
    expect(detect('// registerHooks( is missing\n').length).toBe(0);
  });

  it('ignores a mention in a string literal', () => {
    expect(detect("const message = 'call diff(a, b) to compare';\n").length).toBe(0);
  });

  it('ignores a local function with the same name', () => {
    expect(detect('function registerHooks() {}\nregisterHooks();\n').length).toBe(0);
  });

  it('ignores a same-named export of another package', () => {
    expect(detect("import { diff } from 'diff';\ndiff(a, b);\n").length).toBe(0);
  });

  it('finds the call through a namespace import', () => {
    const hits = detect("import * as util from 'node:util';\nutil.diff(a, b);\n");
    expect(hits.some((hit) => hit.module === 'node:util' && hit.member === 'diff')).toBe(true);
  });

  it('finds the call through an aliased import', () => {
    const hits = detect("import { registerHooks as rh } from 'node:module';\nrh();\n");
    expect(hits.some((hit) => hit.member === 'registerHooks')).toBe(true);
  });

  it('finds the call through require(...)', () => {
    const hits = detect("const m = require('node:module');\nm.findPackageJSON('x');\n");
    expect(hits.some((hit) => hit.member === 'findPackageJSON')).toBe(true);
  });

  it('finds the call through a destructured require', () => {
    const hits = detect("const { diff } = require('node:util');\ndiff(a, b);\n");
    expect(hits.some((hit) => hit.member === 'diff')).toBe(true);
  });

  it('finds a nested constant through a named constants import', () => {
    const synthetic = [{ module: 'node:http2', member: 'constants.NGHTTP2_HCAT_REQUEST' }];
    const hits = findMissingUsages(
      "import { constants } from 'node:http2';\nexport const x = constants.NGHTTP2_HCAT_REQUEST;\n",
      synthetic,
      parse(
        'probe.ts',
        "import { constants } from 'node:http2';\nexport const x = constants.NGHTTP2_HCAT_REQUEST;\n",
      ),
    );
    expect(hits.length).toBe(1);
  });

  it('finds a nested constant through a namespace import', () => {
    const synthetic = [{ module: 'node:http2', member: 'constants.NGHTTP2_HCAT_REQUEST' }];
    const source =
      "import * as http2 from 'node:http2';\nexport const x = http2.constants.NGHTTP2_HCAT_REQUEST;\n";
    const hits = findMissingUsages(source, synthetic, parse('probe.ts', source));
    expect(hits.length).toBe(1);
  });

  it('collectRequireBindings maps a whole-module require', () => {
    const bindings = collectRequireBindings(parse('p.ts', "const m = require('node:module');\n"));
    expect(bindings.namespaceByLocal.get('m')).toBe('node:module');
  });

  it('collectRequireBindings ignores a non-node require', () => {
    const bindings = collectRequireBindings(parse('p.ts', "const m = require('diff');\n"));
    expect(bindings.namespaceByLocal.size).toBe(0);
  });

  it('the layer reports a real call and stays quiet on a comment', () => {
    const root = project({
      'src/real.js': "import { registerHooks } from 'node:module';\nregisterHooks();\n",
      'src/comment.js': '// registerHooks( is missing in this Bun\n',
    });
    try {
      const { journal } = applyAll(root, ['source']);
      const files = new Set(
        journal
          .layers()
          .flatMap((layer) => layer.skipped)
          .map((item) => item.file),
      );
      expect(files.has('src/real.js')).toBe(true);
      expect(files.has('src/comment.js')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the CI workflow layer actually runs', () => {
  const WORKFLOW = [
    'name: CI',
    'on: [push]',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: pnpm/action-setup@v4',
    '        with:',
    '          version: 9',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 20',
    '          cache: pnpm',
    '      - run: pnpm install',
    '      - run: pnpm run build',
    '',
  ].join('\n');

  it('collects a workflow file at all', () => {
    const root = project({ '.github/workflows/ci.yml': WORKFLOW });
    try {
      const { loaded } = applyAll(root, ['config']);
      expect(loaded.ciFiles.includes('.github/workflows/ci.yml')).toBe(true);
      expect(loaded.files.includes('.github/workflows/ci.yml')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites the workflow and the result still parses as YAML', () => {
    const root = project({ '.github/workflows/ci.yml': WORKFLOW });
    try {
      const { journal } = applyAll(root, ['config']);
      const change = journal.changes.find((item) => item.file === '.github/workflows/ci.yml');
      expect(change).toBeDefined();
      const parsed = Bun.YAML.parse(change.after);
      expect(Array.isArray(parsed.jobs.test.steps)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops setup-node and pnpm/action-setup, and adds setup-bun once', () => {
    const root = project({ '.github/workflows/ci.yml': WORKFLOW });
    try {
      const { journal } = applyAll(root, ['config']);
      const after = journal.changes.find((item) => item.file === '.github/workflows/ci.yml').after;
      expect(after.includes('actions/setup-node')).toBe(false);
      expect(after.includes('pnpm/action-setup')).toBe(false);
      const bunSteps = after.split('\n').filter((line) => line.includes('oven-sh/setup-bun'));
      expect(bunSteps.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not give a surviving step the with block of a deleted one', () => {
    const root = project({ '.github/workflows/ci.yml': WORKFLOW });
    try {
      const { journal } = applyAll(root, ['config']);
      const after = journal.changes.find((item) => item.file === '.github/workflows/ci.yml').after;
      const parsed = Bun.YAML.parse(after);
      const checkout = parsed.jobs.test.steps.find((step) =>
        String(step.uses ?? '').includes('checkout'),
      );
      expect(checkout).toBeDefined();
      expect(checkout.with).toBeUndefined();
      const bun = parsed.jobs.test.steps.find((step) =>
        String(step.uses ?? '').includes('setup-bun'),
      );
      expect(bun.with['bun-version']).toBe('latest');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites the package-manager invocations in the surviving steps', () => {
    const root = project({ '.github/workflows/ci.yml': WORKFLOW });
    try {
      const { journal } = applyAll(root, ['config']);
      const after = journal.changes.find((item) => item.file === '.github/workflows/ci.yml').after;
      expect(after.includes('bun install')).toBe(true);
      expect(after.includes('bun run build')).toBe(true);
      expect(/\bpnpm\b/.test(after)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites a run step that uses npx, the way package.json would', () => {
    const root = project({
      '.github/workflows/ci.yml': [
        'jobs:',
        '  test:',
        '    steps:',
        '      - uses: actions/setup-node@v4',
        '      - run: npx vitest run',
        '',
      ].join('\n'),
    });
    try {
      const { journal } = applyAll(root, ['config']);
      const after = journal.changes.find((item) => item.file === '.github/workflows/ci.yml').after;
      expect(after.includes('run: bun test')).toBe(true);
      expect(after.includes('vitest')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles a workflow file with CRLF line endings', () => {
    const crlf = [
      'jobs:',
      '  test:',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '      - run: npm install',
      '      - run: npx vitest run',
      '',
    ].join('\r\n');
    const root = project({ '.github/workflows/ci.yml': crlf });
    try {
      const { journal } = applyAll(root, ['config']);
      const after = journal.changes.find((item) => item.file === '.github/workflows/ci.yml')?.after;
      expect(after).toBeDefined();
      expect(after.includes('run: bun install')).toBe(true);
      expect(after.includes('run: bun test')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves a workflow without a steps block alone and says so', () => {
    const root = project({
      '.github/workflows/odd.yml': 'name: Odd\non: [push]\nuses: actions/setup-node@v4\n',
    });
    try {
      const { journal } = applyAll(root, ['config']);
      const skipped = journal.layers().flatMap((layer) => layer.skipped);
      expect(skipped.some((item) => item.file === '.github/workflows/odd.yml')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not touch a workflow that never used Node setup', () => {
    const original = 'name: X\non: [push]\n';
    const root = project({ '.github/workflows/x.yml': original });
    try {
      const { journal } = applyAll(root, ['config']);
      expect(journal.changes.some((item) => item.file === '.github/workflows/x.yml')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * `pnpm/action-setup` is deleted, so a bare `pnpm <script>` step loses its
   * binary in the same run. Measured before the rule existed: the workflow came
   * out with `pnpm: command not found` waiting one CI run away. The rule covers
   * the `pnpm <script>` form everywhere scripts are rewritten, which also fixes
   * the `pnpm vitest run` shape a script can carry.
   */
  it('rewrites a bare pnpm script invocation the setup step no longer provides', () => {
    const root = project({
      '.github/workflows/ci.yml': WORKFLOW.replace('pnpm run build', 'pnpm build'),
    });
    try {
      const { journal } = applyAll(root, ['config']);
      const after = journal.changes.find((item) => item.file === '.github/workflows/ci.yml').after;
      expect(after.includes('pnpm build')).toBe(false);
      expect(after).toContain('run: bun run build');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * A workflow that already pins a Bun version keeps that pin. The step loop
   * deletes every setup step it rewrites, including an existing setup-bun, so
   * re-adding `bun-version: latest` would silently loosen a `bun-version:
   * 1.2.3` pin. The deleted step's own `with:` block is re-emitted verbatim.
   */
  it('keeps an existing setup-bun step with its pinned version', () => {
    const root = project({
      '.github/workflows/ci.yml': [
        'name: CI',
        'on: [push]',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: oven-sh/setup-bun@v2',
        '        with:',
        '          bun-version: 1.2.3',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 20',
        '      - run: npm ci',
        '',
      ].join('\n'),
    });
    try {
      const { journal } = applyAll(root, ['config']);
      const after = journal.changes.find((item) => item.file === '.github/workflows/ci.yml').after;
      expect(after.match(/setup-bun/g)?.length).toBe(1);
      expect(after).toContain('bun-version: 1.2.3');
      expect(after.includes('bun-version: latest')).toBe(false);
      expect(after.includes('actions/setup-node')).toBe(false);
      expect(after).toContain('run: bun install');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Unit-level pin for the bare `pnpm <script>` rule. The more specific forms
   * are matched by earlier rules, so what reaches this one must be exactly a
   * script name — and the specific rules' outputs must not be re-eaten by it
   * (`bun install` was produced by the `pnpm install` rule; a second pass would
   * turn it into `bun run install`).
   *
   * The pipeline under test is the one `applyConfigLayer` runs: the runner
   * table on the raw script, then `rewriteScript`. `pnpm --version` stays
   * untouched because neither table claims a flag-looking word, which is the
   * deliberate outcome — the CI block's npm handling and this table are the
   * only rewriters, and a `pnpm --version` step is rare enough to leave for the
   * report instead of guessing at it.
   */
  it('rewrites only a bare script name after pnpm, never a flag or a subcommand', () => {
    const pipeline = (script) => rewriteScript(rewriteTestRunnerScript(script).script);
    expect(pipeline('pnpm build')).toBe('bun run build');
    expect(pipeline('pnpm test:ci')).toBe('bun run test:ci');
    expect(pipeline('pnpm --version')).toBe('pnpm --version');
    expect(pipeline('pnpm -r build')).toBe('bun run --filter "*" build');
    expect(pipeline('pnpm install')).toBe('bun install');
    expect(pipeline('pnpm run build')).toBe('bun run build');
    expect(pipeline('eslint . && pnpm build')).toBe('eslint . && bun run build');
    expect(pipeline('bun install && pnpm build')).toBe('bun install && bun run build');
  });

  it('rewrites pnpm vitest run as a runner replacement, not a script name', () => {
    const pipeline = (script) => rewriteScript(rewriteTestRunnerScript(script).script);
    expect(pipeline('pnpm vitest run --coverage')).toBe('bun test --coverage');
  });

  it('rewrites the specific recursive filter form exactly once', () => {
    const pipeline = (script) => rewriteScript(rewriteTestRunnerScript(script).script);
    expect(pipeline("pnpm -r --filter './packages/*' run build")).toBe(
      "bun run --filter './packages/*' build",
    );
    expect(pipeline('pnpm -r --filter pkg build')).toBe('bun run --filter pkg build');
  });

  it('rewrites a bare npm script but not an npm operation', () => {
    const pipeline = (script) => rewriteScript(rewriteTestRunnerScript(script).script);
    expect(pipeline('npm test')).toBe('bun run test');
    expect(pipeline('npm t')).toBe('bun run test');
    expect(pipeline('npm start')).toBe('bun run start');
    expect(pipeline('npm ci')).toBe('bun install');
    expect(pipeline('npm publish')).toBe('npm publish');
    expect(pipeline('pnpm publish')).toBe('pnpm publish');
  });

  it('gives every job that lost its Node step a Bun step', () => {
    const workflow = [
      'jobs:',
      '  lint:',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '      - run: npm ci',
      '  test:',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: actions/setup-node@v4',
      '      - run: npm test',
      '',
    ].join('\n');
    const root = project({ '.github/workflows/ci.yml': workflow });
    try {
      const { journal } = applyAll(root, ['config']);
      const after = journal.changes.find((item) => item.file === '.github/workflows/ci.yml').after;
      const parsed = Bun.YAML.parse(after);
      for (const job of ['lint', 'test']) {
        const steps = parsed.jobs[job].steps;
        expect(steps.some((step) => String(step.uses ?? '').includes('setup-bun'))).toBe(true);
        expect(steps.some((step) => String(step.uses ?? '').includes('setup-node'))).toBe(false);
      }
      expect(after.includes('npm ci')).toBe(false);
      expect(after.includes('npm test')).toBe(false);
      expect(after).toContain('bun install');
      expect(after).toContain('bun run test');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites commands inside a run block scalar', () => {
    const workflow = [
      'jobs:',
      '  test:',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '      - run: |',
      '          npm ci',
      '          npm test',
      '          npx vitest run',
      '',
    ].join('\n');
    const root = project({ '.github/workflows/ci.yml': workflow });
    try {
      const { journal } = applyAll(root, ['config']);
      const after = journal.changes.find((item) => item.file === '.github/workflows/ci.yml').after;
      expect(after).toContain('bun install');
      expect(after).toContain('bun run test');
      expect(after).toContain('bun test');
      expect(/\bnpm\b/.test(after)).toBe(false);
      expect(after.includes('npx')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('an .npmrc key the migration does not map is reported, not dropped', () => {
  it('reports every unmapped key before the file is removed', () => {
    const root = project({
      '.npmrc': [
        'registry=https://example.test',
        'proxy=http://proxy.example.test:8080',
        '//registry.example.test/:_authToken=npm-TOKEN',
        '',
      ].join('\n'),
    });
    try {
      const { journal } = applyAll(root, ['config']);
      const skipped = journal.layers().flatMap((layer) => layer.skipped);
      expect(skipped.some((item) => item.reason.includes('proxy'))).toBe(true);
      expect(skipped.some((item) => item.reason.includes('_authToken'))).toBe(true);
      // The removal is still proposed — the point is that the journal now says
      // what was lost instead of deleting the credentials silently.
      expect(journal.changes.some((item) => item.file === '.npmrc' && item.kind === 'remove')).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a line without an = sign by its content', () => {
    const root = project({ '.npmrc': 'registry=https://example.test\njust-a-word\n' });
    try {
      const { journal } = applyAll(root, ['config']);
      const skipped = journal.layers().flatMap((layer) => layer.skipped);
      expect(skipped.some((item) => item.reason.includes('just-a-word'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not double-report keys the mapping table already handled', () => {
    const root = project({ '.npmrc': 'registry=https://example.test\nstrict-ssl=false\n' });
    try {
      const { journal } = applyAll(root, ['config']);
      const skipped = journal.layers().flatMap((layer) => layer.skipped);
      const registryReports = skipped.filter(
        (item) => item.reason.includes('registry:') || item.reason.includes('registry '),
      );
      expect(registryReports.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses a quoted registry value before writing it to bunfig.toml', () => {
    const root = project({ '.npmrc': 'registry="https://r.example/"\n' });
    try {
      const { journal } = applyAll(root, ['config']);
      const bunfig = journal.changes.find((item) => item.file === 'bunfig.toml');
      expect(bunfig).toBeDefined();
      expect(Bun.TOML.parse(bunfig.after).install.registry).toBe('https://r.example/');
      expect(journal.changes.some((item) => item.file === '.npmrc' && item.kind === 'remove')).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves .npmrc in place when the merged bunfig would be invalid', () => {
    const root = project({
      '.npmrc': 'registry=https://r.example/\n',
      'bunfig.toml': '[install\n',
    });
    try {
      const { journal } = applyAll(root, ['config']);
      expect(journal.changes.some((item) => item.file === '.npmrc' && item.kind === 'remove')).toBe(
        false,
      );
      expect(
        journal.changes.some((item) => item.file === 'bunfig.toml' && item.kind === 'skip'),
      ).toBe(false);
      const skipped = journal.layers().flatMap((layer) => layer.skipped);
      expect(skipped.some((item) => item.reason.includes('valid TOML'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a node-linker value Bun cannot implement', () => {
    const root = project({ '.npmrc': 'node-linker=pnp\n' });
    try {
      const { journal } = applyAll(root, ['config']);
      const skipped = journal.layers().flatMap((layer) => layer.skipped);
      expect(skipped.some((item) => item.reason.includes('node-linker=pnp'))).toBe(true);
      expect(journal.changes.some((item) => item.file === 'bunfig.toml')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('importing the CLI module has no side effects', () => {
  it('does not scan or write when the module is imported', () => {
    const root = project({});
    try {
      const cli = join(import.meta.dir, '..', 'src', 'cli.mjs');
      const result = Bun.spawnSync(['bun', '-e', `import(${JSON.stringify(cli)})`], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe('');
      expect(result.stderr.toString()).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('nothing here writes through to disk during the test', () => {
  it('leaves the project untouched because the layers only journal', () => {
    const original = 'name: CI\non: [push]\n    steps:\n      - uses: actions/setup-node@v4\n';
    const root = project({ '.github/workflows/ci.yml': original });
    try {
      applyAll(root, ['config', 'packages', 'source']);
      expect(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
