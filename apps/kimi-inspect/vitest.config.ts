import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests co-locate with the source they cover (`src/**`), plus the
    // cross-cutting locale checks under `test/` and the Vite plugin's own
    // suite under `vite/` (upstream collects it; the 0.40.0 merge dropped it).
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.ts', 'vite/**/*.test.ts'],
    // Under the Bun runtime, vitest trips over zod's CJS-getter exports unless zod is inlined.
    server: {
      deps: {
        inline: [/zod/],
      },
    },
  },
});
