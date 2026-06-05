import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

// `rawTextPlugin` is needed even for daemon-only tests because W4.4 wires
// HarnessBridge → KimiCore, which drags in agent-core's `tools/builtin/*` tree
// that imports 20+ raw `.md` description files. Without the plugin those
// imports fail with "Failed to resolve import".
//
// Workspace `resolve.alias` mirrors `packages/services/vitest.config.ts:11` so
// tests run against src/index.ts (not built dist/) — keeps the feedback loop
// tight when adjacent packages change.
export default defineConfig({
  plugins: [rawTextPlugin()],
  resolve: {
    alias: {
      '@moonshot-ai/kimi-code-sdk': fileURLToPath(
        new URL('../node-sdk/src/index.ts', import.meta.url),
      ),
      '@moonshot-ai/agent-core': fileURLToPath(
        new URL('../agent-core/src/index.ts', import.meta.url),
      ),
      '@moonshot-ai/protocol': fileURLToPath(
        new URL('../protocol/src/index.ts', import.meta.url),
      ),
      '@moonshot-ai/services': fileURLToPath(
        new URL('../services/src/index.ts', import.meta.url),
      ),
      '@moonshot-ai/kimi-code-oauth': fileURLToPath(
        new URL('../oauth/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'daemon',
    include: ['test/**/*.{test,e2e}.ts'],
  },
});
