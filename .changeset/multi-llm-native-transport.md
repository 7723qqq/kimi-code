---
'@moonshot-ai/kimi-code': patch
---

Make the `[agent].multi_llm` configuration work: each provider in the race calls its provider directly and a losing racer is cancelled.
