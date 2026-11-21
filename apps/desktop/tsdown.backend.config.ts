import { defineConfig } from 'tsdown';

import { rawTextPlugin } from './scripts/raw-text-plugin.mjs';

const entries = {
  backend: 'src/backend/launcher.ts',
  'search-worker': 'src/backend/search-worker.ts',
  'text-build-worker': 'src/backend/text-build-worker.ts',
};

export default defineConfig(
  Object.entries(entries).map(([name, entry]) => ({
    entry: { [name]: entry },
    format: ['esm'],
    platform: 'node',
    target: 'esnext',
    outDir: 'out-backend',
    clean: false,
    dts: false,
    fixedExtension: true,
    outputOptions: { codeSplitting: false },
    plugins: [rawTextPlugin()],
    deps: { alwaysBundle: [/./], neverBundle: ['canvas'], onlyBundle: false },
  })),
);
