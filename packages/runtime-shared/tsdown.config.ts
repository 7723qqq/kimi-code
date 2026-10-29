import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/guards.ts', 'src/errors.ts', 'src/fetch.ts'],
  format: 'esm',
  dts: true,
  clean: true,
});
