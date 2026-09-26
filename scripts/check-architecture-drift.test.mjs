import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('passes when the model is consistent', () => {
  const diags = checkArchitecture(baseModel, '/nonexistent-root');
  // Source dirs do not exist under the fake root, but that is a structure
  // check independent of dependency rules — the dependency checks pass.
  const depErrors = diags.filter((d) => d.code.startsWith('deps/'));
  assert.equal(depErrors.length, 0);
});

test('detects undeclared dependency target', () => {
  const model = {
    ...baseModel,
    modules: [{ id: 'app', source: 'a', layer: 'app', deps: ['ghost'] }],
  };
  const diags = checkArchitecture(model, '/nonexistent-root');
  assert.ok(diags.some((d) => d.code === 'deps/undeclared-target' && d.subject === 'app'));
});

test('detects layer-order violation', () => {
  const model = {
    ...baseModel,
    modules: [
      { id: 'app', source: 'a', layer: 'app', deps: [] },
      { id: 'engine', source: 'e', layer: 'engine', deps: ['app'] },
    ],
  };
  const diags = checkArchitecture(model, '/nonexistent-root');
  assert.ok(diags.some((d) => d.code === 'deps/layer-violation' && d.subject === 'engine'));
});

test('detects circular dependency', () => {
  const model = {
    ...baseModel,
    modules: [
      { id: 'a', source: 'a', layer: 'app', deps: ['b'] },
      { id: 'b', source: 'b', layer: 'sdk', deps: ['a'] },
    ],
  };
  const diags = checkArchitecture(model, '/nonexistent-root');
  assert.ok(diags.some((d) => d.code === 'deps/cycle' && d.subject === 'a'));
});

test('detects missing source directory', () => {
  const diags = checkArchitecture(baseModel, '/nonexistent-root');
  assert.ok(diags.some((d) => d.code === 'structure/missing-source' && d.subject === 'app'));
});
