import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

const appRoot = import.meta.dirname;

const alias = {
  '@': resolve(appRoot, 'webview-ui/src'),
  shared: resolve(appRoot, 'shared'),
};

const define = {
  __EXTENSION_VERSION__: JSON.stringify(pkg.version),
};

export const vscodeProjects = [
  {
    root: appRoot,
    define,
    resolve: { alias },
    test: {
      name: 'extension',
      include: ['test/**/*.test.ts'],
      exclude: ['test/webview/**'],
      environment: 'node',
      server: {
        deps: {
          inline: [/zod/],
        },
      },
    },
  },
  {
    root: appRoot,
    define,
    plugins: [react()],
    resolve: { alias },
    test: {
      name: 'webview',
      include: ['test/webview/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
      setupFiles: ['./test/webview/setup.ts'],
      server: {
        deps: {
          inline: [/zod/],
        },
      },
    },
  },
];
