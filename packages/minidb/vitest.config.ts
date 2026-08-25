import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'minidb',
    include: ['test/**/*.test.ts'],
    // Package safety floor: process-spawning e2e's and multi-thousand-op
    // tests legitimately need >5s (the vitest default) on shared CI runners
    // under shard parallelism. Per-test explicit timeouts still win over this.
    testTimeout: 30_000,
    // Under the Bun runtime, vitest trips over zod's CJS-getter exports unless zod is inlined.
    server: {
      deps: {
        inline: [/zod/],
      },
    },
  },
});
