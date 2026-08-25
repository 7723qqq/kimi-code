import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'vis-web',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Under the Bun runtime, vitest trips over zod's CJS-getter exports unless zod is inlined.
    server: {
      deps: {
        inline: [/zod/],
      },
    },
  },
});
