import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts', './src/cli.ts', './src/mcp.ts'],
  format: ['esm'],
  platform: 'node',
  dts: false,
  outDir: 'dist',
  clean: true,
  deps: {
    alwaysBundle: [/^@moonshot-ai\//],
    neverBundle: ['yaml'],
  },
});
