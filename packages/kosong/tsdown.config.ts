import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    './src/index.ts',
    './src/providers/anthropic-profile.ts',
    './src/providers/astron-models.ts',
  ],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
});
