import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'napi-integration.test.ts',
      'rust-loop.test.ts',
      'real-key-e2e.test.ts',
      'bench-native-vs-proxy.test.ts',
      'bench-tool-path.test.ts',
      'multi-llm-real-key.test.ts',
      'long-session-memory.test.ts',
    ],
    // Under the Bun runtime, vitest trips over zod's CJS-getter exports unless zod is inlined.
    server: {
      deps: {
        inline: [/zod/],
      },
    },
  },
});
