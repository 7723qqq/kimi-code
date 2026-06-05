import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

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
      '@moonshot-ai/kimi-code-oauth': fileURLToPath(
        new URL('../oauth/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'services',
    include: ['test/**/*.{test,e2e}.ts'],
  },
});
