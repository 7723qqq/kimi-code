import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: { server: 'src/index.ts' },
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin()],
  deps: {
    neverBundle: ['@moonshot-ai/kosong'],
    alwaysBundle: [/^@moonshot-ai\/agent-core-v2/],
  },
  // dts generation is slow by design; silence the rolldown plugin-timings diagnostic.
  checks: { pluginTimings: false },
});
