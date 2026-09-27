#!/usr/bin/env node
// Entry point bundled into the `normify` Kimi plugin
// (`plugins/official/normify/bin/normify-mcp.mjs`).
//
// Kept dependency-free by the bundler (tsdown.plugin.config.ts): `yaml` is
// inlined so the plugin works from a marketplace install where no workspace
// node_modules is present.

import { createToolRegistry } from './tools.js';
import { createMcpServer } from './mcp.js';

const VERSION = '0.5.4';

createMcpServer({
  name: 'normify',
  version: VERSION,
  tools: createToolRegistry({ rootDir: process.cwd() }),
}).listen();
