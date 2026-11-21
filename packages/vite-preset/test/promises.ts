export function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => { throw new Error('Expected the promise to reject'); },
    (error: unknown) => error,
  );
}
