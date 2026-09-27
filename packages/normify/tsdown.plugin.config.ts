import { defineConfig } from 'tsdown';

// Builds the single-file, dependency-free MCP server shipped as the `normify`
// Kimi plugin (`plugins/official/normify/bin/normify-mcp.mjs`).
//
// The plugin directory is outside the workspace, so it is installed from a
// marketplace zip without any workspace package available at runtime. Hence
// every dependency (including `yaml`) is bundled inline here. tsdown keeps
// package.json `dependencies` external by default — `yaml` is one, so it must
// be forced into `deps.alwaysBundle` or the emitted chunk keeps a bare
// `import ... from "yaml"` that only resolves on machines with yaml installed.
export default defineConfig({
  entry: { 'normify-mcp': './src/plugin-bin.ts' },
  format: ['esm'],
  platform: 'node',
  dts: false,
  outDir: '../../plugins/official/normify/bin',
  outExtensions: () => ({ js: '.mjs' }),
  clean: false,
  deps: {
    alwaysBundle: ['yaml'],
  },
});
