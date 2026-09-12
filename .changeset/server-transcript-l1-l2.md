---
'@moonshot-ai/kimi-code': minor
---

Serve the native engine's session transcript on the local server. The `/api/v1/sessions/{id}/transcript` route now returns the turn-granular L1 contract (`agent_id` / `items` / `has_more` / `tasks` / `interactions` / `agents` …) reconstructed from the persisted conversation instead of a naive two-message chunking, with `before_turn` / `after_turn` / `page_size` turn-cursor pagination. The missing `POST`-free siblings are implemented too: `/transcript/user-messages` (turn-opening prompts grouped per agent) and `/transcript/plan` (ExitPlanMode plan content parsed from the tool result, with the `404` tool-call-not-found contract). `/transcript/ops` answers the point-to-point catch-up envelope (`complete: false`, so clients fall back to a full refresh when there is no live op journal).
