import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  plugins: [rawTextPlugin()],
  resolve: {
    alias: [
      {
        find: /^@moonshot-ai\/agent-core\/(.+)$/,
        replacement: fileURLToPath(new URL('../agent-core/src/$1', import.meta.url)),
      },
      {
        find: '@moonshot-ai/agent-core',
        replacement: fileURLToPath(new URL('../agent-core/src/index.ts', import.meta.url)),
      },
      {
        find: '@moonshot-ai/kimi-code-oauth',
        replacement: fileURLToPath(new URL('../oauth/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    name: 'kimi-sdk',
    env: {
      KIMI_LOG_LEVEL: 'off',
    },
    include: ['test/**/*.test.ts'],
  },
});
