---
"@moonshot-ai/kimi-code": minor
---

Keep a large skill collection out of the prompt: `[skills] hiddenFromModel` in `config.toml` hides skills from the model listing (they stay callable with `/skill:<name>`), and a SKILL.md that fails to parse now shows up as a skipped skill instead of only a log line.
