import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/web.ts', 'src/types.ts', 'src/detect.ts', 'src/core.ts'],
  format: 'esm',
  dts: true,
  clean: true,
});
