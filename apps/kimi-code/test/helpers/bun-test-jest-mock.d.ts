declare module 'bun:test' {
  namespace jest {
    type ImportOriginalFn = <T = Record<string, unknown>>() => Promise<T>;
    function mock(id: string, factory: (importOriginal: ImportOriginalFn) => unknown): void;
    function importActual<T = Record<string, unknown>>(id: string): Promise<T>;
  }
}
