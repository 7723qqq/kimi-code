import { afterAll, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkArchitecture } from './check-architecture-drift.mjs';

/**
 * Every workspace this file created. Without this the suite leaks one temp
 * directory per test on every run, and when `TMPDIR` happens to point inside
 * the repo (CI shims, a dev with `TMP` redirected) those fixtures turn into
 * untracked files and get linted — the suite would then fail `oxlint` with
 * errors in files it generated.
 */
const createdWorkspaces = [];

afterAll(() => {
    for (const dir of createdWorkspaces.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const baseModel = {
  modules: [
    { id: 'app', source: 'apps/x/src', layer: 'app', deps: ['sdk'] },
    { id: 'sdk', source: 'packages/y/src', layer: 'sdk', deps: ['engine'] },
    { id: 'engine', source: 'packages/z/src', layer: 'engine', deps: [] },
  ],
  rules: {
    layerOrder: ['app', 'sdk', 'engine'],
    forbid: [{ from: 'engine', to: 'app', reason: 'engine 不依赖 app' }],
    acyclic: true,
  },
};

/** Diagnostics of one kind, for readable assertions. */
const withCode = (diags, code) => diags.filter((d) => d.code === code);

/**
 * A throwaway workspace: `layout` maps a relative dir to the package name it
 * declares, `files` maps a relative file to its contents. The root
 * package.json lists `packages/*` and `apps/*`, which is the membership the
 * gate reads workspace packages from.
 */
function makeWorkspace({ packages = {}, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'arch-drift-'));
  createdWorkspaces.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'fixture-root', private: true, workspaces: { packages: ['packages/*', 'apps/*'] } }, null, 2)}\n`,
  );
  for (const [rel, name] of Object.entries(packages)) {
    mkdirSync(join(dir, rel), { recursive: true });
    writeFileSync(join(dir, rel, 'package.json'), `${JSON.stringify({ name, version: '0.0.0' }, null, 2)}\n`);
  }
  for (const [rel, contents] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, contents);
  }
  return dir;
}

test('passes when the model is consistent', async () => {
  const diags = await checkArchitecture(baseModel, '/nonexistent-root');
  const depErrors = diags.filter((d) => d.code.startsWith('deps/'));
  expect(depErrors).toHaveLength(0);
});

test('detects undeclared dependency target', async () => {
  const model = {
    ...baseModel,
    modules: [{ id: 'app', source: 'a', layer: 'app', deps: ['ghost'] }],
  };
  const diags = await checkArchitecture(model, '/nonexistent-root');
  expect(withCode(diags, 'deps/undeclared-target').some((d) => d.subject === 'app')).toBe(true);
});

test('detects layer-order violation', async () => {
  const model = {
    ...baseModel,
    modules: [
      { id: 'app', source: 'a', layer: 'app', deps: [] },
      { id: 'engine', source: 'e', layer: 'engine', deps: ['app'] },
    ],
  };
  const diags = await checkArchitecture(model, '/nonexistent-root');
  expect(withCode(diags, 'deps/layer-violation').some((d) => d.subject === 'engine')).toBe(true);
});

test('detects circular dependency', async () => {
  const model = {
    ...baseModel,
    modules: [
      { id: 'a', source: 'a', layer: 'app', deps: ['b'] },
      { id: 'b', source: 'b', layer: 'sdk', deps: ['a'] },
    ],
  };
  const diags = await checkArchitecture(model, '/nonexistent-root');
  expect(withCode(diags, 'deps/cycle').some((d) => d.subject === 'a')).toBe(true);
});

test('detects missing source directory', async () => {
  const diags = await checkArchitecture(baseModel, '/nonexistent-root');
  expect(withCode(diags, 'structure/missing-source').some((d) => d.subject === 'app')).toBe(true);
});

test('detects fingerprint drift', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arch-drift-'));
  createdWorkspaces.push(dir);
  const src = join(dir, 'src');
  mkdirSync(src);
  writeFileSync(join(src, 'index.ts'), 'const x = 1;\n');
  // Compute the fingerprint the same way the checker does.
  const hash = createHash('sha256');
  hash.update('index.ts');
  hash.update(readFileSync(join(src, 'index.ts')));
  const fp = hash.digest('hex').slice(0, 16);
  // Mutate the file after fingerprinting.
  writeFileSync(join(src, 'index.ts'), 'const x = 2;\n');
  const model = {
    ...baseModel,
    modules: [{ id: 'engine', source: src, layer: 'engine', deps: [], fingerprint: fp }],
  };
  const diags = await checkArchitecture(model, dir);
  expect(withCode(diags, 'drift/fingerprint').some((d) => d.subject === 'engine')).toBe(true);
});

// ── Check B: the code half (import scan) ────────────────────────────────────

/** Two workspace packages, `app` declaring a dep on `engine`, as the model says. */
function twoPackageModel(appSource, appDeps = ['engine']) {
  return {
    modules: [
      { id: 'app', name: 'app', source: 'apps/app/src', layer: 'app', deps: appDeps },
      { id: 'engine', name: 'engine', source: 'packages/engine/src', layer: 'engine', deps: [] },
    ],
    rules: { layerOrder: ['app', 'engine'], forbid: [], acyclic: true },
  };
}

test('accepts a declared workspace import', async () => {
  const dir = makeWorkspace({
    packages: { 'apps/app': '@x/app', 'packages/engine': '@x/engine' },
    files: { 'apps/app/src/main.ts': "import { engine } from '@x/engine';\nexport const run = engine;\n" },
  });
  const diags = await checkArchitecture(twoPackageModel(), dir);
  expect(withCode(diags, 'deps/undeclared-import')).toHaveLength(0);
});

test('detects an undeclared workspace import', async () => {
  const dir = makeWorkspace({
    packages: { 'apps/app': '@x/app', 'packages/engine': '@x/engine' },
    files: { 'apps/app/src/main.ts': "import { engine } from '@x/engine';\n" },
  });
  const diags = await checkArchitecture(twoPackageModel('apps/app/src', []), dir);
  const hits = withCode(diags, 'deps/undeclared-import');
  expect(hits).toHaveLength(1);
  expect(hits[0].subject).toBe('app');
  expect(hits[0].evidence).toContain('@x/engine');
  expect(hits[0].evidence).toContain('main.ts:1');
});

test('downgrades an exempted edge to a warning instead of dropping it', async () => {
  // A soft dependency — an optional native module behind a try/catch require —
  // must not be declared in `deps`, or the model lies whenever the fallback path
  // is the one that runs. `exemptions` records it; the gate keeps it visible.
  const dir = makeWorkspace({
    packages: { 'apps/app': '@x/app', 'packages/engine': '@x/engine' },
    files: { 'apps/app/src/main.ts': "import { engine } from '@x/engine';\n" },
  });
  const model = {
    ...twoPackageModel('apps/app/src', []),
    exemptions: [{ from: 'app', to: 'engine', reason: 'optional native module, pure-JS fallback' }],
  };
  const diags = await checkArchitecture(model, dir);
  const hits = withCode(diags, 'deps/undeclared-import');
  expect(hits).toHaveLength(1);
  expect(hits[0].severity).toBe('warning');
  expect(hits[0].evidence).toContain('pure-JS fallback');
});

test('an exemption does not leak to a different target or subject', async () => {
  const dir = makeWorkspace({
    packages: { 'apps/app': '@x/app', 'packages/engine': '@x/engine' },
    files: { 'apps/app/src/main.ts': "import { engine } from '@x/engine';\n" },
  });
  const model = {
    ...twoPackageModel('apps/app/src', []),
    exemptions: [{ from: 'app', to: 'somewhere-else', reason: 'unrelated edge' }],
  };
  expect(withCode(await checkArchitecture(model, dir), 'deps/undeclared-import')[0].severity).toBe('error');
});

test('counts a subpath import as a dep on the package, not as an unknown edge', async () => {
  const dir = makeWorkspace({
    packages: { 'apps/app': '@x/app', 'packages/engine': '@x/engine' },
    files: { 'apps/app/src/main.ts': "const m = require('@x/engine/native');\nexport default m;\n" },
  });
  expect(withCode(await checkArchitecture(twoPackageModel(), dir), 'deps/undeclared-import')).toHaveLength(0);
  expect(
    withCode(await checkArchitecture(twoPackageModel('apps/app/src', []), dir), 'deps/undeclared-import'),
  ).toHaveLength(1);
});

test('detects a dynamic import too', async () => {
  const dir = makeWorkspace({
    packages: { 'apps/app': '@x/app', 'packages/engine': '@x/engine' },
    files: { 'apps/app/src/main.ts': "export const load = () => import('@x/engine');\n" },
  });
  expect(withCode(await checkArchitecture(twoPackageModel('apps/app/src', []), dir), 'deps/undeclared-import')).toHaveLength(1);
});

test('detects a workspace package with no module entry in the model', async () => {
  const dir = makeWorkspace({
    packages: { 'apps/app': '@x/app', 'packages/engine': '@x/engine', 'packages/stray': '@x/stray' },
    files: { 'apps/app/src/main.ts': "import { stray } from '@x/stray';\nexport default stray;\n" },
  });
  const hits = withCode(await checkArchitecture(twoPackageModel(), dir), 'deps/unmodeled-import');
  expect(hits).toHaveLength(1);
  expect(hits[0].message).toContain('packages/stray');
});

test('reports one diagnostic per target and counts the extra sites', async () => {
  const dir = makeWorkspace({
    packages: { 'apps/app': '@x/app', 'packages/engine': '@x/engine' },
    files: {
      'apps/app/src/a.ts': "import '@x/engine';\n",
      'apps/app/src/b.ts': "import '@x/engine';\n",
    },
  });
  const hits = withCode(await checkArchitecture(twoPackageModel('apps/app/src', []), dir), 'deps/undeclared-import');
  expect(hits).toHaveLength(1);
  expect(hits[0].evidence).toContain('+1 more site');
});

test('ignores relative, external and self imports', async () => {
  const dir = makeWorkspace({
    packages: { 'apps/app': '@x/app', 'packages/engine': '@x/engine' },
    files: {
      'apps/app/src/main.ts': [
        "import { engine } from '@x/engine';",
        "import { thing } from './thing';",
        "import { other } from '../other';",
        "import { z } from 'zod';",
        "import { fs } from 'node:fs';",
        "import { own } from '@x/app/thing';",
        'export { engine, thing, other, z, fs, own };',
      ].join('\n'),
    },
  });
  expect(withCode(await checkArchitecture(twoPackageModel(), dir), 'deps/undeclared-import')).toHaveLength(0);
});

test('ignores specifiers inside comments', async () => {
  const dir = makeWorkspace({
    packages: { 'apps/app': '@x/app', 'packages/engine': '@x/engine' },
    files: {
      'apps/app/src/main.ts': [
        '/**',
        " * import { engine } from '@x/engine';",
        " * import { stray } from '@x/stray';",
        ' */',
        "import { engine } from '@x/engine';",
        '// import { alsoStray } from "@x/stray";',
        'export { engine };',
      ].join('\n'),
    },
  });
  const diags = await checkArchitecture(twoPackageModel(), dir);
  expect(withCode(diags, 'deps/undeclared-import')).toHaveLength(0);
  expect(withCode(diags, 'deps/unmodeled-import')).toHaveLength(0);
});

test('treats the #/ alias convention as intra-package', async () => {
  const dir = makeWorkspace({
    packages: { 'apps/app': '@x/app', 'packages/engine': '@x/engine' },
    files: { 'apps/app/src/thing.ts': 'export const thing = 1;\n' },
  });
  writeFileSync(
    join(dir, 'apps/app/package.json'),
    `${JSON.stringify({ name: '@x/app', version: '0.0.0', imports: { '#/*': './src/*.ts' } }, null, 2)}\n`,
  );
  writeFileSync(join(dir, 'apps/app/src/main.ts'), "import { thing } from '#/thing';\nexport default thing;\n");
  expect(withCode(await checkArchitecture(twoPackageModel(), dir), 'deps/undeclared-import')).toHaveLength(0);
});

test('rejects an alias that escapes the declared source root', async () => {
  const dir = makeWorkspace({
    packages: { 'apps/app': '@x/app', 'packages/engine': '@x/engine' },
    files: {
      'apps/app/src/index.ts': 'export const app = 1;\n',
      'packages/engine/src/thing.ts': 'export const thing = 1;\n',
    },
  });
  writeFileSync(
    join(dir, 'apps/app/package.json'),
    `${JSON.stringify({ name: '@x/app', version: '0.0.0', imports: { '#/engine': '../../engine/src/thing.ts' } }, null, 2)}\n`,
  );
  writeFileSync(join(dir, 'apps/app/src/main.ts'), "import { thing } from '#/engine';\nexport default thing;\n");
  const hits = withCode(await checkArchitecture(twoPackageModel(), dir), 'deps/alias-escape');
  expect(hits).toHaveLength(1);
  expect(hits[0].evidence).toContain('thing.ts');
});

test('rejects an alias the package "imports" map does not resolve', async () => {
  const dir = makeWorkspace({
    packages: { 'apps/app': '@x/app', 'packages/engine': '@x/engine' },
    files: { 'apps/app/src/main.ts': "import { thing } from '#/nope';\nexport default thing;\n" },
  });
  expect(withCode(await checkArchitecture(twoPackageModel(), dir), 'deps/unmapped-alias')).toHaveLength(1);
});

test('a real source file with no fingerprint is left to Check A, not Check B', async () => {
  // Guards the interaction the CI step depends on: a Rust module (no import
  // syntax) must not produce import diagnostics just because it has no deps.
  const dir = makeWorkspace({ packages: { 'apps/app': '@x/app' } });
  mkdirSync(join(dir, 'apps/app/src'), { recursive: true });
  writeFileSync(join(dir, 'apps/app/src/lib.rs'), 'pub fn go() {}\n');
  const model = {
    modules: [{ id: 'app', name: 'app', source: 'apps/app/src', layer: 'app', deps: [] }],
    rules: { layerOrder: ['app'], forbid: [], acyclic: true },
  };
  const diags = await checkArchitecture(model, dir);
  expect(diags.filter((d) => d.code.startsWith('deps/'))).toHaveLength(0);
});
