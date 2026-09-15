import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests co-locate with the source they cover (`src/**`), plus the
    // cross-cutting locale checks under `test/`.
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.ts'],
    // Under the Bun runtime, vitest trips over zod's CJS-getter exports unless zod is inlined.
    server: {
      deps: {
        inline: [/zod/],
      },
    },
  },
});
