---
'@moonshot-ai/kimi-code': patch
---

Port the v2 agent activity state machine to the native engine, completing the `agent.status.updated` contract: every server-side turn folds its lifecycle (turn boundaries, LLM step boundaries, streaming deltas, tool executions, retry backoffs, pending approvals/questions) into a per-session phase tracker that publishes `phase` events (`running`, `streaming`, `tool_call`, `retrying`, `awaiting_approval`, `interrupted`, `ended`) with the kap-server wire shape. Retry backoffs now emit the `TurnStepRetrying` telemetry event instead of only logging it, and phase events are series-deduplicated so delta floods stay off the wire.
