import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Named so `vitest run --project scripts` can target it from CI and from
    // a local reproduction of a CI failure.
    name: 'scripts',
    // Every gate script's test, at the root of scripts/ only. Deliberately not
    // scoped to `check-*.test.mjs`: `gen-brief.mjs` and `scan-hardcoded-v2.mjs`
    // are gates too, and a name prefix would silently drop a test added for
    // them later — the same "the test file exists but nothing runs it" gap that
    // kept check-architecture-drift's 5 cases out of CI in the first place.
    // Root-only (no `**/`) is what keeps scripts/prompt-optimizer/ out: that is
    // its own package with a different runtime and its own test setup.
    include: ['*.test.mjs'],
  },
});
