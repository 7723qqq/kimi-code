---
"@moonshot-ai/kaos": patch
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kosong": patch
---

Fix two regressions the previous round introduced, both of which only showed up at boundaries.

**Backpressure wins again when a consumer is attached** (`kaos`, `agent-core-v2`). A `BufferedReadable` source that filled the buffer woke itself up every 10 ms to keep a `wait()`-then-read caller alive — and kept doing it while a consumer was already reading. An awaiting `for await` loop therefore lost its pacing and the whole child output was buffered in memory instead of streaming (a probe measured 65 KiB → 9.6 MiB in 1.5 s, unbounded for `tail -f`-style producers). The liveness timer is now armed only when nothing is reading (`_read()` has not run and no reader listener is attached), and it stops re-arming once 8 MiB is buffered — so the no-reader case degrades to backpressure rather than to unbounded memory. The original "await `wait()` before reading stdout" deadlock fix still holds up to that ceiling. Both copies of the class (`packages/kaos` and the engine's host-process copy) change together.

**Anthropic usage counts siblings, not parts** (`kosong`). The claim that Anthropic's `input_tokens` is a total and the cache fields are its parts is wrong: a real capture reads `{"input_tokens": 11, …, "cache_read_input_tokens": 1434}`. Subtracting the cache fields drove the fresh-input counter to 0 on every cache-hit turn, which skewed context budgets, cost display and cache-hit rates, and made the legacy kernel disagree with the engine's reader on the same payload. `inputOther` is now `input_tokens`, counted verbatim like every other field, read by one shared `extractAnthropicUsage`. A cross-engine parity test (`packages/kosong/test/cache-field-parity.test.ts`) drives the same payloads through both readers and asserts they match field-for-field, including the case where `inputOther + inputCacheRead` exceeds `input_tokens`.
