import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkArchitecture } from './check-architecture-drift.mjs';

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

test('passes when the model is consistent', async () => {
  const diags = await checkArchitecture(baseModel, '/nonexistent-root');
  const depErrors = diags.filter((d) => d.code.startsWith('deps/'));
  assert.equal(depErrors.length, 0);
});

test('detects undeclared dependency target', async () => {
  const model = {
    ...baseModel,
    modules: [{ id: 'app', source: 'a', layer: 'app', deps: ['ghost'] }],
  };
  const diags = await checkArchitecture(model, '/nonexistent-root');
  assert.ok(diags.some((d) => d.code === 'deps/undeclared-target' && d.subject === 'app'));
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
  assert.ok(diags.some((d) => d.code === 'deps/layer-violation' && d.subject === 'engine'));
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
  assert.ok(diags.some((d) => d.code === 'deps/cycle' && d.subject === 'a'));
});

test('detects missing source directory', async () => {
  const diags = await checkArchitecture(baseModel, '/nonexistent-root');
  assert.ok(diags.some((d) => d.code === 'structure/missing-source' && d.subject === 'app'));
});

test('detects fingerprint drift', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'arch-drift-'));
  const src = join(dir, 'src');
  mkdirSync(src);
  writeFileSync(join(src, 'index.ts'), 'const x = 1;\n');
  // Compute the fingerprint the same way the checker does.
  const { createHash } = await import('node:crypto');
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
  assert.ok(diags.some((d) => d.code === 'drift/fingerprint' && d.subject === 'engine'));
});
