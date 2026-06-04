import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig([
  {
    entry: ['./src/index.ts'],
    format: ['esm'],
    dts: false,
    outDir: 'dist',
    clean: true,
    plugins: [rawTextPlugin()],
    banner: {
      js: [
        "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
        "import { dirname as __cjsShimDirname } from 'node:path';",
        'const __filename = __cjsShimFileURLToPath(import.meta.url);',
        'const __dirname = __cjsShimDirname(__filename);',
      ].join('\n'),
    },
    deps: {
      alwaysBundle: [/^@moonshot-ai\//],
      neverBundle: [],
    },
  },
  {
    entry: ['./src/browser.ts'],
    format: ['esm'],
    dts: false,
    outDir: 'dist',
    clean: false,
    plugins: [rawTextPlugin()],
    treeshake: {
      moduleSideEffects: 'no-external',
    },
    deps: {
      alwaysBundle: [/^@moonshot-ai\/agent-core\/(?:errors\/(?:codes|classes)|telemetry)$/],
      neverBundle: [/^@moonshot-ai\/(?!agent-core\/(?:errors\/(?:codes|classes)|telemetry)$)/],
    },
  },
]);
