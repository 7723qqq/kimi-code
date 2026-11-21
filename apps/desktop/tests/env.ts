import { afterEach } from 'bun:test';

export function createTestEnv() {
  const original = new Map<string, string | undefined>();
  function restore(): void {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    original.clear();
  }
  afterEach(restore);
  return {
    set(name: string, value: string | undefined): void {
      if (!original.has(name)) original.set(name, process.env[name]);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    },
    restore,
  };
}
