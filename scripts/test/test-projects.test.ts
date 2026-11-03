import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { listTestProjects } from '../lib/test-projects.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

function writeManifest(root: string, path: string, manifest: object): void {
  const target = join(root, path, 'package.json');
  mkdirSync(join(root, path), { recursive: true });
  writeFileSync(target, JSON.stringify(manifest));
}

describe('test project discovery', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'test-projects-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('derives workspace suites and the repository scripts suite from the root manifest', () => {
    writeManifest(root, '.', {
      workspaces: { packages: ['packages/*', 'tools/demo'] },
      scripts: { 'test:scripts': 'bun scripts/run-package-tests.mjs' },
    });
    writeManifest(root, 'packages/a', { name: 'a', scripts: { test: 'bun test' } });
    writeManifest(root, 'packages/b', { name: 'b', scripts: { build: 'tsc' } });
    writeManifest(root, 'tools/demo', { name: 'demo', scripts: { test: 'bun test' } });

    const projects = listTestProjects(root, 'test');

    expect(projects.map((project) => project.path).toSorted()).toEqual([
      'packages/a',
      'scripts',
      'tools/demo',
    ]);
    expect(projects.find((project) => project.path === 'scripts')).toMatchObject({
      dir: root,
      script: 'test:scripts',
    });
    expect(listTestProjects(root, 'test:bench').map((project) => project.path)).not.toContain(
      'scripts',
    );
  });

  it('discovers the repository scripts suite through the production root manifest', () => {
    const projects = listTestProjects(REPO_ROOT, 'test');

    expect(projects.find((project) => project.path === 'scripts')).toMatchObject({
      dir: REPO_ROOT,
      script: 'test:scripts',
    });
  });
});
