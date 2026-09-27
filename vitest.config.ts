import { defineConfig } from 'vitest/config';
import { vscodeProjects } from './apps/vscode/vitest.projects';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/kimi-code',
      'apps/kimi-inspect',
      'apps/vis/server',
      'apps/vis/web',
      ...vscodeProjects,
      // The fail-closed gate scripts under scripts/ carry their own vitest
      // project; without it `bun run test` never collects their *.test.mjs and
      // the gates' own tests are dead code.
      'scripts',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/dist/**'],
      reporter: ['text', 'html'],
    },
  },
});
