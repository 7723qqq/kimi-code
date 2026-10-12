---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Cancelling a Gemini or Vertex turn now actually disconnects the request. The Google GenAI base raced the request's `AbortSignal` only against the *creation* of the response stream, never against the stream itself: the `for await` loop over the SDK iterator blocked on the provider's socket and noticed the cancellation only when the next chunk arrived. A turn interrupted during a silent thinking phase — or against a stalled server — therefore could not settle, and the connection kept streaming until the provider spoke or closed. The signal is now handed to the SDK as `config.abortSignal`, which is the one entry point `generateContentStream` offers, matching what the OpenAI and Anthropic bases already do. The pre-flight race and the per-chunk check are kept, so an already-aborted signal still fails before the call; the visible change is that cancellation now tears the request down instead of letting a cancelled request still produce output.
