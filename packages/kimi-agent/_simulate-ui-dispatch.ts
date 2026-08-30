/**
 * Shared test helper: symmetric dispatchEvent for real-key benchmarks.
 *
 * The kimi-agent engine produces a per-delta event chain on the native-LLM
 * path (every content.part runs through the host's `eventChain` promise
 * chain in `rust-loop.ts`). For a fair native vs host-proxy comparison the
 * host-proxy path must also pay the same per-event forwarding cost. This
 * helper mirrors what the real event chain does on the host side: append
 * the event to the observer's list, then yield two microtask hops to
 * simulate the promise-chain `then` continuation.
 *
 * Both transports in the bench use this exact helper so the comparison is
 * not biased by an empty or no-op `dispatchEvent` on one side.
 */
export async function simulateUiDispatch(
  event: { type: string },
  events: Array<{ type: string; at: number }>,
): Promise<void> {
  events.push({ type: event.type, at: performance.now() });
  await Promise.resolve();
  await Promise.resolve();
}
