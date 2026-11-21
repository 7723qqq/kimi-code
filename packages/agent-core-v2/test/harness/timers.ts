import { jest } from 'bun:test';

export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}
