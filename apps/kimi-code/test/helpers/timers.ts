import { jest } from 'bun:test';

export async function runAllTimersAsync(): Promise<void> {
  for (let pass = 0; pass < 100; pass += 1) {
    jest.runAllTimers();
    await Promise.resolve();
    if (jest.getTimerCount() === 0) {
      await Promise.resolve();
      if (jest.getTimerCount() === 0) return;
    }
  }
}

export async function runOnlyPendingTimersAsync(): Promise<void> {
  jest.runOnlyPendingTimers();
  await Promise.resolve();
  await Promise.resolve();
}
