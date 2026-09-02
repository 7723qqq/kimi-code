---
"@moonshot-ai/kimi-native-tools": patch
---

Share one process-wide tokio runtime for native LLM streaming: `native_llm_stream_streaming` no longer spawns a dedicated thread with a fresh current-thread runtime per stream; it now uses a lazily initialized shared multi-thread runtime (`OnceCell`, 2 worker threads, thread name `kimi-llm-stream`, initialization failures are not cached so they stay retryable). Tokio's `rt-multi-thread` feature is enabled (no new dependencies; `Cargo.lock` and `flake.nix` are unchanged, since enabling a feature does not write to the lockfile). Cancellation, backpressure, and error-propagation semantics are preserved line-for-line. Verified: cargo test --lib 546, clippy/fmt, napi build, test:js 30 all green.
