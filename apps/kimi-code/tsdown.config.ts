import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';
import { BUILT_IN_CATALOG_DEFINE, builtInCatalogDefine } from './scripts/built-in-catalog.mjs';

const appRoot = import.meta.dirname;

export default defineConfig({
  entry: ['./src/main.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  dts: false,
  hash: false,
  banner: {
    js: [
      '#!/usr/bin/env bun',
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\n'),
  },
  plugins: [rawTextPlugin()],
  copy: [
    {
      from: resolve(
        appRoot,
        '../../packages/agent-core-v2/src/app/agentProfileCatalog/model-adaptations',
      ),
      to: resolve(appRoot, 'dist/chunks'),
    },
  ],
  alias: {
    '@': resolve(appRoot, 'src'),
    '#/i18n': resolve(appRoot, 'src', 'i18n', 'index.ts'),
  },
  define: {
    [BUILT_IN_CATALOG_DEFINE]: builtInCatalogDefine(),
  },
  deps: {
    onlyBundle: false,
  },
  outputOptions: {
    entryFileNames: 'main.mjs',
    chunkFileNames: 'chunks/[name]-[hash].mjs',
    advancedChunks: {
      groups: [
        {
          // Modules the CLI entry layer (main.ts → createProgram) imports
          // statically must not share a chunk with the engine stack: any
          // co-located module evaluates at startup. Pin the entry layer's
          // cross-package dependencies into one small chunk so `--version`
          // and friends never evaluate the engine, zod, or provider SDKs.
          name: 'entry-shared',
          priority: 100,
          test: /node_modules[\\/]pathe[\\/]|agent-core-v2[\\/]src[\\/]app[\\/]bootstrap[\\/]home\.ts|agent-core-v2[\\/]src[\\/]app[\\/]plugin[\\/]nodeFallback\.ts|agent-core-v2[\\/]src[\\/]_base[\\/]utils[\\/]proxyEnv\.ts|node-sdk[\\/]src[\\/](?:runtime|catalog-defaults|proxy|errors-codes)\.ts|node-sdk[\\/]src[\\/]logging[\\/]|node-sdk[\\/]src[\\/]utils[\\/]fs\.ts|node-sdk[\\/]src[\\/]v2[\\/]config-mapper\.ts|oauth[\\/]src[\\/](?:open-platform-defs|identity)\.ts/,
        },
        {
          // Keep zod in a single chunk: the default grouping splits zod core
          // from its string-format subclasses across chunks, and the circular
          // references between them hit a TDZ error at evaluation time.
          name: 'zod',
          priority: 90,
          test: /node_modules[\\/]zod[\\/]/,
        },
      ],
    },
  },
});
