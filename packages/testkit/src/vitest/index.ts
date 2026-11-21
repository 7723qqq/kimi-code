/**
 * `@moonshot-ai/testkit/vitest` — same public surface as 2.7.0's
 * `packages/testkit/src/vitest/index.ts`, backed by `bun:test`:
 *
 *  - fixture helpers (`modelFixtures`, `homeFixtures`, `kapFixtures`,
 *    `useNetworkGuard`, `describeModel`, …) live in `../bun/index.ts`,
 *    which is the bun-flavoured port of the same module;
 *  - the vitest test API (`expect`, `it`, `describe`, `vi`, …) is adapted to
 *    `bun:test` in `./api.ts`.
 */
export * from '../bun/index.js';
export * from './api.js';
