---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/kimi-code-sdk": minor
---

Rewrite the drafted prompt with the current model: press `Ctrl+P` in the input box and the agent proposes a clearer, more actionable version of what you were about to send, shown against your original in a diff panel. Accepting replaces the input; discarding keeps it untouched. The rewrite sees the working directory and your recent prompts, and the throwaway agent it runs on has every tool denied, so it can only return text.

The capability is behind the `prompt_optimizer` experimental flag (off by default), toggled in `/settings` → Experiments or `/experiments` and also settable through `KIMI_CODE_EXPERIMENTAL_PROMPT_OPTIMIZER`; the toggle takes effect after a restart. It is reachable outside the TUI too: as `session.optimizePrompt(text, { recentTurns })` in the SDK, and as the `optimize-prompt` session action over REST.
