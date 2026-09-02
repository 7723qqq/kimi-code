---
"@moonshot-ai/kimi-code": minor
"@moonshot-ai/agent-core-v2": minor
---

Cross-process status surface (G-5): `session/status` now carries an `engine` summary of the most recent completed turn — which LLM transport served it (`native-http` / `host-proxy` / `multi`), how many tool calls executed natively, the step count, and the stop reason — so kap-server / web clients can see the engine's execution path without in-process telemetry snapshots. Serialization is backward-compatible: the field is absent until the session has run a turn and skipped when empty.
