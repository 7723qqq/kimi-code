import type { jest } from 'bun:test';

export function mocked<T extends (...args: any[]) => any>(fn: T): jest.Mock<T> {
  return fn as unknown as jest.Mock<T>;
}
