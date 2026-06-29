/**
 * Vitest config for the agent-core-v2 examples — a separate project from the
 * unit-test suite so `pnpm dev:core-example <name>` runs only the scenario
 * examples (with their console output visible), never the real tests in
 * `test/`. The `#/` subpath-import resolver mirrors `vitest.config.ts`.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

function findPackageRoot(importer: string | undefined): string | undefined {
  if (!importer) return undefined;
  let dir = dirname(importer.split('?')[0] ?? importer);
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function hashImportsPlugin(): Plugin {
  return {
    name: 'resolve-hash-imports',
    enforce: 'pre',
    resolveId(id, importer) {
      if (!id.startsWith('#/')) return null;
      const pkgRoot = findPackageRoot(importer);
      if (!pkgRoot) return null;
      const sub = id.slice(2);
      for (const candidate of [`src/${sub}.ts`, `src/${sub}/index.ts`]) {
        const full = join(pkgRoot, candidate);
        if (existsSync(full)) return full;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [hashImportsPlugin()],
  test: {
    name: 'agent-core-v2-examples',
    include: ['examples/**/*.example.ts'],
    globalSetup: ['./examples/_globalSetup.ts'],
  },
});
