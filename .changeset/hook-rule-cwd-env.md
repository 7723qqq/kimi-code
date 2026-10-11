---
"@moonshot-ai/kimi-code": patch
---

Support `cwd` and `env` in a `[[hooks]]` rule. The runner already honoured both — including the per-rule working directory and the merged environment — but the configuration schema rejected them as unrecognized keys, so the whole `hooks` array was dropped with a single warning. They are documented in the hooks reference now.
