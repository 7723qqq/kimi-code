import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { server: 'src/index.ts' },
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  deps: { neverBundle: ['@moonshot-ai/kosong'] },
  // dts generation is slow by design; silence the rolldown plugin-timings diagnostic.
  checks: { pluginTimings: false },
});
