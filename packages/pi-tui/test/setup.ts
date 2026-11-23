import { afterEach, jest, mock } from 'bun:test';

afterEach(() => {
  mock.restore();
  jest.useRealTimers();
});
