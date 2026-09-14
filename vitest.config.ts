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
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/dist/**'],
      reporter: ['text', 'html'],
    },
  },
});
