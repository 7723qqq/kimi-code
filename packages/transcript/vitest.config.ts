import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'transcript',
    include: ['test/**/*.test.ts'],
    // Under the Bun runtime, vitest trips over zod's CJS-getter exports unless zod is inlined.
    server: {
      deps: {
        inline: [/zod/],
      },
    },
  },
});
