import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  copy: [
    {
      from: 'src/app/agentProfileCatalog/model-adaptations',
      to: 'dist',
    },
  ],
  plugins: [rawTextPlugin()],
  deps: {
    neverBundle: [
      '@moonshot-ai/kimi-code-oauth',
      '@moonshot-ai/kimi-telemetry',
    ],
  },
});
