---
'@moonshot-ai/kimi-code': patch
---

Make the `[agent].multi_llm` configuration work. The concurrent-provider race previously ran only over the host LLM proxy, which the entry points that read a config file answer with an error, so a configured race could never produce a winner while the option was advertised in the UI. Each racer now calls its provider directly and a losing racer is cancelled.
