---
"@moonshot-ai/agent-core-v2": patch
"@moonshot-ai/kimi-code": patch
---

Wire the `drainSteers` engine-input callback on the engine-override path. Steered prompts (mid-turn steering into an active turn) previously waited for the turn to end when the Rust engine drove the turn — the host steer queue had no drain method the engine could consume. `IAgentPromptService.drainSteered()` now returns the steered messages in arrival order, appends them to the context (mirroring the JS-path `SteerStepRequest` materialize semantics, so the message projection includes them), and dedupes across repeated drains while keeping the records alive for the turn-end settlement. Verified by engine-override tests: mid-turn drain returns the steered message and the context projection contains it, a second drain returns nothing, and the steered prompt's completion settles when the engine turn ends.
