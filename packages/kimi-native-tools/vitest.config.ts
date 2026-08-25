import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**'],
    // Under the Bun runtime, vitest trips over zod's CJS-getter exports unless zod is inlined.
    server: {
      deps: {
        inline: [/zod/],
      },
    },
  },
});
