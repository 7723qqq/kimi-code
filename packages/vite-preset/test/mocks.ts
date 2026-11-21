import type { Mock } from 'bun:test';

type Callable = (...args: never[]) => unknown;

function isMock<T extends Callable>(fn: T): fn is T & Mock<T> {
  return 'mock' in fn && 'mockReset' in fn && typeof fn.mockReset === 'function';
}

export function asMock<T extends Callable>(fn: T): Mock<T> {
  if (!isMock(fn)) throw new TypeError('Expected a Bun mock or spy');
  return fn;
}
