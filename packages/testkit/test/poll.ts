const POLL_INTERVAL_MS = 10;
const POLL_TIMEOUT_MS = 1_000;

export async function poll(assertion: () => void, timeoutMs = POLL_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failure: unknown;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw failure;
}
