---
'@moonshot-ai/kimi-code': patch
---

Emit `event.session.work_changed` on every server-side turn start and end, so WebSocket clients finally see a session go busy/idle (with the mapped last_turn_reason and the pending approval/question kind), and publish `event.config.changed` after provider create/replace/delete/refresh — the config event contract is realigned to the kap-server wire name (`event.config.changed`, `changed_fields` payload) from the previously never-emitted `event.config.updated`.
