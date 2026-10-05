import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'remote-control',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // Under the Bun runtime, vitest trips over zod's CJS-getter exports unless zod is inlined.
    server: {
      deps: {
        inline: [/zod/],
      },
    },
  },
});
