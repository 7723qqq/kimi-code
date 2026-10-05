import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const appRoot = import.meta.dirname;
const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

const alias = {
  '@': resolve(appRoot, 'webview-ui/src'),
  shared: resolve(appRoot, 'shared'),
};

export const vscodeProjects = [
  {
    root: appRoot,
    resolve: { alias },
    // The extension bundle replaces __EXTENSION_VERSION__ at build time
    // (see tsdown.config.ts); mirror it here so tests can import sources
    // that reference the global directly.
    define: {
      __EXTENSION_VERSION__: JSON.stringify(pkg.version),
    },
    test: {
      name: 'extension',
      include: ['test/**/*.test.ts'],
      exclude: ['test/webview/**'],
      environment: 'node',
      testTimeout: 15_000,
      // Under the Bun runtime, vitest trips over zod's CJS-getter exports unless zod is inlined.
      server: {
        deps: {
          inline: [/zod/],
        },
      },
    },
  },
  {
    root: appRoot,
    plugins: [react()],
    resolve: { alias },
    test: {
      name: 'webview',
      include: ['test/webview/**/*.test.{ts,tsx}'],
      environment: './test/webview/jsdom-environment.ts',
      setupFiles: ['./test/webview/setup.ts'],
      // Under the Bun runtime, vitest trips over zod's CJS-getter exports unless zod is inlined.
      server: {
        deps: {
          inline: [/zod/],
        },
      },
    },
  },
];
