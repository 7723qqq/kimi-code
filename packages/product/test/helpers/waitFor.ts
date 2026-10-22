const realSetTimeout = setTimeout;

export interface PollOptions {
  readonly timeout?: number;
  readonly interval?: number;
}

export async function waitForAssertion(
  probe: () => unknown,
  options: PollOptions = {},
): Promise<void> {
  const timeout = options.timeout ?? 1_000;
  const interval = options.interval ?? 10;
  const deadline = performance.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      probe();
      return;
    } catch (error) {
      lastError = error;
    }
    if (performance.now() >= deadline) {
      if (lastError instanceof Error) throw lastError;
      throw new Error(`waitForAssertion timed out after ${timeout}ms`);
    }
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, interval);
    });
  }
}
