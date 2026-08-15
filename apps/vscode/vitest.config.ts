import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'webview-ui/src'),
      shared: resolve(import.meta.dirname, 'shared'),
    },
  },
  // The extension bundle replaces __EXTENSION_VERSION__ at build time
  // (see tsdown.config.ts); mirror it here so tests can import sources
  // that reference the global directly.
  define: {
    __EXTENSION_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
