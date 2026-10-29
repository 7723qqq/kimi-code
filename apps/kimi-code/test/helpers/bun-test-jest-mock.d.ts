declare module 'bun:test' {
  namespace jest {
    /**
     * Bun implements `jest.mock(id, factory)` at runtime but omits it from
     * `bun-types`. The factory takes **no** `importOriginal` argument — that
     * helper is vitest-only. To spread a real module, import its namespace at
     * the top of the test (or `createRequire(...)` it for a CJS package) and
     * spread that inside the factory.
     */
    function mock(id: string, factory: () => unknown): void;
  }
}
