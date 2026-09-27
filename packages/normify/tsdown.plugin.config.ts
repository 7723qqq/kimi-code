import { defineConfig } from 'tsdown';

// Builds the single-file, dependency-free MCP server shipped as the `normify`
// Kimi plugin (`plugins/official/normify/bin/normify-mcp.mjs`).
//
// The plugin directory is outside the workspace, so it is installed from a
// marketplace zip without any workspace package available at runtime. Hence
// every dependency (including `yaml`) is bundled inline here.
export default defineConfig({
  entry: { 'normify-mcp': './src/plugin-bin.ts' },
  format: ['esm'],
  platform: 'node',
  dts: false,
  outDir: '../../plugins/official/normify/bin',
  outExtensions: () => ({ js: '.mjs' }),
  clean: false,
  external: [/^node:/],
});
