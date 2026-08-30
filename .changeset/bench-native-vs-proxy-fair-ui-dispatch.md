---
"@moonshot-ai/kimi-code": patch
---

Make the real-key native-LLM vs host-proxy benchmark fair: both transports now share the same `dispatchEvent` helper (appends to the events list and yields two microtask hops, mirroring the `rust-loop.ts` event chain) and the host-proxy path streams the SSE response through `onTextPart` so it produces a per-delta `content.part` event chain identical to the native-LLM path. The P15 bench had `proxy.dispatchEvent` as a no-op and used a one-shot `res.text()` consumer that never called `onTextPart`, so it measured native's per-delta forwarding cost against zero proxy cost. The new numbers (MiniMax-M3, 5 runs each) put TTFT at native 572ms (med) vs host-proxy 675ms (-15%) and total at 1080ms vs 1071ms (~tied, native's TTFT advantage is offset by per-delta Rust emit), closing the "next" open question in the engine roadmap.
