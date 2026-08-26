import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

const appRoot = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: resolve(appRoot, 'src') },
      // The vitest (node-condition) resolution picks solid-js's SSR build,
      // where signals are inert and onMount never runs — component tests
      // (rendering, key behaviour) need the browser build. Pin it explicitly;
      // the real Bun runtime already resolves the browser build via the
      // @opentui/solid preload plugin.
      {
        find: /^solid-js$/,
        replacement: resolve(appRoot, '../../node_modules/solid-js/dist/solid.js'),
      },
      {
        find: /^solid-js\/store$/,
        replacement: resolve(appRoot, '../../node_modules/solid-js/store/dist/store.js'),
      },
      // @opentui/solid imports the browser build by its dist path; alias it to
      // the same absolute file so every solid-js import shares one module
      // instance (a split instance breaks context propagation).
      {
        find: /^solid-js\/dist\/solid\.js$/,
        replacement: resolve(appRoot, '../../node_modules/solid-js/dist/solid.js'),
      },
      {
        find: /^solid-js\/store\/dist\/store\.js$/,
        replacement: resolve(appRoot, '../../node_modules/solid-js/store/dist/store.js'),
      },
    ],
  },
  test: {
    name: 'cli',
    env: {
      KIMI_LOG_LEVEL: 'off',
      KIMI_LANG: 'en',
    },
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Under the Bun runtime, vitest trips over zod's CJS-getter exports unless zod is inlined.
    // solid-js must also be inlined: externalized deps load through node's
    // ESM (bypassing resolve.alias), which would split solid-js into two
    // module instances and break context propagation in component tests.
    server: {
      deps: {
        inline: [/zod/, /solid-js/, /@opentui\/solid/],
      },
    },
  },
});
