---
"@moonshot-ai/kimi-native-tools": patch
---

Declare `engines: bun >= 1.4.0`, matching `@moonshot-ai/kimi-code`. The N-API addon is only ever loaded by the Bun-based CLI. npm ignores the non-standard `bun` key, so installation behaviour is unchanged.
