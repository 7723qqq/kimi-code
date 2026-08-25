import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'agent-core-v2',
    include: ['test/**/*.{test,e2e,integration}.ts'],
    setupFiles: ['test/setup.ts'],
    // Under the Bun runtime, vitest trips over zod's CJS-getter exports unless zod is inlined.
    server: {
      deps: {
        inline: [/zod/],
      },
    },
  },
});
