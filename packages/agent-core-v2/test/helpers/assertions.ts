import { expect } from 'bun:test';

export async function expectRejection(
  promise: Promise<unknown>,
  predicate: (error: unknown) => boolean,
): Promise<void> {
  const settled = await promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (reason: unknown) => reason,
  );
  expect(predicate(settled)).toBe(true);
}
