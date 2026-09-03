import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import { vscodeProjects } from './vitest.projects';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

export default defineConfig({
  define: {
    __EXTENSION_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    projects: vscodeProjects,
    server: {
      deps: {
        inline: [/zod/],
      },
    },
  },
});