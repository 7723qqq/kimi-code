import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

import {
  BUILT_IN_CATALOG_DEFINE,
  builtInCatalogDefine,
} from '../../apps/kimi-code/scripts/built-in-catalog.mjs';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin()],
  define: {
    [BUILT_IN_CATALOG_DEFINE]: builtInCatalogDefine(),
  },
});
